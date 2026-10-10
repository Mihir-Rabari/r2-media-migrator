/**
 * Provider interfaces. The migration engine depends ONLY on these (plus domain types).
 * Adapters (S3/R2, MongoDB, sharp, Cloudflare, SQLite) live in their own modules.
 */
import type { Readable } from 'node:stream';
import type {
  AssetRecord, AssetState, CacheOpStatus, Counters, EventRecord, OrphanRecord, RefRecord, RefStatus, RunRecord, VariantRecord, RefLocation,
} from '../domain/types';

// ───────────────────────── Storage ─────────────────────────

export interface ObjectHead {
  key: string;
  size: number;
  etag?: string;
  contentType?: string;
  cacheControl?: string;
  /** User metadata (lower-case keys). `sha256` is set on every object we write. */
  metadata: Record<string, string>;
  lastModified?: Date;
}

export interface PutOptions {
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  /** Required for stream bodies. */
  contentLength?: number;
  /** Create-only: fail with MediaMigrateError(conflict, EXISTS) if the key already exists. */
  ifNoneMatch?: boolean;
}

export interface GetOptions {
  range?: { start: number; end?: number };
  signal?: AbortSignal;
}

export interface ListPage {
  objects: Array<{ key: string; size: number; lastModified?: Date }>;
  nextCursor?: string;
}

