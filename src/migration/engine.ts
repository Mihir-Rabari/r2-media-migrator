import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { AssetRecord, AssetState, RefRecord, RunRecord } from '../domain/types';
import type { LockHandle, VariantSpec } from '../core/interfaces';
import {
  errorMessage, ExitCode, IntegrityError, isRetryable, MediaMigrateError, safetyError, SimulatedCrash, validationError,
} from '../domain/errors';
import { idempotencyKey, newRunId, profileName, variantKey, VariantProfile } from '../domain/ids';
import { NO_FAILPOINTS } from '../core/failpoints';
import { readOnlyCache, readOnlyDatabase, readOnlyStorage } from '../core/guards';
import { ByteBudget, RateLimiter, Semaphore } from '../core/limits';
import { RetryPolicy, withRetry } from '../core/retry';
import { ShutdownController } from '../core/shutdown';
import { cleanStaleTemp, makeTempDir } from '../security/paths';
import { globalRedactor } from '../security/redact';
import { inventoryDatabase, planAssets } from '../inventory/inventory';
import { computeProgress } from '../observability/progress';
import type { EngineDeps, InventoryStats, RunKindForEngine, RunOptions, RunResult } from './context';
import { emptyStats } from './context';

type StageResult =
  | { kind: 'advance' }
  | { kind: 'skip'; reason: string }
  | { kind: 'missing'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'reprocess'; message: string }
  | { kind: 'hold'; message: string };

const FORWARD_CLAIM: Record<'process' | 'migrate', AssetState[]> = {
  process: ['PLANNED', 'PROCESSING', 'ASSETS_WRITTEN'],
  migrate: ['PLANNED', 'PROCESSING', 'ASSETS_WRITTEN', 'DESTINATION_VERIFIED', 'REFERENCES_UPDATED', 'CACHE_HANDLED'],
};
const CLAIM_LEASE_MS = 24 * 3600 * 1000;

class Interrupted extends Error {
  constructor() {
    super('interrupted');
  }
}

export class MigrationEngine {
  readonly d: EngineDeps;
  private readonly fp;
  readonly shutdown: ShutdownController;
  private crashed: SimulatedCrash | null = null;
  private budget: ByteBudget;
  private limiter: RateLimiter;
  private runId = '';
  private kind: RunKindForEngine = 'migrate';
  private lock: LockHandle | null = null;
  private lockLost = false;
  private timer: NodeJS.Timeout | null = null;
  private lastEmit = 0;
  private lastCheckpoint = 0;
  private checkpointsTaken = 0;
  private claimed = 0;
  private readonly claimedIds = new Set<string>();
  private attempted = 0;
  private failed = 0;
  private limit: number | undefined;
  private thresholdTripped: string | null = null;
  private partialScope = false;
  private stats: InventoryStats = emptyStats();
  private readonly procVersion: string;

  constructor(deps: EngineDeps) {
    // Dry-run is enforced here, below the CLI: every provider is wrapped so a mutation throws DryRunViolation.
    this.d = deps.dryRun
      ? { ...deps, source: readOnlyStorage(deps.source), dest: readOnlyStorage(deps.dest), db: readOnlyDatabase(deps.db), cache: readOnlyCache(deps.cache) }
      : deps;
    this.fp = deps.failpoints ?? NO_FAILPOINTS;
    this.shutdown = deps.shutdown ?? new ShutdownController();
    this.budget = new ByteBudget(deps.cfg.processing.tempBudgetBytes);
    this.limiter = new RateLimiter(deps.cfg.migration.rateLimitPerSec);
    this.procVersion = `${deps.processor.version}|${deps.processingFingerprint}`;
  }

  get tempBudget(): ByteBudget {
    return this.budget;
  }

  private get retryPolicy(): RetryPolicy {
    const r = this.d.cfg.migration.retry;
    return { maxAttempts: r.maxAttempts, baseDelayMs: r.baseDelayMs, maxDelayMs: r.maxDelayMs, jitter: r.jitter };
  }

  // ───────────────────────── public: run ─────────────────────────

