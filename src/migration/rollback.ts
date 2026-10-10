import type { EngineDeps } from './context';
import type { RefRecord } from '../domain/types';
import { newRunId } from '../domain/ids';
import { ExitCode, safetyError, validationError } from '../domain/errors';
import { readOnlyDatabase } from '../core/guards';
import { os_hostname, defaultPidAlive } from './util';

export interface RollbackOptions {
  /** Roll back only references last written by this run (default: every UPDATED reference). */
  fromRunId?: string;
  assetIds?: readonly string[];
  dryRun: boolean;
  /** Explicit operator confirmation (required for real rollbacks). */
  confirmed: boolean;
  limit?: number;
}

export interface RollbackResult {
  runId: string;
  exitCode: number;
  planned: number;
  rolledBack: number;
  alreadyOriginal: number;
  conflicts: Array<{ collection: string; docId: string; path: string; expected: string; actual: unknown }>;
  failed: number;
  assetsRolledBack: number;
}

/**
 * Restore the exact previous value of every UPDATED reference — but ONLY if the field still holds the value we
 * wrote (compare-and-set on `newValue`). A field edited since is a ROLLBACK_CONFLICT and is never overwritten (I13).
 * Destination objects and originals are left in place; they are reported as orphans for reconciliation.
 */
export async function rollback(deps: EngineDeps, opts: RollbackOptions): Promise<RollbackResult> {
  const { journal, cfg } = deps;
  if (!opts.dryRun) {
    if (!opts.confirmed) throw safetyError('CONFIRMATION_REQUIRED', 'rollback modifies the database: re-run with --yes to confirm');
    if (cfg.environment === 'production' && !cfg.safety.allowProductionMutations) throw safetyError('PRODUCTION_BLOCKED', 'safety.allowProductionMutations is false');
  }
  if (opts.fromRunId && !journal.getRun(opts.fromRunId)) throw validationError('NO_SUCH_RUN', `unknown run ${opts.fromRunId}`);
  const db = opts.dryRun ? readOnlyDatabase(deps.db) : deps.db;

  const runId = newRunId();
  const host = deps.host ?? os_hostname();
  const pid = deps.pid ?? process.pid;
  journal.createRun({
    runId, kind: 'rollback', status: 'RUNNING', configFingerprint: deps.configFingerprint, dryRun: opts.dryRun, pid, host, startedAt: new Date().toISOString(),
    finishedAt: null, lastHeartbeatAt: new Date().toISOString(), stopRequested: false, blockingError: null,
    params: { fromRunId: opts.fromRunId ?? null, assetIds: opts.assetIds ?? null },
  });
  const lock = journal.acquireLock(runId, { staleAfterMs: cfg.migration.lockStaleSec * 1000, pid, host, isPidAlive: deps.isPidAlive ?? defaultPidAlive });
  const res: RollbackResult = { runId, exitCode: ExitCode.OK, planned: 0, rolledBack: 0, alreadyOriginal: 0, conflicts: [], failed: 0, assetsRolledBack: 0 };
  try {
    let refs: RefRecord[] = journal.listRefs({ statuses: ['UPDATED', 'UPDATING', 'ROLLBACK_CONFLICT'], runId: opts.fromRunId });
    if (opts.assetIds) {
      const s = new Set(opts.assetIds);
      refs = refs.filter((r) => s.has(r.assetId));
    }
    if (opts.limit) refs = refs.slice(0, opts.limit);
    res.planned = refs.length;
    const touched = new Set<string>();
    for (const r of refs) {
      touched.add(r.assetId);
      const cur = await db.readValues(r.collection, r.docId, [r.path]);
      const v = cur ? cur[r.path] : undefined;
      if (opts.dryRun) {
        if (v === r.newValue) res.rolledBack++;
        else if (v === r.originalValue) res.alreadyOriginal++;
        else res.conflicts.push({ collection: r.collection, docId: r.docId, path: r.path, expected: String(r.newValue), actual: v });
        continue;
      }
      if (v === r.originalValue) {
        // already restored (by us before a crash, or by a human): record, do not write
        journal.setRefStatus(r, r.status === 'UPDATING' ? 'PENDING' : 'ROLLED_BACK', { runId });
        res.alreadyOriginal++;
        continue;
      }
      if (v !== r.newValue || r.newValue === null) {
        if (r.status !== 'ROLLBACK_CONFLICT') {
          if (r.status === 'UPDATING') journal.setRefStatus(r, 'CONFLICT', { runId });
          else journal.setRefStatus(r, 'ROLLBACK_CONFLICT', { runId });
        }
        res.conflicts.push({ collection: r.collection, docId: r.docId, path: r.path, expected: String(r.newValue), actual: v });
        continue;
      }
      const [out] = await db.compareAndSet([{ collection: r.collection, docId: r.docId, ops: [{ path: r.path, expected: r.newValue, next: r.originalValue }] }], { transactional: false });
      if (out.ok) {
        journal.setRefStatus(r, 'ROLLED_BACK', { runId });
        res.rolledBack++;
        journal.addCounters(runId, { dbUpdates: 1 });
      } else {
        // changed between our read and our write: conflict, never overwrite
        if (r.status !== 'ROLLBACK_CONFLICT') journal.setRefStatus(r, 'ROLLBACK_CONFLICT', { runId });
        res.conflicts.push({ collection: r.collection, docId: r.docId, path: r.path, expected: String(r.newValue), actual: out.ok ? undefined : (out as { actual?: Record<string, unknown> }).actual?.[r.path] });
      }
    }
    if (!opts.dryRun) {
      for (const assetId of touched) {
        const all = journal.listRefs({ assetId });
        const a = journal.getAsset(assetId)!;
        const done = all.length > 0 && all.every((x) => x.status === 'ROLLED_BACK');
        const stuck = all.some((x) => x.status === 'ROLLBACK_CONFLICT');
        if (done && a.state !== 'ROLLED_BACK') {
          journal.transition(assetId, 'ROLLED_BACK', { runId });
          res.assetsRolledBack++;
          for (const v of journal.listVariants(assetId)) journal.recordOrphan({ key: v.key, bytes: v.bytes, reason: 'asset-rolled-back (kept; delete only after reviewing)', runId, discoveredAt: new Date().toISOString() });
        } else if (stuck && a.state !== 'RECONCILE_REQUIRED' && a.state !== 'ROLLED_BACK') {
          try { journal.transition(assetId, 'RECONCILE_REQUIRED', { runId, error: 'rollback conflict: reference edited after migration' }); } catch { /* state does not allow; ref status already records it */ }
        }
      }
    }
    res.exitCode = res.conflicts.length > 0 || res.failed > 0 ? ExitCode.ROLLBACK_FAILED : ExitCode.OK;
    journal.updateRun(runId, { status: opts.dryRun ? 'DRY_RUN_COMPLETE' : res.exitCode === ExitCode.OK ? 'ROLLED_BACK' : 'INCOMPLETE', finishedAt: new Date().toISOString(), blockingError: res.conflicts.length ? `${res.conflicts.length} rollback conflict(s)` : null });
    journal.save(runId, 'rollback:summary', res as unknown as Record<string, unknown>);
    return res;
  } catch (e) {
    journal.updateRun(runId, { status: 'FAILED', finishedAt: new Date().toISOString(), blockingError: (e as Error).message });
    throw e;
  } finally {
    journal.releaseLock(lock);
  }
}
