import { DatabaseSync, StatementSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AssetQuery, EventInput, JournalStore, LockHandle, LockInfo, TransitionOptions,
} from '../core/interfaces';
import type {
  AssetRecord, AssetState, CacheOpStatus, Counters, EventRecord, OrphanRecord, RefLocation, RefRecord, RefStatus, RunRecord, VariantRecord,
} from '../domain/types';
import { assertRefTransition, assertTransition } from '../domain/stateMachine';
import { MediaMigrateError } from '../domain/errors';

export const JOURNAL_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(
  run_id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, config_fp TEXT NOT NULL, dry_run INTEGER NOT NULL,
  pid INTEGER, host TEXT, started_at TEXT NOT NULL, finished_at TEXT, last_heartbeat_at TEXT,
  stop_requested INTEGER NOT NULL DEFAULT 0, blocking_error TEXT, params TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS assets(
  asset_id TEXT PRIMARY KEY, source_provider TEXT NOT NULL, source_bucket TEXT NOT NULL, source_key TEXT NOT NULL, source_url TEXT,
  source_sha256 TEXT, source_bytes INTEGER, source_mime TEXT, source_width INTEGER, source_height INTEGER,
  media_type TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, skip_reason TEXT, run_id TEXT,
  cache_status TEXT NOT NULL DEFAULT 'PENDING', cdn_verified INTEGER NOT NULL DEFAULT 0, processing_version TEXT,
  claimed_by TEXT, lease_until INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS assets_state ON assets(state);
CREATE INDEX IF NOT EXISTS assets_sha ON assets(source_sha256);
CREATE TABLE IF NOT EXISTS variants(
  asset_id TEXT NOT NULL, profile TEXT NOT NULL, width INTEGER NOT NULL, effective_width INTEGER NOT NULL, height INTEGER NOT NULL,
  format TEXT NOT NULL, key TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
  processing_version TEXT NOT NULL, PRIMARY KEY(asset_id, profile));
CREATE TABLE IF NOT EXISTS refs(
  collection TEXT NOT NULL, doc_id TEXT NOT NULL, path TEXT NOT NULL, asset_id TEXT NOT NULL, original_value TEXT NOT NULL,
  new_value TEXT, status TEXT NOT NULL, run_id TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(collection, doc_id, path));
CREATE INDEX IF NOT EXISTS refs_asset ON refs(asset_id);
CREATE INDEX IF NOT EXISTS refs_status ON refs(status);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, run_id TEXT, asset_id TEXT, level TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
CREATE TABLE IF NOT EXISTS orphans(key TEXT PRIMARY KEY, bytes INTEGER NOT NULL, reason TEXT NOT NULL, run_id TEXT, discovered_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cache_ops(
  id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT NOT NULL, run_id TEXT NOT NULL, url TEXT NOT NULL, action TEXT NOT NULL,
  status TEXT NOT NULL, detail TEXT, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, name TEXT NOT NULL, ts TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS checkpoints_run ON checkpoints(run_id, name, id);
CREATE TABLE IF NOT EXISTS counters(
  run_id TEXT PRIMARY KEY, bytes_read INTEGER NOT NULL DEFAULT 0, bytes_written INTEGER NOT NULL DEFAULT 0,
  db_updates INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0, purges_requested INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS timings(run_id TEXT NOT NULL, phase TEXT NOT NULL, count INTEGER NOT NULL, total_ms REAL NOT NULL, max_ms REAL NOT NULL, PRIMARY KEY(run_id, phase));
CREATE TABLE IF NOT EXISTS lock(id INTEGER PRIMARY KEY CHECK(id=1), run_id TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, token TEXT NOT NULL, acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL);
`;

type Row = Record<string, any>;

export interface JournalOptions {
  /** Injectable clock for deterministic tests. */
  clock?: () => Date;
}

/**
 * Durable journal + manifest + checkpoint store backed by SQLite (WAL, synchronous=FULL).
 * All state transitions are single transactions that also append an audit event.
 * Safe for multiple processes/connections on one file (BEGIN IMMEDIATE + busy_timeout).
 */
export class SqliteJournal implements JournalStore {
  private db!: DatabaseSync;
  private inTx = false;
  private readonly clock: () => Date;
  private stmtCache = new Map<string, StatementSync>();

  constructor(readonly file: string, opts: JournalOptions = {}) {
    this.clock = opts.clock ?? (() => new Date());
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.db = new DatabaseSync(file);
      this.db.exec('PRAGMA busy_timeout=15000;');
      if (file !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL;');
      this.db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.db.exec(SCHEMA);
      const ver = this.get('SELECT v FROM meta WHERE k=?', 'schema_version');
      if (!ver) this.run('INSERT INTO meta(k,v) VALUES(?,?)', 'schema_version', String(JOURNAL_SCHEMA_VERSION));
      else if (Number(ver.v) > JOURNAL_SCHEMA_VERSION) {
        throw new MediaMigrateError('validation', 'JOURNAL_TOO_NEW', `journal schema ${ver.v} is newer than this tool (${JOURNAL_SCHEMA_VERSION})`);
      }
    } catch (err) {
      try { this.db?.close(); } catch { /* ignore */ }
      if (err instanceof MediaMigrateError) throw err;
      throw new MediaMigrateError('permanent', 'JOURNAL_UNREADABLE', `journal at ${file} is unreadable or corrupt: ${(err as Error).message}`, undefined, { cause: err });
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }
  private run(sql: string, ...p: any[]) {
    return this.stmt(sql).run(...p);
  }
  private get(sql: string, ...p: any[]): Row | undefined {
    return this.stmt(sql).get(...p) as Row | undefined;
  }
  private all(sql: string, ...p: any[]): Row[] {
    return this.stmt(sql).all(...p) as Row[];
  }

  /** Run `fn` inside BEGIN IMMEDIATE ... COMMIT (re-entrant). */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  close(): void {
    this.stmtCache.clear();
    try {
      this.db.close();
    } catch {
      /* closed */
    }
  }

  /** Consistent snapshot copy (used for journal backups). */
  backupTo(dest: string): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest);
    this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  }

  // ───────── runs ─────────

  private toRun(r: Row): RunRecord {
    return {
      runId: r.run_id, kind: r.kind, status: r.status, configFingerprint: r.config_fp, dryRun: !!r.dry_run, pid: r.pid, host: r.host,
      startedAt: r.started_at, finishedAt: r.finished_at, lastHeartbeatAt: r.last_heartbeat_at, stopRequested: !!r.stop_requested,
      blockingError: r.blocking_error, params: JSON.parse(r.params),
    };
  }
  createRun(run: RunRecord): void {
    this.tx(() => {
      this.run(
        'INSERT INTO runs(run_id,kind,status,config_fp,dry_run,pid,host,started_at,finished_at,last_heartbeat_at,stop_requested,blocking_error,params) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        run.runId, run.kind, run.status, run.configFingerprint, run.dryRun ? 1 : 0, run.pid, run.host, run.startedAt, run.finishedAt,
        run.lastHeartbeatAt, run.stopRequested ? 1 : 0, run.blockingError, JSON.stringify(run.params),
      );
      this.run('INSERT OR IGNORE INTO counters(run_id) VALUES(?)', run.runId);
      this.appendEvent({ runId: run.runId, assetId: null, level: 'info', type: 'run.created', detail: { kind: run.kind, dryRun: run.dryRun } });
    });
  }
  getRun(runId: string): RunRecord | null {
    const r = this.get('SELECT * FROM runs WHERE run_id=?', runId);
    return r ? this.toRun(r) : null;
  }
  listRuns(limit = 50): RunRecord[] {
    return this.all('SELECT * FROM runs ORDER BY started_at DESC, run_id DESC LIMIT ?', limit).map((r) => this.toRun(r));
  }
  updateRun(runId: string, patch: Partial<Omit<RunRecord, 'runId'>>): void {
    const map: Record<string, string> = {
      kind: 'kind', status: 'status', configFingerprint: 'config_fp', pid: 'pid', host: 'host', finishedAt: 'finished_at',
      lastHeartbeatAt: 'last_heartbeat_at', blockingError: 'blocking_error',
    };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'params') { sets.push('params=?'); vals.push(JSON.stringify(v)); }
      else if (k === 'dryRun') { sets.push('dry_run=?'); vals.push(v ? 1 : 0); }
      else if (k === 'stopRequested') { sets.push('stop_requested=?'); vals.push(v ? 1 : 0); }
      else if (map[k]) { sets.push(`${map[k]}=?`); vals.push(v ?? null); }
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE runs SET ${sets.join(',')} WHERE run_id=?`).run(...vals, runId);
  }
  requestStop(runId: string): void {
    this.run('UPDATE runs SET stop_requested=1 WHERE run_id=?', runId);
    this.appendEvent({ runId, assetId: null, level: 'warn', type: 'run.stop-requested', detail: {} });
  }

  // ───────── events / counters / timings ─────────

  appendEvent(e: EventInput): number {
    const r = this.run(
      'INSERT INTO events(ts,run_id,asset_id,level,type,detail) VALUES(?,?,?,?,?,?)',
      e.ts ?? this.now(), e.runId, e.assetId, e.level, e.type, JSON.stringify(e.detail ?? {}),
    );
    return Number(r.lastInsertRowid);
  }
  events(runId: string | null, opts: { limit?: number; level?: EventRecord['level']; afterId?: number; assetId?: string } = {}): EventRecord[] {
    const where: string[] = [];
    const p: any[] = [];
    if (runId) { where.push('run_id=?'); p.push(runId); }
    if (opts.level) { where.push('level=?'); p.push(opts.level); }
    if (opts.afterId) { where.push('id>?'); p.push(opts.afterId); }
    if (opts.assetId) { where.push('asset_id=?'); p.push(opts.assetId); }
    const limit = opts.limit ?? 200;
    // newest `limit` rows, returned in chronological order
    const rows = this.db
      .prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
      .all(...p, limit) as Row[];
    return rows.reverse().map((r) => ({ id: r.id, ts: r.ts, runId: r.run_id, assetId: r.asset_id, level: r.level, type: r.type, detail: JSON.parse(r.detail) }));
  }
  addCounters(runId: string, d: Partial<Counters>): void {
    this.run('INSERT OR IGNORE INTO counters(run_id) VALUES(?)', runId);
    this.run(
      'UPDATE counters SET bytes_read=bytes_read+?, bytes_written=bytes_written+?, db_updates=db_updates+?, retries=retries+?, purges_requested=purges_requested+? WHERE run_id=?',
      d.bytesRead ?? 0, d.bytesWritten ?? 0, d.dbUpdates ?? 0, d.retries ?? 0, d.purgesRequested ?? 0, runId,
    );
  }
  counters(runId: string): Counters {
    const r = this.get('SELECT * FROM counters WHERE run_id=?', runId);
    return r
      ? { bytesRead: r.bytes_read, bytesWritten: r.bytes_written, dbUpdates: r.db_updates, retries: r.retries, purgesRequested: r.purges_requested }
      : { bytesRead: 0, bytesWritten: 0, dbUpdates: 0, retries: 0, purgesRequested: 0 };
  }
  recordTiming(runId: string, phase: string, ms: number): void {
    this.run(
      'INSERT INTO timings(run_id,phase,count,total_ms,max_ms) VALUES(?,?,1,?,?) ON CONFLICT(run_id,phase) DO UPDATE SET count=count+1,total_ms=total_ms+excluded.total_ms,max_ms=MAX(max_ms,excluded.max_ms)',
      runId, phase, ms, ms,
    );
  }
  timings(runId: string): Record<string, { count: number; totalMs: number; maxMs: number }> {
    const out: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
    for (const r of this.all('SELECT * FROM timings WHERE run_id=?', runId)) out[r.phase] = { count: r.count, totalMs: r.total_ms, maxMs: r.max_ms };
    return out;
  }

  // ───────── lock ─────────

  acquireLock(runId: string, o: { staleAfterMs: number; pid: number; host: string; isPidAlive: (pid: number) => boolean }): LockHandle {
    return this.tx(() => {
      const cur = this.get('SELECT * FROM lock WHERE id=1');
      const nowMs = this.clock().getTime();
      if (cur) {
        const hbAge = nowMs - Date.parse(cur.heartbeat_at);
        const dead = cur.host === o.host && !o.isPidAlive(cur.pid);
        const expired = hbAge > o.staleAfterMs;
        if (!dead && !expired) {
          throw new MediaMigrateError('locked', 'LOCKED', `journal is locked by run ${cur.run_id} (pid ${cur.pid} on ${cur.host}, heartbeat ${Math.round(hbAge / 1000)}s ago)`, {
            holder: cur.run_id, pid: cur.pid,
          });
        }
        // takeover: the previous holder is provably dead or silent; its run can no longer be considered running
        this.run("UPDATE runs SET status='INTERRUPTED', finished_at=?, blocking_error=? WHERE run_id=? AND status='RUNNING'", this.now(), `lock taken over (${dead ? 'process dead' : 'heartbeat expired'})`, cur.run_id);
        this.appendEvent({ runId: cur.run_id, assetId: null, level: 'warn', type: 'lock.takeover', detail: { by: runId, reason: dead ? 'dead-pid' : 'expired-heartbeat', pid: cur.pid } });
        this.run('DELETE FROM lock WHERE id=1');
      }
      const token = randomBytes(12).toString('hex');
      this.run('INSERT INTO lock(id,run_id,pid,host,token,acquired_at,heartbeat_at) VALUES(1,?,?,?,?,?,?)', runId, o.pid, o.host, token, this.now(), this.now());
      this.appendEvent({ runId, assetId: null, level: 'info', type: 'lock.acquired', detail: { pid: o.pid } });
      return { token, runId };
    });
  }
  refreshLock(h: LockHandle): void {
    const r = this.run('UPDATE lock SET heartbeat_at=? WHERE id=1 AND token=?', this.now(), h.token);
    if (Number(r.changes) === 0) throw new MediaMigrateError('locked', 'LOCK_LOST', 'lost the migration lock (taken over by another process)');
    this.run('UPDATE runs SET last_heartbeat_at=? WHERE run_id=?', this.now(), h.runId);
  }
  releaseLock(h: LockHandle): void {
    this.tx(() => {
      const r = this.run('DELETE FROM lock WHERE id=1 AND token=?', h.token);
      if (Number(r.changes) > 0) this.appendEvent({ runId: h.runId, assetId: null, level: 'info', type: 'lock.released', detail: {} });
    });
  }
  inspectLock(): LockInfo | null {
    const r = this.get('SELECT * FROM lock WHERE id=1');
    return r ? { runId: r.run_id, pid: r.pid, host: r.host, token: r.token, acquiredAt: r.acquired_at, heartbeatAt: r.heartbeat_at } : null;
  }

  integrityCheck(): { ok: boolean; messages: string[] } {
    const messages: string[] = [];
    const ic = this.all('PRAGMA integrity_check');
    for (const r of ic) if (Object.values(r)[0] !== 'ok') messages.push(String(Object.values(r)[0]));
    // I1: references may only be UPDATING/UPDATED when the asset's variants are all verified.
    const bad = this.all(
      `SELECT r.asset_id AS a, COUNT(*) AS n FROM refs r WHERE r.status IN ('UPDATING','UPDATED')
         AND (NOT EXISTS (SELECT 1 FROM variants v WHERE v.asset_id=r.asset_id)
              OR EXISTS (SELECT 1 FROM variants v WHERE v.asset_id=r.asset_id AND v.verified=0)) GROUP BY r.asset_id`,
    );
    for (const b of bad) messages.push(`I1 violation: asset ${b.a} has ${b.n} reference(s) updated without verified variants`);
    return { ok: messages.length === 0, messages };
  }

  // ───────── assets ─────────

  private toAsset(r: Row): AssetRecord {
    return {
      assetId: r.asset_id, sourceProvider: r.source_provider, sourceBucket: r.source_bucket, sourceKey: r.source_key, sourceUrl: r.source_url,
      sourceSha256: r.source_sha256, sourceBytes: r.source_bytes, sourceMime: r.source_mime, sourceWidth: r.source_width, sourceHeight: r.source_height,
      mediaType: r.media_type, state: r.state, attempts: r.attempts, lastError: r.last_error, skipReason: r.skip_reason, runId: r.run_id,
      cacheStatus: r.cache_status, cdnVerified: !!r.cdn_verified, processingVersion: r.processing_version, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
  upsertDiscovered(a: any, runId: string): AssetRecord {
    return this.tx(() => {
      const ex = this.get('SELECT * FROM assets WHERE asset_id=?', a.assetId);
      if (ex) return this.toAsset(ex);
      const ts = this.now();
      this.run(
        `INSERT INTO assets(asset_id,source_provider,source_bucket,source_key,source_url,source_sha256,source_bytes,source_mime,source_width,source_height,media_type,state,attempts,run_id,cache_status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,'DISCOVERED',0,?,'PENDING',?,?)`,
        a.assetId, a.sourceProvider, a.sourceBucket, a.sourceKey, a.sourceUrl, a.sourceSha256, a.sourceBytes, a.sourceMime, a.sourceWidth, a.sourceHeight, a.mediaType, runId, ts, ts,
      );
      this.appendEvent({ runId, assetId: a.assetId, level: 'info', type: 'asset.discovered', detail: { key: a.sourceKey } });
      return this.toAsset(this.get('SELECT * FROM assets WHERE asset_id=?', a.assetId)!);
    });
  }
  getAsset(id: string): AssetRecord | null {
    const r = this.get('SELECT * FROM assets WHERE asset_id=?', id);
    return r ? this.toAsset(r) : null;
  }
  listAssets(q: AssetQuery = {}): AssetRecord[] {
    const where: string[] = [];
    const p: any[] = [];
    if (q.states?.length) { where.push(`state IN (${q.states.map(() => '?').join(',')})`); p.push(...q.states); }
    if (q.afterId) { where.push('asset_id>?'); p.push(q.afterId); }
    const sql = `SELECT * FROM assets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY asset_id ${q.limit ? 'LIMIT ?' : ''}`;
    if (q.limit) p.push(q.limit);
    return (this.db.prepare(sql).all(...p) as Row[]).map((r) => this.toAsset(r));
  }
  countByState(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.all('SELECT state, COUNT(*) AS n FROM assets GROUP BY state')) out[r.state] = r.n;
    return out;
  }
  transition(assetId: string, to: AssetState, o: TransitionOptions): AssetRecord {
    return this.tx(() => {
      const row = this.get('SELECT * FROM assets WHERE asset_id=?', assetId);
      if (!row) throw new MediaMigrateError('internal', 'NO_SUCH_ASSET', `asset ${assetId} not found`);
      const from = row.state as AssetState;
      assertTransition(from, to);
      const p = o.patch ?? {};
      const col: Record<string, string> = {
        sourceSha256: 'source_sha256', sourceBytes: 'source_bytes', sourceMime: 'source_mime', sourceWidth: 'source_width', sourceHeight: 'source_height',
        skipReason: 'skip_reason', cacheStatus: 'cache_status', cdnVerified: 'cdn_verified', processingVersion: 'processing_version', mediaType: 'media_type',
      };
      const sets = ['state=?', 'updated_at=?', 'last_error=?', 'run_id=?'];
      const vals: any[] = [to, this.now(), o.error ?? null, o.runId ?? row.run_id];
      for (const [k, v] of Object.entries(p)) {
        if (col[k]) { sets.push(`${col[k]}=?`); vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null); }
      }
      if (o.incrementAttempts) sets.push('attempts=attempts+1');
      if (o.resetAttempts) sets.push('attempts=0');
      this.db.prepare(`UPDATE assets SET ${sets.join(',')} WHERE asset_id=?`).run(...vals, assetId);
      this.appendEvent({
        runId: o.runId, assetId, level: to === 'FAILED' || to === 'CONFLICT' ? 'error' : 'info', type: 'asset.transition',
        detail: { from, to, ...(o.error ? { error: o.error } : {}), ...(o.detail ?? {}) },
      });
      return this.toAsset(this.get('SELECT * FROM assets WHERE asset_id=?', assetId)!);
    });
  }
  recordFailure(assetId: string, runId: string, error: string): number {
    return this.tx(() => {
      this.run('UPDATE assets SET attempts=attempts+1, last_error=?, updated_at=?, run_id=? WHERE asset_id=?', error, this.now(), runId, assetId);
      this.appendEvent({ runId, assetId, level: 'warn', type: 'asset.attempt-failed', detail: { error } });
      return this.get('SELECT attempts FROM assets WHERE asset_id=?', assetId)!.attempts as number;
    });
  }
  claimNext(runId: string, workerId: string, states: readonly AssetState[], leaseMs: number): AssetRecord | null {
    if (!states.length) return null;
    return this.tx(() => {
      const nowMs = this.clock().getTime();
      const r = this.db
        .prepare(`SELECT * FROM assets WHERE state IN (${states.map(() => '?').join(',')}) AND (claimed_by IS NULL OR lease_until < ?) ORDER BY asset_id LIMIT 1`)
        .get(...states, nowMs) as Row | undefined;
      if (!r) return null;
      this.run('UPDATE assets SET claimed_by=?, lease_until=?, run_id=? WHERE asset_id=?', workerId, nowMs + leaseMs, runId, r.asset_id);
      return this.toAsset(this.get('SELECT * FROM assets WHERE asset_id=?', r.asset_id)!);
    });
  }
  releaseClaim(assetId: string, workerId: string): void {
    this.run('UPDATE assets SET claimed_by=NULL, lease_until=NULL WHERE asset_id=? AND claimed_by=?', assetId, workerId);
  }
  clearClaims(): number {
    return Number(this.run('UPDATE assets SET claimed_by=NULL, lease_until=NULL WHERE claimed_by IS NOT NULL').changes);
  }
  setCacheStatus(assetId: string, status: CacheOpStatus): void {
    this.run('UPDATE assets SET cache_status=?, updated_at=? WHERE asset_id=?', status, this.now(), assetId);
  }

  // ───────── variants ─────────

  upsertVariant(v: VariantRecord): void {
    this.run(
      `INSERT INTO variants(asset_id,profile,width,effective_width,height,format,key,bytes,sha256,verified,processing_version) VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(asset_id,profile) DO UPDATE SET width=excluded.width,effective_width=excluded.effective_width,height=excluded.height,format=excluded.format,
         key=excluded.key,bytes=excluded.bytes,sha256=excluded.sha256,verified=excluded.verified,processing_version=excluded.processing_version`,
      v.assetId, v.profile, v.width, v.effectiveWidth, v.height, v.format, v.key, v.bytes, v.sha256, v.verified ? 1 : 0, v.processingVersion,
    );
  }
  listVariants(assetId: string): VariantRecord[] {
    return this.all('SELECT * FROM variants WHERE asset_id=? ORDER BY width', assetId).map((r) => ({
      assetId: r.asset_id, profile: r.profile, width: r.width, effectiveWidth: r.effective_width, height: r.height, format: r.format, key: r.key,
      bytes: r.bytes, sha256: r.sha256, verified: !!r.verified, processingVersion: r.processing_version,
    }));
  }

  // ───────── refs ─────────

  private toRef(r: Row): RefRecord {
    return {
      collection: r.collection, docId: r.doc_id, path: r.path, assetId: r.asset_id, originalValue: r.original_value, newValue: r.new_value,
      status: r.status, runId: r.run_id, updatedAt: r.updated_at,
    };
  }
  upsertRef(r: Omit<RefRecord, 'updatedAt'>): RefRecord {
    return this.tx(() => {
      const ex = this.get('SELECT * FROM refs WHERE collection=? AND doc_id=? AND path=?', r.collection, r.docId, r.path);
      if (ex) return this.toRef(ex); // original value is immutable once recorded
      this.run(
        'INSERT INTO refs(collection,doc_id,path,asset_id,original_value,new_value,status,run_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        r.collection, r.docId, r.path, r.assetId, r.originalValue, r.newValue, r.status, r.runId, this.now(),
      );
      return this.toRef(this.get('SELECT * FROM refs WHERE collection=? AND doc_id=? AND path=?', r.collection, r.docId, r.path)!);
    });
  }
  getRef(l: RefLocation): RefRecord | null {
    const r = this.get('SELECT * FROM refs WHERE collection=? AND doc_id=? AND path=?', l.collection, l.docId, l.path);
    return r ? this.toRef(r) : null;
  }
  listRefs(q: { assetId?: string; statuses?: readonly RefStatus[]; runId?: string; limit?: number }): RefRecord[] {
    const where: string[] = [];
    const p: any[] = [];
    if (q.assetId) { where.push('asset_id=?'); p.push(q.assetId); }
    if (q.statuses?.length) { where.push(`status IN (${q.statuses.map(() => '?').join(',')})`); p.push(...q.statuses); }
    if (q.runId) { where.push('run_id=?'); p.push(q.runId); }
    const sql = `SELECT * FROM refs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY collection, doc_id, path ${q.limit ? 'LIMIT ?' : ''}`;
    if (q.limit) p.push(q.limit);
    return (this.db.prepare(sql).all(...p) as Row[]).map((r) => this.toRef(r));
  }
  setRefStatus(l: RefLocation, to: RefStatus, patch: { newValue?: string | null; runId?: string | null }): RefRecord {
    return this.tx(() => {
      const cur = this.getRef(l);
      if (!cur) throw new MediaMigrateError('internal', 'NO_SUCH_REF', `reference ${l.collection}/${l.docId}/${l.path} not found`);
      assertRefTransition(cur.status, to);
      this.run(
        'UPDATE refs SET status=?, new_value=?, run_id=?, updated_at=? WHERE collection=? AND doc_id=? AND path=?',
        to, patch.newValue !== undefined ? patch.newValue : cur.newValue, patch.runId !== undefined ? patch.runId : cur.runId, this.now(), l.collection, l.docId, l.path,
      );
      this.appendEvent({
        runId: patch.runId ?? cur.runId, assetId: cur.assetId, level: to === 'CONFLICT' || to === 'ROLLBACK_CONFLICT' ? 'warn' : 'info', type: 'ref.status',
        detail: { collection: l.collection, docId: l.docId, path: l.path, from: cur.status, to },
      });
      return this.getRef(l)!;
    });
  }

  // ───────── orphans, cache ops, duplicates ─────────

  recordOrphan(o: OrphanRecord): void {
    this.run('INSERT INTO orphans(key,bytes,reason,run_id,discovered_at) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes,reason=excluded.reason,run_id=excluded.run_id', o.key, o.bytes, o.reason, o.runId, o.discoveredAt);
  }
  listOrphans(): OrphanRecord[] {
    return this.all('SELECT * FROM orphans ORDER BY key').map((r) => ({ key: r.key, bytes: r.bytes, reason: r.reason, runId: r.run_id, discoveredAt: r.discovered_at }));
  }
  clearOrphan(key: string): void {
    this.run('DELETE FROM orphans WHERE key=?', key);
  }
  recordCacheOp(op: { assetId: string; runId: string; url: string; action: 'cdn-verify' | 'purge'; status: CacheOpStatus; detail?: string }): void {
    this.run('INSERT INTO cache_ops(asset_id,run_id,url,action,status,detail,ts) VALUES(?,?,?,?,?,?,?)', op.assetId, op.runId, op.url, op.action, op.status, op.detail ?? null, this.now());
  }
  listCacheOps(runId?: string) {
    const rows = runId ? this.all('SELECT * FROM cache_ops WHERE run_id=? ORDER BY id', runId) : this.all('SELECT * FROM cache_ops ORDER BY id');
    return rows.map((r) => ({ assetId: r.asset_id, runId: r.run_id, url: r.url, action: r.action, status: r.status, detail: r.detail, ts: r.ts }));
  }
  duplicateGroups(): Array<{ sha256: string; assetIds: string[] }> {
    const rows = this.all(
      `SELECT source_sha256 AS sha, GROUP_CONCAT(asset_id) AS ids, COUNT(*) AS n FROM assets WHERE source_sha256 IS NOT NULL GROUP BY source_sha256 HAVING n>1 ORDER BY sha`,
    );
    return rows.map((r) => ({ sha256: r.sha, assetIds: String(r.ids).split(',').sort() }));
  }

  // ───────── checkpoints ─────────

  save(runId: string, name: string, data: Record<string, unknown>): void {
    this.run('INSERT INTO checkpoints(run_id,name,ts,data) VALUES(?,?,?,?)', runId, name, this.now(), JSON.stringify(data));
  }
  latest(runId: string, name: string) {
    const r = this.get('SELECT * FROM checkpoints WHERE run_id=? AND name=? ORDER BY id DESC LIMIT 1', runId, name);
    return r ? { ts: r.ts, data: JSON.parse(r.data) } : null;
  }
  latestAny(runId: string) {
    const r = this.get('SELECT * FROM checkpoints WHERE run_id=? ORDER BY id DESC LIMIT 1', runId);
    return r ? { name: r.name, ts: r.ts, data: JSON.parse(r.data) } : null;
  }
}