  async run(kind: RunKindForEngine, opts: RunOptions = {}): Promise<RunResult> {
    const d = this.d;
    const { journal, cfg } = d;
    this.kind = kind;
    if (!d.dryRun && (kind === 'process' || kind === 'migrate')) this.assertMutationAllowed(kind);
    if (!d.dryRun && kind === 'migrate' && cfg.database.writePolicy.referenceUpdates === 'disabled') {
      throw validationError('REFERENCE_UPDATES_DISABLED', 'database.writePolicy.referenceUpdates is "disabled": use `process` to stage assets, or enable reference updates');
    }
    if (opts.concurrency !== undefined && (opts.concurrency < 1 || !Number.isInteger(opts.concurrency))) throw validationError('BAD_CONCURRENCY', 'concurrency must be a positive integer');
    if (opts.limit !== undefined && (opts.limit < 1 || !Number.isInteger(opts.limit))) throw validationError('BAD_LIMIT', 'limit must be a positive integer');

    if (cfg.database.writePolicy.mode === 'transaction' && !d.dryRun && kind === 'migrate') {
      const caps = await d.db.capabilities();
      if (!caps.transactions) throw validationError('TRANSACTIONS_UNSUPPORTED', `database.writePolicy.mode=transaction but the database does not support transactions: ${caps.reason}`);
    }

    // ---- run record
    let run: RunRecord | null = opts.runId ? journal.getRun(opts.runId) : null;
    if (opts.resume) {
      if (!run) throw validationError('NO_SUCH_RUN', `cannot resume: run ${opts.runId ?? '(none)'} not found`);
      if (run.dryRun !== d.dryRun) throw validationError('RUN_MODE_MISMATCH', `run ${run.runId} was a ${run.dryRun ? 'dry-run' : 'real'} run`);
      if (run.configFingerprint !== d.configFingerprint && !opts.allowConfigChange) {
        throw validationError('CONFIG_CHANGED', `configuration changed since run ${run.runId} started; start a new run (or pass allowConfigChange)`);
      }
    } else if (run) {
      throw validationError('RUN_EXISTS', `run ${opts.runId} already exists; use --resume`);
    }
    this.runId = run?.runId ?? opts.runId ?? newRunId();
    const startedAt = (d.clock ?? (() => new Date()))().toISOString();
    if (!run) {
      journal.createRun({
        runId: this.runId, kind, status: 'CREATED', configFingerprint: d.configFingerprint, dryRun: d.dryRun, pid: null, host: null, startedAt,
        finishedAt: null, lastHeartbeatAt: null, stopRequested: false, blockingError: null,
        params: { limit: opts.limit ?? null, since: opts.since?.toISOString() ?? null, until: opts.until?.toISOString() ?? null, concurrency: opts.concurrency ?? cfg.processing.concurrency },
      });
    }

    // ---- exclusive lock (throws kind=locked when another live process owns the journal)
    const host = d.host ?? os.hostname();
    const pid = d.pid ?? process.pid;
    try {
      this.lock = journal.acquireLock(this.runId, {
        staleAfterMs: cfg.migration.lockStaleSec * 1000, pid, host, isPidAlive: d.isPidAlive ?? defaultPidAlive,
      });
    } catch (e) {
      if (!opts.resume) journal.updateRun(this.runId, { status: 'FAILED', finishedAt: new Date().toISOString(), blockingError: globalRedactor.string(errorMessage(e)) });
      throw e;
    }
    // we are the only live process: any claim left behind belongs to a dead one
    journal.clearClaims();
    cleanStaleTemp(d.paths.tempDir, 0);
    journal.updateRun(this.runId, { status: 'RUNNING', pid, host, finishedAt: null, blockingError: null, lastHeartbeatAt: startedAt, stopRequested: false });
    d.logger.info('run.started', { kind, dryRun: d.dryRun, resume: !!opts.resume }, { runId: this.runId });

    this.limit = opts.limit;
    this.partialScope = !!(opts.limit || opts.assetIds || opts.since || opts.until);
    this.startTimer();
    let finalized = false;
    try {
      const result = await this.phases(kind, opts);
      finalized = true;
      return result;
    } catch (e) {
      if (e instanceof SimulatedCrash) {
        this.crashed = e;
        throw e; // a crashed process cleans nothing up: lock, run status and claims stay exactly as they were
      }
      finalized = true;
      const msg = globalRedactor.string(errorMessage(e));
      d.logger.error('run.error', { error: msg }, { runId: this.runId });
      journal.updateRun(this.runId, { status: 'FAILED', finishedAt: new Date().toISOString(), blockingError: msg });
      d.reporter.emit({ ts: new Date().toISOString(), runId: this.runId, type: 'run.finished', status: 'FAILED', error: msg });
      if (e instanceof MediaMigrateError && (e.kind === 'validation' || e.kind === 'safety' || e.kind === 'locked')) throw e;
      return { runId: this.runId, status: 'FAILED', exitCode: ExitCode.OPERATIONAL, message: msg, summary: {} };
    } finally {
      this.stopTimer();
      if (!this.crashed && this.lock) {
        journal.clearClaims();
        try { journal.releaseLock(this.lock); } catch { /* journal closed */ }
        this.lock = null;
      }
      void finalized;
    }
  }

  private assertMutationAllowed(kind: string): void {
    if (this.d.cfg.environment === 'production' && !this.d.cfg.safety.allowProductionMutations) {
      throw safetyError('PRODUCTION_BLOCKED', `environment is "production" but safety.allowProductionMutations is false: refusing to ${kind}`);
    }
    if (this.d.mutationAuthorized === false) {
      throw safetyError('NOT_AUTHORIZED', `refusing to ${kind} without explicit authorization (--yes)`);
    }
  }

  // ───────────────────────── phases ─────────────────────────

  private async phases(kind: RunKindForEngine, opts: RunOptions): Promise<RunResult> {
    const d = this.d;
    const stopping = () => this.stopping();

    this.setPhase('inventory');
    if (!opts.skipInventory) this.stats = await inventoryDatabase(d, this.runId, opts, stopping);
    else this.stats = (d.journal.latest(this.runId, 'inventory:stats')?.data as unknown as InventoryStats) ?? emptyStats();
    if (this.stopping()) return this.finalize(kind, true);

    this.setPhase('plan');
    const plan = await planAssets(d, this.runId, opts, stopping);
    d.journal.save(this.runId, 'plan:summary', plan);
    if (this.stopping()) return this.finalize(kind, true);

    if (kind === 'inventory') return this.finalize(kind, false);

    if (kind === 'dry-run') {
      this.setPhase('dry-run');
      await this.dryRunSample(opts);
      return this.finalize(kind, this.stopping());
    }

    this.setPhase(kind);
    const workers = Math.min(opts.concurrency ?? d.cfg.processing.concurrency, 64);
    const states = FORWARD_CLAIM[kind];
    await this.runWorkers(workers, states, kind === 'process' ? 'verified' : 'complete', opts);
    if (this.crashed) throw this.crashed;
    return this.finalize(kind, this.stopping() && !this.thresholdTripped);
  }

  private setPhase(phase: string): void {
    this.d.journal.save(this.runId, 'phase', { phase });
    this.d.logger.info('run.phase', { phase }, { runId: this.runId });
    this.emitProgress(true);
  }

  // ───────────────────────── workers ─────────────────────────

  private async runWorkers(n: number, states: AssetState[], upTo: 'verified' | 'complete', opts: RunOptions): Promise<void> {
    const only = opts.assetIds ? new Set(opts.assetIds) : null;
    const loops = Array.from({ length: n }, (_, i) => this.workerLoop(`w${i}-${process.pid}`, states, upTo, only));
    const results = await Promise.allSettled(loops);
    for (const r of results) {
      if (r.status === 'rejected') {
        if (r.reason instanceof SimulatedCrash) this.crashed ??= r.reason;
        else throw r.reason;
      }
    }
  }

