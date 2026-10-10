/** Core domain types shared by every module. No imports from other layers. */

export const ASSET_STATES = [
  'DISCOVERED',
  'PLANNED',
  'PROCESSING',
  'ASSETS_WRITTEN',
  'DESTINATION_VERIFIED',
  'REFERENCES_UPDATED',
  'CACHE_HANDLED',
  'COMPLETE',
  'FAILED',
  'SKIPPED',
  'SOURCE_MISSING',
  'CONFLICT',
  'ROLLED_BACK',
  'RECONCILE_REQUIRED',
] as const;
export type AssetState = (typeof ASSET_STATES)[number];

export const RUN_STATUSES = [
  'CREATED',
  'RUNNING',
  'COMPLETE',
  'INCOMPLETE',
  'FAILED',
  'INTERRUPTED',
  'DRY_RUN_COMPLETE',
  'ROLLED_BACK',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunKind = 'inventory' | 'dry-run' | 'process' | 'migrate' | 'rollback' | 'verify' | 'reconcile';

export type RefStatus =
  | 'PENDING' // discovered, not yet written
  | 'UPDATING' // intent journaled; outcome unknown until observed
  | 'UPDATED'
  | 'CONFLICT' // document changed concurrently; never overwritten
  | 'ROLLED_BACK'
  | 'ROLLBACK_CONFLICT';

export type CacheOpStatus = 'NOT_REQUIRED' | 'PENDING' | 'REQUESTED' | 'CONFIRMED' | 'FAILED';

/** Concrete location of one media reference inside the database. */
export interface RefLocation {
  collection: string;
  /** Provider-serialised document id (e.g. `oid:<hex>` or `str:<id>`). */
  docId: string;
  /** Concrete dotted path, arrays as numeric segments: `photos.2`, `homeSections.categories.0.image`. */
  path: string;
}

export interface VariantRecord {
  assetId: string;
  profile: string; // e.g. "w800-webp"
  width: number; // nominal (profile) width
  effectiveWidth: number; // actual pixels (never upscaled)
  height: number;
  format: string;
  key: string;
  bytes: number;
  sha256: string;
  verified: boolean;
  processingVersion: string;
}

export interface AssetRecord {
  assetId: string;
  sourceProvider: string;
  sourceBucket: string;
  sourceKey: string;
  sourceUrl: string | null;
  sourceSha256: string | null;
  sourceBytes: number | null;
  sourceMime: string | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  mediaType: 'image' | 'video' | 'other';
  state: AssetState;
  attempts: number;
  lastError: string | null;
  skipReason: string | null;
  runId: string | null; // last run that touched it
  cacheStatus: CacheOpStatus;
  cdnVerified: boolean;
  processingVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RefRecord extends RefLocation {
  assetId: string;
  originalValue: string;
  newValue: string | null;
  status: RefStatus;
  runId: string | null;
  updatedAt: string;
}

export interface RunRecord {
  runId: string;
  kind: RunKind;
  status: RunStatus;
  configFingerprint: string;
  dryRun: boolean;
  pid: number | null;
  host: string | null;
  startedAt: string;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  stopRequested: boolean;
  blockingError: string | null;
  params: Record<string, unknown>;
}

export interface EventRecord {
  id: number;
  ts: string;
  runId: string | null;
  assetId: string | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  type: string;
  detail: Record<string, unknown>;
}

export interface OrphanRecord {
  key: string;
  bytes: number;
  reason: string;
  runId: string | null;
  discoveredAt: string;
}

export interface Counters {
  bytesRead: number;
  bytesWritten: number;
  dbUpdates: number;
  retries: number;
  purgesRequested: number;
}
