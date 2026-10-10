import type { JournalStore } from '../core/interfaces';
import type { AssetState, RunRecord } from '../domain/types';

export interface ProgressSnapshot {
  runId: string;
  kind: string;
  status: string;
  dryRun: boolean;
  phase: string;
  /** Total assets in the journal (known only after inventory). */
  total: number;
  totalKnown: boolean;
  byState: Record<string, number>;
  queued: number;
  running: number;
  completed: number;
  skipped: number;
  failed: number;
  conflicts: number;
  retried: number;
  verifiedDestinations: number;
  dbUpdates: number;
  refs: Record<string, number>;
  orphans: number;
  cache: Record<string, number>;
  bytesRead: number;
  bytesWritten: number;
  throughputBytesPerSec: number | null;
  elapsedSec: number;
  etaSec: number | null;
  percent: number | null;
  lastCheckpoint: { name: string; ts: string } | null;
  blockingError: string | null;
  lockHolder: string | null;
  heartbeatAgeSec: number | null;
}

const VERIFIED: ReadonlySet<AssetState> = new Set(['DESTINATION_VERIFIED', 'REFERENCES_UPDATED', 'CACHE_HANDLED', 'COMPLETE']);
const QUEUED: ReadonlySet<AssetState> = new Set(['DISCOVERED', 'PLANNED']);
const INFLIGHT: ReadonlySet<AssetState> = new Set(['PROCESSING', 'ASSETS_WRITTEN', 'DESTINATION_VERIFIED', 'REFERENCES_UPDATED', 'CACHE_HANDLED']);

/**
 * Progress is a pure function of durable journal state (+ wall clock for elapsed/heartbeat).
 * Percent/ETA are null unless the denominator is genuinely known (inventory complete) and meaningful.
 */
export function computeProgress(journal: JournalStore, run: RunRecord, now: Date = new Date()): ProgressSnapshot {
  const byState = journal.countByState();
  const total = Object.values(byState).reduce((a, b) => a + b, 0);
  const n = (...s: AssetState[]) => s.reduce((a, k) => a + (byState[k] ?? 0), 0);
  const counters = journal.counters(run.runId);
  const phaseCp = journal.latest(run.runId, 'phase');
  const phase = (phaseCp?.data.phase as string) ?? 'unknown';
  const invDone = !['unknown', 'starting', 'inventory'].includes(phase);
  const refs: Record<string, number> = {};
  for (const r of journal.listRefs({})) refs[r.status] = (refs[r.status] ?? 0) + 1;
  const cache: Record<string, number> = {};
  for (const a of journal.listAssets()) cache[a.cacheStatus] = (cache[a.cacheStatus] ?? 0) + 1;

  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now.getTime();
  const elapsedSec = Math.max(0, (end - start) / 1000);
  const done = n('COMPLETE') + n('SKIPPED');
  const settled = done + n('FAILED', 'CONFLICT', 'SOURCE_MISSING', 'ROLLED_BACK');
  const completedThisRun = journal.events(run.runId, { limit: 100000 }).filter((e) => e.type === 'asset.transition' && (e.detail.to === 'COMPLETE' || e.detail.to === 'DESTINATION_VERIFIED')).length;
  const totalKnown = invDone && total > 0;
  const remaining = total - settled;
  let etaSec: number | null = null;
  if (run.status === 'RUNNING' && totalKnown && completedThisRun >= 3 && elapsedSec >= 2 && remaining > 0) {
    etaSec = remaining / (completedThisRun / elapsedSec);
  }
  const lock = journal.inspectLock();
  return {
    runId: run.runId, kind: run.kind, status: run.status, dryRun: run.dryRun, phase,
    total, totalKnown, byState,
    queued: [...QUEUED].reduce((a, s) => a + (byState[s] ?? 0), 0),
    running: run.status === 'RUNNING' ? [...INFLIGHT].reduce((a, s) => a + (byState[s] ?? 0), 0) : 0,
    completed: n('COMPLETE'), skipped: n('SKIPPED'), failed: n('FAILED'), conflicts: n('CONFLICT') + (refs.CONFLICT ?? 0),
    retried: counters.retries,
    verifiedDestinations: [...VERIFIED].reduce((a, s) => a + (byState[s] ?? 0), 0),
    dbUpdates: counters.dbUpdates, refs, orphans: journal.listOrphans().length, cache,
    bytesRead: counters.bytesRead, bytesWritten: counters.bytesWritten,
    throughputBytesPerSec: elapsedSec > 0 && counters.bytesRead + counters.bytesWritten > 0 ? (counters.bytesRead + counters.bytesWritten) / elapsedSec : null,
    elapsedSec, etaSec,
    percent: totalKnown ? (done / total) * 100 : null,
    lastCheckpoint: (() => { const c = journal.latestAny(run.runId); return c ? { name: c.name, ts: c.ts } : null; })(),
    blockingError: run.blockingError,
    lockHolder: lock?.runId ?? null,
    heartbeatAgeSec: run.lastHeartbeatAt ? Math.max(0, (now.getTime() - Date.parse(run.lastHeartbeatAt)) / 1000) : null,
  };
}