export interface StorageProvider {
  readonly kind: string;
  readonly bucket: string;
  head(key: string): Promise<ObjectHead | null>;
  /** Throws MediaMigrateError(not-found) when absent. */
  get(key: string, opts?: GetOptions): Promise<{ head: ObjectHead; body: Readable; range?: { start: number; end: number; total: number } }>;
  put(key: string, body: Buffer | Readable, opts: PutOptions): Promise<ObjectHead>;
  delete(key: string): Promise<void>;
  list(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<ListPage>;
  /** Public URL for a key on this provider's configured public base. */
  publicUrl(key: string): string;
}

// ───────────────────────── Database ─────────────────────────

export interface DbRefValue {
  docId: string;
  path: string;
  value: string;
}

export interface DbScanOptions {
  collection: string;
  /** Field patterns: `photo`, `photos[]`, `a.b[].c`. */
  fields: readonly string[];
  batchSize: number;
  timestampField?: string;
  since?: Date;
  until?: Date;
  /** Resume cursor (provider-specific, opaque). */
  afterId?: string;
}

export interface DbScanBatch {
  refs: DbRefValue[];
  lastDocId: string | null;
  docsScanned: number;
}

export interface CasOp {
  path: string;
  expected: string;
  next: string;
}
export interface CasItem extends Pick<RefLocation, 'collection' | 'docId'> {
  ops: CasOp[];
}
export type CasResult =
  | { ok: true }
  | { ok: false; reason: 'conflict' | 'missing' | 'aborted'; actual?: Record<string, unknown> };

export interface DbCapabilities {
  transactions: boolean;
  reason: string;
}

export interface DatabaseProvider {
  readonly kind: string;
  capabilities(): Promise<DbCapabilities>;
  scan(opts: DbScanOptions): AsyncIterable<DbScanBatch>;
  /** Read current values at concrete paths. `null` when the document does not exist. */
  readValues(collection: string, docId: string, paths: readonly string[]): Promise<Record<string, unknown> | null>;
  /**
   * Atomically (per document) set `next` only if every `expected` still matches.
   * With `transactional`, the whole batch is all-or-nothing (requires capabilities().transactions).
   */
  compareAndSet(items: readonly CasItem[], opts: { transactional: boolean }): Promise<CasResult[]>;
  sample(collection: string, n: number): Promise<unknown[]>;
  close(): Promise<void>;
}

// ───────────────────────── Processing ─────────────────────────

export interface ProbeResult {
  mime: string;
  format: string; // sharp format name
  width: number;
  height: number;
  animated: boolean;
  pages: number;
  hasAlpha: boolean;
  orientation?: number;
  hasIcc: boolean;
  colorspace?: string;
}

export interface ProcessLimits {
  maxPixels: number;
  maxFileBytes: number;
}

export interface VariantSpec {
  width: number;
  format: 'webp' | 'avif' | 'jpeg' | 'png';
  quality: number;
  effort: number;
  metadata: 'strip' | 'keep-icc' | 'keep-all';
  animated: boolean;
  lossless?: boolean;
}

export interface GeneratedVariant {
  filePath: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  mime: string;
  format: string;
}

export interface MediaProcessor {
  readonly version: string;
  probe(filePath: string, limits: ProcessLimits): Promise<ProbeResult>;
  generate(filePath: string, probe: ProbeResult, spec: VariantSpec, outPath: string, limits: ProcessLimits): Promise<GeneratedVariant>;
  /** Re-open the produced file and confirm it decodes with the expected properties. */
  validate(filePath: string, expect: { maxWidth: number; format: string; mime: string }): Promise<ProbeResult>;
}

// ───────────────────────── Journal / manifest / checkpoints ─────────────────────────

export interface LockHandle {
  readonly token: string;
  readonly runId: string;
}

export interface LockInfo {
  runId: string;
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export type EventInput = Omit<EventRecord, 'id' | 'ts'> & { ts?: string };

export interface MigrationJournal {
  createRun(run: RunRecord): void;
  getRun(runId: string): RunRecord | null;
  listRuns(limit?: number): RunRecord[];
  updateRun(runId: string, patch: Partial<Omit<RunRecord, 'runId'>>): void;
  requestStop(runId: string): void;
  appendEvent(e: EventInput): number;
  events(runId: string | null, opts?: { limit?: number; level?: EventRecord['level']; afterId?: number; assetId?: string }): EventRecord[];
  addCounters(runId: string, delta: Partial<Counters>): void;
  counters(runId: string): Counters;
  recordTiming(runId: string, phase: string, ms: number): void;
  timings(runId: string): Record<string, { count: number; totalMs: number; maxMs: number }>;
  acquireLock(runId: string, opts: { staleAfterMs: number; pid: number; host: string; isPidAlive: (pid: number) => boolean }): LockHandle;
  refreshLock(handle: LockHandle): void;
  releaseLock(handle: LockHandle): void;
  inspectLock(): LockInfo | null;
  /** Quick structural/integrity check of the journal itself. */
  integrityCheck(): { ok: boolean; messages: string[] };
}

export interface AssetQuery {
  states?: readonly AssetState[];
  limit?: number;
  afterId?: string;
}

export interface TransitionOptions {
  runId: string | null;
  error?: string | null;
  patch?: Partial<Pick<AssetRecord,
    'sourceSha256' | 'sourceBytes' | 'sourceMime' | 'sourceWidth' | 'sourceHeight' | 'skipReason' | 'cacheStatus' | 'cdnVerified' | 'processingVersion' | 'mediaType' | 'lastError'>>;
  detail?: Record<string, unknown>;
  incrementAttempts?: boolean;
  resetAttempts?: boolean;
}

export interface AssetManifestRepository {
  /** Insert if new. Returns the stored record (existing or new). */
  upsertDiscovered(a: Omit<AssetRecord, 'state' | 'attempts' | 'lastError' | 'skipReason' | 'cacheStatus' | 'cdnVerified' | 'processingVersion' | 'createdAt' | 'updatedAt' | 'runId'>, runId: string): AssetRecord;
  getAsset(assetId: string): AssetRecord | null;
  listAssets(q?: AssetQuery): AssetRecord[];
  countByState(): Record<string, number>;
  transition(assetId: string, to: AssetState, opts: TransitionOptions): AssetRecord;
  /** Update descriptive fields without changing state (audited). */
  patchAsset(assetId: string, patch: NonNullable<TransitionOptions['patch']>, runId: string | null): void;
  /** Record a failed attempt without changing state; returns new attempt count. */
  recordFailure(assetId: string, runId: string, error: string): number;
  /** Atomically claim the next asset in one of `states`. Safe across processes. */
  claimNext(runId: string, workerId: string, states: readonly AssetState[], leaseMs: number): AssetRecord | null;
  releaseClaim(assetId: string, workerId: string): void;
  clearClaims(): number;
  upsertVariant(v: VariantRecord): void;
  listVariants(assetId: string): VariantRecord[];
  upsertRef(r: Omit<RefRecord, 'updatedAt'>): RefRecord;
  getRef(loc: RefLocation): RefRecord | null;
  listRefs(q: { assetId?: string; statuses?: readonly RefStatus[]; runId?: string; limit?: number }): RefRecord[];
  setRefStatus(loc: RefLocation, to: RefStatus, patch: { newValue?: string | null; runId?: string | null }): RefRecord;
  recordOrphan(o: OrphanRecord): void;
  listOrphans(): OrphanRecord[];
  clearOrphan(key: string): void;
  setCacheStatus(assetId: string, status: CacheOpStatus): void;
  recordCacheOp(op: { assetId: string; runId: string; url: string; action: 'cdn-verify' | 'purge'; status: CacheOpStatus; detail?: string }): void;
  listCacheOps(runId?: string): Array<{ assetId: string; runId: string; url: string; action: string; status: string; detail: string | null; ts: string }>;
  duplicateGroups(): Array<{ sha256: string; assetIds: string[] }>;
}

export interface CheckpointStore {
  save(runId: string, name: string, data: Record<string, unknown>): void;
  latest(runId: string, name: string): { ts: string; data: Record<string, unknown> } | null;
  latestAny(runId: string): { name: string; ts: string; data: Record<string, unknown> } | null;
}

/** Everything the SQLite journal provides. */
export interface JournalStore extends MigrationJournal, AssetManifestRepository, CheckpointStore {
  /** Run `fn` inside one atomic journal transaction (synchronous work only). */
  tx<T>(fn: () => T): T;
  backupTo(dest: string): void;
  close(): void;
}

// ───────────────────────── Cache ─────────────────────────

export interface PurgeResult {
  ok: boolean;
  /** Provider acknowledged the request. Never implies browser/intermediary caches were cleared. */
  accepted: string[];
  rejected: Array<{ url: string; reason: string }>;
}

export interface CacheInvalidationProvider {
  readonly kind: string;
  /** Per-URL purge only. Implementations must refuse wildcards / zone-wide targets. */
  purge(urls: readonly string[]): Promise<PurgeResult>;
}

export interface CdnVerifier {
  /** HEAD-check a public URL: true only on 2xx with the expected content-length when provided. */
  verify(url: string, expect: { size?: number }): Promise<{ ok: boolean; status: number; detail?: string }>;
}

// ───────────────────────── Progress / config ─────────────────────────

export interface ProgressEvent {
  ts: string;
  runId: string;
  type: string;
  [k: string]: unknown;
}
export interface ProgressReporter {
  emit(e: ProgressEvent): void;
  close?(): void;
}

export interface ConfigurationProvider<T> {
  load(): Promise<T>;
}