  private async workerLoop(wid: string, states: AssetState[], upTo: 'verified' | 'complete', only: Set<string> | null): Promise<void> {
    const { journal } = this.d;
    for (;;) {
      this.assertAlive();
      if (this.stopping() || this.thresholdTripped) return;
      // reserve a slot synchronously so concurrent workers can never exceed --limit
      if (this.limit !== undefined) {
        if (this.claimed >= this.limit) return;
        this.claimed++;
      }
      await this.limiter.take();
      let a: AssetRecord | null;
      if (only) {
        // restricted scope (retry): claim only assets in the allow-list
        a = null;
        for (let tries = 0; tries < 10_000; tries++) {
          const c = journal.claimNext(this.runId, wid, states, CLAIM_LEASE_MS);
          if (!c) break;
          if (only.has(c.assetId)) { a = c; break; }
          // not ours: keep its lease for the rest of this run so it is not re-offered
        }
      } else a = journal.claimNext(this.runId, wid, states, CLAIM_LEASE_MS);
      if (!a) {
        if (this.limit !== undefined) this.claimed--;
        return;
      }
      if (this.limit === undefined) this.claimed++;
      this.claimedIds.add(a.assetId);
      this.attempted++;
      await this.processAsset(a, upTo);
      this.tick();
      const maxF = this.d.cfg.migration.failureThreshold;
      if (this.failed > maxF.maxFailed) this.trip(`failure threshold exceeded: ${this.failed} failed > maxFailed ${maxF.maxFailed}`);
      else if (this.attempted >= 20 && this.failed / this.attempted > maxF.maxFailedRatio) this.trip(`failure ratio ${(this.failed / this.attempted).toFixed(2)} > ${maxF.maxFailedRatio}`);
    }
  }

  private trip(reason: string): void {
    if (this.thresholdTripped) return;
    this.thresholdTripped = reason;
    this.d.logger.error('run.threshold-tripped', { reason }, { runId: this.runId });
  }

  // ───────────────────────── per-asset pipeline ─────────────────────────

  private async processAsset(initial: AssetRecord, upTo: 'verified' | 'complete'): Promise<void> {
    const { journal, cfg, logger } = this.d;
    const id = initial.assetId;
    const ctx = { runId: this.runId, assetId: id };
    try {
      // Poison-pill guard: an asset found mid-PROCESSING was being worked on when a previous process died.
      if (initial.state === 'PROCESSING' && initial.lastError !== 'interrupted') {
        journal.recordFailure(id, this.runId, 'recovered after interruption');
      }
      for (;;) {
        this.assertAlive();
        if (this.stopping()) throw new Interrupted();
        const cur = journal.getAsset(id)!;
        if (cur.attempts >= cfg.migration.retry.maxItemAttempts && ['PLANNED', 'PROCESSING', 'ASSETS_WRITTEN'].includes(cur.state)) {
          await this.go(cur, 'FAILED', { error: `retry budget exhausted after ${cur.attempts} attempts (last: ${cur.lastError ?? 'n/a'})` });
          this.failed++;
          return;
        }
        switch (cur.state) {
          case 'PLANNED':
            await this.go(cur, 'PROCESSING', { incrementAttempts: true });
            break;
          case 'PROCESSING': {
            const r = await this.guarded(cur, 'process', () => this.stageProcess(cur));
            if (!(await this.applyStage(cur, r, 'ASSETS_WRITTEN'))) return;
            break;
          }
          case 'ASSETS_WRITTEN': {
            const r = await this.guarded(cur, 'verify', () => this.stageVerify(cur));
            if (!(await this.applyStage(cur, r, 'DESTINATION_VERIFIED'))) return;
            break;
          }
          case 'DESTINATION_VERIFIED': {
            if (upTo === 'verified') return;
            const r = await this.guarded(cur, 'references', () => this.stageReferences(cur));
            if (!(await this.applyStage(cur, r, 'REFERENCES_UPDATED'))) return;
            break;
          }
          case 'REFERENCES_UPDATED': {
            if (upTo === 'verified') return;
            const r = await this.guarded(cur, 'cache', () => this.stageCache(cur));
            if (!(await this.applyStage(cur, r, 'CACHE_HANDLED'))) return;
            break;
          }
          case 'CACHE_HANDLED':
            this.assertPostconditions(cur);
            await this.go(cur, 'COMPLETE', {});
            return;
          default:
            return; // terminal or not claimable
        }
      }
    } catch (e) {
      if (e instanceof SimulatedCrash) {
        this.crashed ??= e;
        throw e;
      }
      if (e instanceof Interrupted || (this.shutdown.abort.signal.aborted && !(e instanceof MediaMigrateError && e.kind === 'safety'))) {
        logger.info('asset.interrupted', {}, ctx);
        // remember that this was a graceful interruption so recovery does not count it as a crash
        journal.patchAsset(id, { lastError: 'interrupted' }, this.runId);
        return;
      }
      if (e instanceof MediaMigrateError && e.kind === 'safety') throw e; // DryRunViolation etc: never swallow
      const msg = globalRedactor.string(errorMessage(e));
      logger.error('asset.failed', { error: msg, code: (e as MediaMigrateError).code }, ctx);
      const cur = journal.getAsset(id)!;
      try {
        await this.go(cur, 'FAILED', { error: msg, incrementAttempts: true });
      } catch (e2) {
        if (e2 instanceof SimulatedCrash) throw e2;
        journal.recordFailure(id, this.runId, msg);
      }
      this.failed++;
    }
  }

