import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CasItem, CasResult, DatabaseProvider, DbCapabilities, DbScanBatch, DbScanOptions } from '../core/interfaces';
import { expandAll, getAtPath, setAtPath } from './paths';

/**
 * Document store on SQLite. Serves two purposes:
 *  1. deterministic fake database for tests (including cross-process CLI end-to-end runs), and
 *  2. a "local files" provider for rehearsals.
 * CAS semantics mirror MongoDB single-document updates: all expected values must match, else nothing is written.
 */
export class SqliteDocDatabase implements DatabaseProvider {
  readonly kind = 'sqlite-docs';
  private db: DatabaseSync;
  /** Test knob: pretend the topology does/doesn't support transactions. */
  constructor(file: string, private readonly txSupported = true) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=15000;');
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS docs(coll TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(coll,id))');
  }

  /** Test/fixture helper. `id` is the raw id (stored as `str:<id>`). */
  insert(coll: string, id: string, doc: Record<string, unknown>): void {
    this.db.prepare('INSERT OR REPLACE INTO docs(coll,id,json) VALUES(?,?,?)').run(coll, `str:${id}`, JSON.stringify({ _id: id, ...doc }));
  }
  getDoc(coll: string, id: string): any | null {
    const r = this.db.prepare('SELECT json FROM docs WHERE coll=? AND id=?').get(coll, id.startsWith('str:') ? id : `str:${id}`) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : null;
  }
  /** Simulates an application/user edit that bypasses the migrator. */
  edit(coll: string, id: string, mutate: (doc: any) => void): void {
    const doc = this.getDoc(coll, id);
    mutate(doc);
    this.db.prepare('UPDATE docs SET json=? WHERE coll=? AND id=?').run(JSON.stringify(doc), coll, `str:${id}`);
  }
  allDocs(coll: string): any[] {
    return (this.db.prepare('SELECT json FROM docs WHERE coll=? ORDER BY id').all(coll) as Array<{ json: string }>).map((r) => JSON.parse(r.json));
  }
  snapshot(): string {
    return JSON.stringify(this.db.prepare('SELECT coll,id,json FROM docs ORDER BY coll,id').all());
  }

  async capabilities(): Promise<DbCapabilities> {
    return this.txSupported
      ? { transactions: true, reason: 'sqlite document store supports atomic batches' }
      : { transactions: false, reason: 'transactions disabled for this fake' };
  }

  async *scan(o: DbScanOptions): AsyncIterable<DbScanBatch> {
    let after = o.afterId ?? '';
    for (;;) {
      const rows = this.db
        .prepare('SELECT id,json FROM docs WHERE coll=? AND id>? ORDER BY id LIMIT ?')
        .all(o.collection, after, o.batchSize) as Array<{ id: string; json: string }>;
      if (rows.length === 0) return;
      const refs: DbScanBatch['refs'] = [];
      let scanned = 0;
      for (const r of rows) {
        const doc = JSON.parse(r.json);
        if (o.timestampField && (o.since || o.until)) {
          const ts = getAtPath(doc, o.timestampField);
          const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
          if (Number.isNaN(t)) continue;
          if (o.since && t < o.since.getTime()) continue;
          if (o.until && t >= o.until.getTime()) continue;
        }
        scanned++;
        for (const x of expandAll(doc, o.fields)) refs.push({ docId: r.id, path: x.path, value: x.value });
      }
      after = rows[rows.length - 1].id;
      yield { refs, lastDocId: after, docsScanned: scanned };
      if (rows.length < o.batchSize) return;
    }
  }

  async readValues(coll: string, docId: string, paths: readonly string[]): Promise<Record<string, unknown> | null> {
    const doc = this.getDoc(coll, docId);
    if (!doc) return null;
    return Object.fromEntries(paths.map((p) => [p, getAtPath(doc, p)]));
  }

  async compareAndSet(items: readonly CasItem[], opts: { transactional: boolean }): Promise<CasResult[]> {
    if (opts.transactional && !this.txSupported) throw new Error('transactions unsupported');
    const results: CasResult[] = [];
    const apply = (it: CasItem): { res: CasResult; doc?: any } => {
      const doc = this.getDoc(it.collection, it.docId);
      if (!doc) return { res: { ok: false, reason: 'missing' } };
      const actual: Record<string, unknown> = {};
      let ok = true;
      for (const op of it.ops) {
        actual[op.path] = getAtPath(doc, op.path);
        if (actual[op.path] !== op.expected) ok = false;
      }
      if (!ok) return { res: { ok: false, reason: 'conflict', actual } };
      for (const op of it.ops) setAtPath(doc, op.path, op.next);
      return { res: { ok: true }, doc };
    };
    const write = (coll: string, id: string, doc: any) =>
      this.db.prepare('UPDATE docs SET json=? WHERE coll=? AND id=?').run(JSON.stringify(doc), coll, id.startsWith('str:') ? id : `str:${id}`);

    if (!opts.transactional) {
      for (const it of items) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const { res, doc } = apply(it);
          if (doc) write(it.collection, it.docId, doc);
          this.db.exec('COMMIT');
          results.push(res);
        } catch (e) {
          this.db.exec('ROLLBACK');
          throw e;
        }
      }
      return results;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const staged = items.map(apply);
      if (staged.every((s) => s.res.ok)) {
        staged.forEach((s, i) => write(items[i].collection, items[i].docId, s.doc));
        this.db.exec('COMMIT');
        return staged.map((s) => s.res);
      }
      this.db.exec('ROLLBACK');
      return staged.map((s) => (s.res.ok ? { ok: false as const, reason: 'aborted' as const } : s.res));
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async sample(coll: string, n: number): Promise<unknown[]> {
    return (this.db.prepare('SELECT json FROM docs WHERE coll=? ORDER BY id LIMIT ?').all(coll, n) as Array<{ json: string }>).map((r) => JSON.parse(r.json));
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      /* closed */
    }
  }
}