  /** Run a stage with bounded retries for transient errors (retry budget is explicit and counted). */
  private async guarded<T>(a: AssetRecord, name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await withRetry(
        async () => {
          this.assertAlive();
          return fn();
        },
        this.retryPolicy,
        {
          sleep: this.d.sleep,
          rand: this.d.rand,
          shouldStop: () => this.stopping(),
          classify: (err) => !(err instanceof SimulatedCrash) && isRetryable(err),
          onRetry: (err, attempt, delay) => {
            this.d.journal.addCounters(this.runId, { retries: 1 });
            this.d.logger.warn('stage.retry', { stage: name, attempt, delayMs: delay, error: errorMessage(err) }, { runId: this.runId, assetId: a.assetId });
          },
        },
      );
    } finally {
      this.d.journal.recordTiming(this.runId, `stage:${name}`, performance.now() - t0);
    }
  }

  private async applyStage(a: AssetRecord, r: StageResult, next: AssetState): Promise<boolean> {
    const cur = this.d.journal.getAsset(a.assetId)!;
    switch (r.kind) {
      case 'advance':
        await this.go(cur, next, {});
        return true;
      case 'skip':
        await this.go(cur, 'SKIPPED', { patch: { skipReason: r.reason } });
        return false;
      case 'missing':
        await this.go(cur, 'SOURCE_MISSING', { error: r.message });
        this.failed++;
        return false;
      case 'conflict':
        await this.go(cur, 'CONFLICT', { error: r.message });
        this.failed++;
        return false;
      case 'reprocess':
        await this.go(cur, 'PROCESSING', { error: r.message, incrementAttempts: true });
        return true;
      case 'hold':
        // stays in its current state (visible, retryable); never advances toward COMPLETE
        this.d.logger.warn('asset.held', { reason: r.message }, { runId: this.runId, assetId: a.assetId });
        return false;
    }
  }

  /** State transition wrapped in failpoints (journal write happens strictly between before/after). */
  private async go(a: AssetRecord, to: AssetState, o: { error?: string; incrementAttempts?: boolean; patch?: Parameters<EngineDeps['journal']['transition']>[2]['patch'] }): Promise<void> {
    await this.fp.hit(`transition:before:${to}`);
    this.d.journal.transition(a.assetId, to, { runId: this.runId, error: o.error, incrementAttempts: o.incrementAttempts, patch: o.patch });
    await this.fp.hit(`transition:after:${to}`);
  }

  // ───────────────────────── stage: process ─────────────────────────

  private profiles(): VariantProfile[] {
    return this.d.cfg.processing.widths.map((w) => ({ width: w, format: this.d.cfg.processing.format }));
  }

  private destKey(assetId: string, p: VariantProfile): string {
    const dc = this.d.cfg.destination;
    return variantKey(dc.namespace, dc.namespaceVersion, assetId, p);
  }

  private spec(p: VariantProfile, probeAnimated: boolean): VariantSpec {
    const pc = this.d.cfg.processing;
    return { width: p.width, format: pc.format, quality: pc.quality, effort: pc.effort, metadata: pc.metadata, animated: pc.animated === 'preserve' && probeAnimated };
  }

  private limits() {
    return { maxPixels: this.d.cfg.processing.maxSourcePixels, maxFileBytes: this.d.cfg.processing.maxSourceBytes };
  }

  private signal(timeoutMs: number): { signal: AbortSignal; done: () => void } {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new MediaMigrateError('transient', 'TIMEOUT', `operation timed out after ${timeoutMs}ms`)), timeoutMs);
    const any = AbortSignal.any([ac.signal, this.shutdown.abort.signal]);
    return { signal: any, done: () => clearTimeout(t) };
  }

  private async stageProcess(a: AssetRecord): Promise<StageResult> {
    const { journal, source, dest, processor, cfg } = this.d;
    const ctx = { runId: this.runId, assetId: a.assetId };
    const profiles = this.profiles();
    const mime = (p: VariantProfile) => `image/${p.format}`;

    // Reuse: every variant already verified under the same processing version and still intact at the destination.
    if (a.sourceSha256) {
      const existing = journal.listVariants(a.assetId);
      let reusable = existing.length >= profiles.length;
      for (const p of profiles) {
        const v = existing.find((x) => x.profile === profileName(p));
        if (!v || !v.verified || v.processingVersion !== this.procVersion) { reusable = false; break; }
        const h = await dest.head(v.key);
        if (!h || h.size !== v.bytes || h.metadata.sha256 !== v.sha256) { reusable = false; break; }
      }
      if (reusable) {
        this.d.logger.info('asset.variants-reused', {}, ctx);
        return { kind: 'advance' };
      }
    }

    await this.fp.hit('download:before');
    const head = await source.head(a.sourceKey);
    if (!head) return { kind: 'missing', message: `source object not found: ${a.sourceKey}` };
    if (head.size > cfg.processing.maxSourceBytes) return { kind: 'skip', reason: `too-large:${head.size}` };

    const release = await this.budget.acquire(Math.max(head.size, 1));
    const tmp = makeTempDir(this.d.paths.tempDir);
    try {
      // ---- download (bounded, streamed to disk, hashed on the fly)
      const srcFile = path.join(tmp, 'source.bin');
      const t0 = performance.now();
      const { signal, done } = this.signal(cfg.migration.timeoutsMs.download);
      let sha256: string;
      let bytes = 0;
      try {
        const got = await source.get(a.sourceKey, { signal });
        const hash = createHash('sha256');
        const counter = new Transform({
          transform: (chunk: Buffer, _enc, cb) => {
            bytes += chunk.length;
            if (bytes > cfg.processing.maxSourceBytes) return cb(new MediaMigrateError('permanent', 'FILE_TOO_LARGE', 'source exceeded maxSourceBytes while streaming'));
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        await pipeline(got.body, counter, fs.createWriteStream(srcFile), { signal });
        sha256 = hash.digest('hex');
      } finally {
        done();
      }
      if (bytes !== head.size) throw new MediaMigrateError('transient', 'TRUNCATED_DOWNLOAD', `downloaded ${bytes} bytes but object is ${head.size}`);
      journal.addCounters(this.runId, { bytesRead: bytes });
      journal.recordTiming(this.runId, 'download', performance.now() - t0);
      await this.fp.hit('download:after');

      if (a.sourceSha256 && a.sourceSha256 !== sha256) {
        return { kind: 'conflict', message: `source content changed since first download (was ${a.sourceSha256.slice(0, 12)}…, now ${sha256.slice(0, 12)}…); re-run with retry --accept-source-change after review` };
      }

      // ---- probe (content sniffing, limits, decode check)
      let probe;
      try {
        probe = await this.d.processor.probe(srcFile, this.limits());
      } catch (e) {
        if (e instanceof MediaMigrateError && (e.code === 'UNSUPPORTED_CONTENT' || e.code === 'UNSUPPORTED_FORMAT')) {
          journal.patchAsset(a.assetId, { sourceSha256: sha256, sourceBytes: bytes }, this.runId);
          return { kind: 'skip', reason: `${e.code === 'UNSUPPORTED_CONTENT' ? 'content-not-raster-image' : 'unsupported-input-format'}:${String(e.detail?.sniffed ?? e.detail?.format ?? 'unknown')}` };
        }
        throw e;
      }
      if (probe.animated && cfg.processing.animated === 'skip') {
        journal.patchAsset(a.assetId, { sourceSha256: sha256, sourceBytes: bytes, sourceMime: probe.mime }, this.runId);
        return { kind: 'skip', reason: 'animated-image-policy-skip' };
      }
      const declared = a.sourceMime;
      if (declared && declared !== probe.mime && declared.startsWith('image/')) this.d.logger.warn('asset.mime-mismatch', { declared, sniffed: probe.mime }, ctx);
      journal.patchAsset(a.assetId, { sourceSha256: sha256, sourceBytes: bytes, sourceMime: probe.mime, sourceWidth: probe.width, sourceHeight: probe.height, processingVersion: this.procVersion }, this.runId);

      // ---- generate + upload each variant
      for (const p of profiles) {
        this.assertAlive();
        if (this.stopping()) throw new Interrupted();
        const key = this.destKey(a.assetId, p);
        const out = path.join(tmp, `${p.width}.${p.format}`);
        const g0 = performance.now();
        const gen = await processor.generate(srcFile, probe, this.spec(p, probe.animated), out, this.limits());
        await processor.validate(out, { maxWidth: p.width, format: p.format, mime: mime(p) });
        journal.recordTiming(this.runId, 'process', performance.now() - g0);
        await this.fp.hit('process:after');

        // intent first, outcome later
        journal.upsertVariant({
          assetId: a.assetId, profile: profileName(p), width: p.width, effectiveWidth: gen.width, height: gen.height, format: p.format, key, bytes: gen.bytes,
          sha256: gen.sha256, verified: false, processingVersion: this.procVersion,
        });
        await this.fp.hit('upload:before');
        const conflict = await this.putVariant(a, key, out, gen, mime(p), idempotencyKey(this.d.configFingerprint, a.assetId, `variant:${profileName(p)}`, gen.sha256));
        if (conflict) return { kind: 'conflict', message: conflict };
        await this.fp.hit('upload:after');
      }
      return { kind: 'advance' };
    } finally {
      release();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Returns a conflict message, or null when the object at `key` is (now) exactly the generated bytes. */
  private async putVariant(a: AssetRecord, key: string, file: string, gen: { bytes: number; sha256: string }, contentType: string, idem: string): Promise<string | null> {
    const { dest, cfg, journal } = this.d;
    const matches = (h: { size: number; metadata: Record<string, string> } | null) => !!h && h.size === gen.bytes && h.metadata.sha256 === gen.sha256;
    const diag = (h: { metadata: Record<string, string> }) =>
      h.metadata['asset-id'] === a.assetId
        ? `destination key ${key} already holds different content for this asset (processing settings changed?). Variants are immutable: bump destination.namespaceVersion instead of overwriting`
        : `destination key ${key} is occupied by an object this tool did not write for this asset; refusing to overwrite`;
    const existing = await dest.head(key);
    if (existing) return matches(existing) ? null : diag(existing);
    const buf = fs.readFileSync(file);
    const u0 = performance.now();
    const { signal, done } = this.signal(cfg.migration.timeoutsMs.upload);
    try {
      await dest.put(key, buf, {
        contentType, cacheControl: cfg.destination.cacheControl, contentLength: buf.length, ifNoneMatch: true,
        metadata: { sha256: gen.sha256, 'idempotency-key': idem, 'asset-id': a.assetId, 'source-key': encodeURIComponent(a.sourceKey).slice(0, 512), 'processing-version': this.procVersion, 'run-id': this.runId },
      });
    } catch (e) {
      if (e instanceof MediaMigrateError && e.code === 'EXISTS') {
        const h = await dest.head(key); // lost a race with another writer: compare, never overwrite
        return h && matches(h) ? null : h ? diag(h) : `destination key ${key} reported as existing but not readable`;
      }
      throw e;
    } finally {
      done();
      void signal;
    }
    journal.addCounters(this.runId, { bytesWritten: buf.length });
    journal.recordTiming(this.runId, 'upload', performance.now() - u0);
    return null;
  }

  // ───────────────────────── stage: verify ─────────────────────────

  private async stageVerify(a: AssetRecord): Promise<StageResult> {
    const { journal, dest, cfg } = this.d;
    await this.fp.hit('verify:before');
    const t0 = performance.now();
    const variants = journal.listVariants(a.assetId);
    if (variants.length !== this.profiles().length) return { kind: 'reprocess', message: `expected ${this.profiles().length} variants, journal has ${variants.length}` };
    /** Verification failed for this object: distrust it, and remove it ONLY if this tool wrote it for this asset. */
    const distrust = async (v: (typeof variants)[number], why: string, existing: { metadata: Record<string, string> } | null): Promise<StageResult> => {
      journal.upsertVariant({ ...v, verified: false });
      if (existing && existing.metadata['asset-id'] === a.assetId) {
        await dest.delete(v.key);
        this.d.logger.warn('verify.removed-corrupt-object', { key: v.key, why }, { runId: this.runId, assetId: a.assetId });
      }
      return { kind: 'reprocess', message: why };
    };
    for (const v of variants) {
      const h = await dest.head(v.key);
      if (!h) return { kind: 'reprocess', message: `destination object missing after upload: ${v.key}` };
      if (h.size !== v.bytes) return distrust(v, `size mismatch for ${v.key}: ${h.size} != ${v.bytes}`, h);
      if (h.metadata.sha256 !== v.sha256) return distrust(v, `checksum metadata mismatch for ${v.key}`, h);
      if (h.contentType && h.contentType !== `image/${v.format}`) return distrust(v, `content-type mismatch for ${v.key}: ${h.contentType}`, h);
      if (cfg.migration.verification.mode === 'full') {
        const got = await dest.get(v.key);
        const hash = createHash('sha256');
        let n = 0;
        for await (const c of got.body) { hash.update(c as Buffer); n += (c as Buffer).length; }
        journal.addCounters(this.runId, { bytesRead: n });
        if (n !== v.bytes || hash.digest('hex') !== v.sha256) return distrust(v, `content hash mismatch when re-reading ${v.key}`, h);
      }
    }
    journal.tx(() => variants.forEach((v) => journal.upsertVariant({ ...v, verified: true })));
    journal.recordTiming(this.runId, 'verify', performance.now() - t0);
    await this.fp.hit('verify:after');
    return { kind: 'advance' };
  }

  // ───────────────────────── stage: references ─────────────────────────

  private async stageReferences(a: AssetRecord): Promise<StageResult> {
    const { journal, db, resolver, cfg } = this.d;
    // Invariant I1: refuse unless every variant is verified (defence in depth; the state machine already implies it).
    const variants = journal.listVariants(a.assetId);
    if (variants.length === 0 || variants.some((v) => !v.verified)) {
      throw new IntegrityError('I1_VIOLATION', `refusing to update references for ${a.assetId}: destination not verified`);
    }
    const newValue = resolver.canonicalUrl(a.assetId, cfg.destination.referenceVariantWidth);
    const refs = journal.listRefs({ assetId: a.assetId, statuses: ['PENDING', 'UPDATING', 'CONFLICT'] });
    const t0 = performance.now();
    const policy = cfg.database.writePolicy;
    let conflicts = 0;

    // classify each reference against the live document (observe-then-act)
    type Plan = { ref: RefRecord; action: 'write' | 'adopt' | 'conflict' | 'missing' };
    const plans: Plan[] = [];
    for (const r of refs) {
      const cur = await this.dbTimed(() => db.readValues(r.collection, r.docId, [r.path]));
      if (!cur) { plans.push({ ref: r, action: 'missing' }); continue; }
      const v = cur[r.path];
      if (v === newValue) plans.push({ ref: r, action: 'adopt' });
      else if (v === r.originalValue) plans.push({ ref: r, action: 'write' });
      else plans.push({ ref: r, action: 'conflict' });
    }

    const mark = (r: RefRecord, to: RefRecord['status'], newV?: string | null) => {
      const live = journal.getRef(r)!;
      if (live.status === to) return;
      // CONFLICT -> UPDATED / UPDATING needs to pass through PENDING
      if (live.status === 'CONFLICT' && to !== 'CONFLICT' && to !== 'PENDING') journal.setRefStatus(r, 'PENDING', { runId: this.runId });
      journal.setRefStatus(r, to, { newValue: newV, runId: this.runId });
    };

    for (const p of plans) {
      if (p.action === 'adopt') { mark(p.ref, 'UPDATED', newValue); }
      else if (p.action === 'conflict') {
        mark(p.ref, 'CONFLICT');
        conflicts++;
        this.d.logger.warn('ref.conflict', { collection: p.ref.collection, docId: p.ref.docId, path: p.ref.path }, { runId: this.runId, assetId: a.assetId });
      } else if (p.action === 'missing') {
        mark(p.ref, 'CONFLICT');
        conflicts++;
        this.d.logger.warn('ref.document-missing', { collection: p.ref.collection, docId: p.ref.docId }, { runId: this.runId, assetId: a.assetId });
      }
    }

    const writes = plans.filter((p) => p.action === 'write');
    const chunk = policy.mode === 'transaction' ? policy.batchSize : 1;
    for (let i = 0; i < writes.length; i += chunk) {
      const group = writes.slice(i, i + chunk);
      await this.fp.hit('db:before-intent');
      journal.tx(() => group.forEach((g) => mark(g.ref, 'UPDATING', newValue)));
      await this.fp.hit('db:after-intent');
      await this.fp.hit('db:before-write');
      const results = await this.dbTimed(() =>
        db.compareAndSet(
          group.map((g) => ({ collection: g.ref.collection, docId: g.ref.docId, ops: [{ path: g.ref.path, expected: g.ref.originalValue, next: newValue }] })),
          { transactional: policy.mode === 'transaction' },
        ),
      );
      await this.fp.hit('db:after-write');
      journal.tx(() => {
        results.forEach((res, k) => {
          const r = group[k].ref;
          if (res.ok) { mark(r, 'UPDATED', newValue); journal.addCounters(this.runId, { dbUpdates: 1 }); }
          else if (res.reason === 'aborted') { mark(r, 'PENDING'); }
          else { mark(r, 'CONFLICT'); conflicts++; }
        });
      });
      if (results.some((r) => !r.ok && r.reason === 'aborted')) throw new MediaMigrateError('transient', 'TX_ABORTED', 'transactional batch aborted; will retry');
    }
    journal.recordTiming(this.runId, 'database', performance.now() - t0);

    const left = journal.listRefs({ assetId: a.assetId, statuses: ['PENDING', 'UPDATING', 'CONFLICT'] });
    if (left.length > 0 || conflicts > 0) {
      return { kind: 'conflict', message: `${left.length} reference(s) could not be updated (concurrent modification or missing document); originals left untouched` };
    }
    return { kind: 'advance' };
  }

  private async dbTimed<T>(fn: () => Promise<T>): Promise<T> {
    const ms = this.d.cfg.migration.timeoutsMs.database;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new MediaMigrateError('transient', 'DB_TIMEOUT', `database operation timed out after ${ms}ms`)), ms); });
    try {
      return await Promise.race([fn(), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  // ───────────────────────── stage: cache ─────────────────────────

  private async stageCache(a: AssetRecord): Promise<StageResult> {
    const { journal, cache, cdn, cfg, resolver } = this.d;
    await this.fp.hit('cache:before');
    const failures: string[] = [];
    const variants = journal.listVariants(a.assetId);

    if (cfg.cache.verifyCdn && cdn) {
      let allOk = true;
      for (const v of variants) {
        const url = resolver.canonicalUrl(a.assetId, v.width);
        const r = await cdn.verify(url, { size: v.bytes });
        journal.recordCacheOp({ assetId: a.assetId, runId: this.runId, url, action: 'cdn-verify', status: r.ok ? 'CONFIRMED' : 'FAILED', detail: r.detail ?? `HTTP ${r.status}` });
        if (!r.ok) { allOk = false; failures.push(`cdn-verify ${url}: ${r.detail}`); }
      }
      journal.patchAsset(a.assetId, { cdnVerified: allOk }, this.runId);
    }

    let status: 'NOT_REQUIRED' | 'CONFIRMED' | 'FAILED' = 'NOT_REQUIRED';
    if (cfg.cache.purgeLegacyUrls) {
      const refs = journal.listRefs({ assetId: a.assetId, statuses: ['UPDATED'] });
      const urls = new Set<string>();
      for (const r of refs) urls.add(r.originalValue);
      const list = [...urls];
      if (list.length) {
        journal.setCacheStatus(a.assetId, 'REQUESTED');
        journal.addCounters(this.runId, { purgesRequested: list.length });
        const res = await cache.purge(list);
        for (const u of res.accepted) journal.recordCacheOp({ assetId: a.assetId, runId: this.runId, url: u, action: 'purge', status: 'CONFIRMED', detail: 'accepted by provider (does not imply browser/intermediary caches cleared)' });
        for (const r of res.rejected) {
          journal.recordCacheOp({ assetId: a.assetId, runId: this.runId, url: r.url, action: 'purge', status: 'FAILED', detail: r.reason });
          failures.push(`purge ${r.url}: ${r.reason}`);
        }
        status = res.rejected.length ? 'FAILED' : 'CONFIRMED';
      }
    }
    await this.fp.hit('cache:after');
    if (failures.length) {
      journal.setCacheStatus(a.assetId, 'FAILED');
      const msg = `cache operations failed: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? ` (+${failures.length - 3} more)` : ''}`;
      if (cfg.cache.onFailure === 'flag') {
        // left in REFERENCES_UPDATED with cache FAILED: visible, retryable, never COMPLETE
        journal.patchAsset(a.assetId, { cacheStatus: 'FAILED' }, this.runId);
        this.failed++;
        journal.recordFailure(a.assetId, this.runId, msg);
        return { kind: 'hold', message: msg };
      }
      throw new MediaMigrateError('permanent', 'CACHE_FAILED', msg);
    }
    journal.patchAsset(a.assetId, { cacheStatus: status }, this.runId);
    return { kind: 'advance' };
  }

  // ───────────────────────── postconditions (I7) ─────────────────────────

  private assertPostconditions(a: AssetRecord): void {
    const { journal } = this.d;
    const cur = journal.getAsset(a.assetId)!;
    const variants = journal.listVariants(a.assetId);
    const problems: string[] = [];
    if (variants.length !== this.profiles().length || variants.some((v) => !v.verified)) problems.push('variants not all verified');
    const refs = journal.listRefs({ assetId: a.assetId });
    if (refs.length === 0) problems.push('asset has no references');
    if (refs.some((r) => r.status !== 'UPDATED')) problems.push(`references not all UPDATED (${refs.filter((r) => r.status !== 'UPDATED').map((r) => r.status).join(',')})`);
    if (!['NOT_REQUIRED', 'CONFIRMED'].includes(cur.cacheStatus)) problems.push(`cache status is ${cur.cacheStatus}`);
    if (problems.length) throw new IntegrityError('POSTCONDITION_FAILED', `cannot complete ${a.assetId}: ${problems.join('; ')}`);
  }

  // ───────────────────────── dry-run ─────────────────────────

  private async dryRunSample(opts: RunOptions): Promise<void> {
    const { journal, source, dest, processor, cfg } = this.d;
    const limit = opts.limit ?? 20;
    const dir = path.join(this.d.paths.reportDir, this.runId, 'samples');
    fs.mkdirSync(dir, { recursive: true });
    // Prefer not-yet-processed assets; top up with already-staged ones so a dry run after `process` still has a sample and can
    // confirm that the objects in storage are exactly what the current settings would produce.
    const planned = journal.listAssets({ states: ['PLANNED'], limit });
    if (planned.length < limit) {
      planned.push(...journal.listAssets({ states: ['ASSETS_WRITTEN', 'DESTINATION_VERIFIED', 'REFERENCES_UPDATED', 'CACHE_HANDLED', 'COMPLETE'], limit: limit - planned.length }));
    }
    let predictedBytes = 0;
    const sem = new Semaphore(Math.max(1, Math.min(cfg.processing.concurrency, 8)));
    await Promise.all(planned.map((a) => sem.run(async () => {
      if (this.stopping()) return;
      const tmp = makeTempDir(this.d.paths.tempDir);
      try {
        const got = await source.get(a.sourceKey);
        const srcFile = path.join(tmp, 'source.bin');
        await pipeline(got.body, fs.createWriteStream(srcFile));
        const probe = await processor.probe(srcFile, this.limits());
        const sampleDir = path.join(dir, a.assetId);
        fs.mkdirSync(sampleDir, { recursive: true });
        fs.copyFileSync(srcFile, path.join(sampleDir, `source.${probe.format === 'jpeg' ? 'jpg' : probe.format}`));
        const variants: Array<Record<string, unknown>> = [];
        for (const p of this.profiles()) {
          const out = path.join(sampleDir, `${p.width}.${p.format}`);
          const gen = await processor.generate(srcFile, probe, this.spec(p, probe.animated), out, this.limits());
          await processor.validate(out, { maxWidth: p.width, format: p.format, mime: `image/${p.format}` });
          const key = this.destKey(a.assetId, p);
          const exists = await dest.head(key);
          predictedBytes += gen.bytes;
          variants.push({ width: p.width, effectiveWidth: gen.width, bytes: gen.bytes, key, destinationExists: !!exists, destinationMatches: !!exists && exists.metadata.sha256 === gen.sha256 && exists.size === gen.bytes });
        }
        const refs = journal.listRefs({ assetId: a.assetId });
        journal.appendEvent({
          runId: this.runId, assetId: a.assetId, level: 'info', type: 'dryrun.asset',
          detail: {
            sourceKey: a.sourceKey, sourceBytes: got.head.size, sourceWidth: probe.width, sourceHeight: probe.height, format: probe.format, variants,
            referenceChanges: refs.map((r) => ({ collection: r.collection, docId: r.docId, path: r.path, from: r.originalValue, to: this.d.resolver.canonicalUrl(a.assetId, cfg.destination.referenceVariantWidth) })),
          },
        });
      } catch (e) {
        if (e instanceof MediaMigrateError && e.kind === 'safety') throw e;
        journal.appendEvent({ runId: this.runId, assetId: a.assetId, level: 'warn', type: 'dryrun.asset-error', detail: { error: errorMessage(e) } });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    })));
    journal.save(this.runId, 'dryrun:summary', { sampled: planned.length, predictedVariantBytes: predictedBytes, samplesDir: dir });
  }

  // ───────────────────────── finalisation ─────────────────────────

  private finalize(kind: RunKindForEngine, interrupted: boolean): RunResult {
    const { journal } = this.d;
    const byState = journal.countByState();
    const all = journal.listAssets();
    const scope = this.partialScope && kind !== 'inventory' ? all.filter((x) => this.claimedIds.has(x.assetId)) : all;
    const target = kind === 'process' ? new Set(['DESTINATION_VERIFIED', 'REFERENCES_UPDATED', 'CACHE_HANDLED', 'COMPLETE', 'SKIPPED']) : new Set(['COMPLETE', 'SKIPPED', 'ROLLED_BACK']);
    const unfinished = kind === 'inventory' || kind === 'dry-run' ? [] : scope.filter((x) => !target.has(x.state));
    const refConflicts = journal.listRefs({ statuses: ['CONFLICT'] }).length;
    const counts: Record<string, number> = {};
    for (const s of scope) counts[s.state] = (counts[s.state] ?? 0) + 1;
    const summary: Record<string, unknown> = {
      kind, scope: this.partialScope ? 'partial' : 'full', assets: scope.length, byState: counts, totalByState: byState, unfinished: unfinished.length,
      refConflicts, inventory: this.stats, thresholdTripped: this.thresholdTripped,
      tempPeakBytes: this.budget.peak, rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
    };

    let status: RunResult['status'];
    let message: string;
    let blocking: string | null = null;
    if (this.lockLost) {
      status = 'INTERRUPTED'; message = 'lost the migration lock; run aborted'; blocking = message;
    } else if (this.thresholdTripped) {
      status = 'FAILED'; message = `aborted: ${this.thresholdTripped}`; blocking = message;
    } else if (interrupted) {
      status = 'INTERRUPTED'; message = `interrupted (${this.shutdown.reason ?? 'stop requested'}); progress is saved, resume with --resume --run-id ${this.runId}`;
    } else if (kind === 'dry-run') {
      status = 'DRY_RUN_COMPLETE'; message = 'dry run complete: no production mutations were performed';
    } else if (unfinished.length > 0 || refConflicts > 0) {
      status = 'INCOMPLETE';
      const worst = unfinished.find((u) => u.lastError)?.lastError;
      message = `${unfinished.length} asset(s) not finished, ${refConflicts} reference conflict(s)${worst ? `; e.g. ${worst}` : ''}`;
      blocking = worst ?? null;
    } else {
      status = 'COMPLETE';
      message = scope.length === 0 ? 'nothing to migrate' : `${kind === 'inventory' ? 'inventory' : kind} complete${this.partialScope ? ' (PARTIAL SCOPE: not a full migration)' : ''}`;
    }

    const finishedAt = new Date().toISOString();
    journal.updateRun(this.runId, { status, finishedAt, blockingError: blocking });
    journal.save(this.runId, 'phase', { phase: 'finished' });
    journal.save(this.runId, 'summary', summary);
    this.emitProgress(true);
    this.d.reporter.emit({ ts: finishedAt, runId: this.runId, type: 'run.finished', status, message });
    this.d.logger.info('run.finished', { status, message }, { runId: this.runId });

    const exitCode =
      status === 'COMPLETE' || status === 'DRY_RUN_COMPLETE' ? ExitCode.OK : status === 'INTERRUPTED' ? ExitCode.INTERRUPTED : status === 'INCOMPLETE' ? ExitCode.INCOMPLETE : ExitCode.OPERATIONAL;
    return { runId: this.runId, status, exitCode, message, summary };
  }

  // ───────────────────────── liveness, ticks, progress ─────────────────────────

  private stopping(): boolean {
    return this.shutdown.requested;
  }

  private assertAlive(): void {
    if (this.crashed) throw this.crashed; // a "dead" process does no further work
  }

  private startTimer(): void {
    const ms = this.d.timerMs ?? 5000;
    if (ms > 0) {
      this.timer = setInterval(() => this.tick(), ms);
      this.timer.unref();
    }
  }
  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Heartbeat, stop-request poll, periodic checkpoint and throttled progress. Safe to call any time. */
  tick(): void {
    if (this.crashed || !this.lock) return;
    const { journal, cfg } = this.d;
    try {
      journal.refreshLock(this.lock);
      const run = journal.getRun(this.runId);
      if (run?.stopRequested && !this.shutdown.requested) this.shutdown.request('stop-requested');
    } catch (e) {
      if (e instanceof MediaMigrateError && e.code === 'LOCK_LOST') {
        this.lockLost = true;
        this.shutdown.request('lock-lost');
        this.lock = null;
        return;
      }
      throw e;
    }
    const now = Date.now();
    if (now - this.lastCheckpoint >= cfg.migration.checkpointIntervalSec * 1000) {
      this.lastCheckpoint = now;
      journal.save(this.runId, 'checkpoint', { counts: journal.countByState(), claimed: this.claimed, failed: this.failed });
      this.checkpointsTaken++;
      if (cfg.migration.journalBackups > 0 && this.d.paths.journalDir && journal.constructor.name === 'SqliteJournal') {
        try {
          journal.backupTo(path.join(this.d.paths.journalDir, 'backups', `journal-${this.checkpointsTaken % cfg.migration.journalBackups}.sqlite`));
        } catch (e) {
          this.d.logger.warn('journal.backup-failed', { error: errorMessage(e) }, { runId: this.runId });
        }
      }
    }
    this.emitProgress(false);
  }

  private emitProgress(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < this.d.cfg.observability.summaryIntervalSec * 1000) return;
    this.lastEmit = now;
    const run = this.d.journal.getRun(this.runId);
    if (!run) return;
    const p = computeProgress(this.d.journal, run);
    this.d.reporter.emit({ ...p, ts: new Date().toISOString(), type: 'progress' });
  }
}

export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
