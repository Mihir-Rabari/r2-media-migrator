import { createHash } from 'node:crypto';
import type { EngineDeps } from './context';
import { ExitCode } from '../domain/errors';
import { newRunId } from '../domain/ids';
import { mapLimit } from '../core/limits';
import { readOnlyDatabase, readOnlyStorage } from '../core/guards';
import { os_hostname, defaultPidAlive } from './util';

export interface Issue {
  type:
    | 'destination-missing' | 'destination-corrupt' | 'source-missing' | 'reference-adoptable' | 'reference-reverted' | 'reference-diverged'
    | 'reference-document-missing' | 'orphan-object' | 'journal-integrity' | 'verification-pending' | 'canonical-unknown-asset' | 'canonical-unverified-asset';
  assetId?: string;
  detail: string;
  fixable: boolean;
  fixed: boolean;
}

export interface ReconcileReport {
  runId: string;
  issues: Issue[];
  orphans: number;
  checkedAssets: number;
  checkedRefs: number;
  ok: boolean;
  exitCode: number;
}

/**
 * Compare journal, object store and database and classify every disagreement (I14).
 * Read-only by default; `fix` applies only conservative repairs:
 *   - adopt a reference whose database value already equals the intended new value (crash after DB write)
 *   - re-queue an asset whose destination objects vanished (it will be regenerated, never "assumed")
 * Orphans are RECORDED, never deleted.
 */
export async function reconcile(deps: EngineDeps, opts: { fix: boolean; deep?: boolean }): Promise<ReconcileReport> {
  const { journal, cfg, resolver } = deps;
  const fix = opts.fix && !deps.dryRun;
  const dest = fix ? deps.dest : readOnlyStorage(deps.dest);
  const db = fix ? deps.db : readOnlyDatabase(deps.db);
  const runId = newRunId();
  const host = deps.host ?? os_hostname();
  const pid = deps.pid ?? process.pid;
  journal.createRun({
    runId, kind: 'reconcile', status: 'RUNNING', configFingerprint: deps.configFingerprint, dryRun: !fix, pid, host, startedAt: new Date().toISOString(),
    finishedAt: null, lastHeartbeatAt: new Date().toISOString(), stopRequested: false, blockingError: null, params: { fix },
  });
  const lock = journal.acquireLock(runId, { staleAfterMs: cfg.migration.lockStaleSec * 1000, pid, host, isPidAlive: deps.isPidAlive ?? defaultPidAlive });
  const issues: Issue[] = [];
  const push = (i: Omit<Issue, 'fixed'> & { fixed?: boolean }) => issues.push({ fixed: false, ...i });
  try {
    const ic = journal.integrityCheck();
    for (const m of ic.messages) push({ type: 'journal-integrity', detail: m, fixable: false });

    const assets = journal.listAssets();
    const known = new Set<string>();
    // network-bound per-asset checks run with bounded parallelism (issues are sorted afterwards for stable output)
    await mapLimit(assets, 8, async (a) => {
      // originals must still exist (I9)
      if (!['DISCOVERED', 'SOURCE_MISSING', 'SKIPPED'].includes(a.state)) {
        const h = await deps.source.head(a.sourceKey);
        if (!h) push({ type: 'source-missing', assetId: a.assetId, detail: `original ${a.sourceKey} no longer exists`, fixable: false });
      }
      const vs = journal.listVariants(a.assetId);
      for (const v of vs) known.add(v.key);
      if (['ASSETS_WRITTEN', 'DESTINATION_VERIFIED', 'REFERENCES_UPDATED', 'CACHE_HANDLED', 'COMPLETE'].includes(a.state)) {
        let broken = false;
        for (const v of vs) {
          const h = await dest.head(v.key);
          if (!h) { push({ type: 'destination-missing', assetId: a.assetId, detail: `variant object missing: ${v.key}`, fixable: true }); broken = true; continue; }
          if (h.size !== v.bytes || h.metadata.sha256 !== v.sha256) { push({ type: 'destination-corrupt', assetId: a.assetId, detail: `size/checksum metadata differs: ${v.key}`, fixable: true }); broken = true; continue; }
          if (opts.deep) {
            const g = await dest.get(v.key);
            const hash = createHash('sha256');
            for await (const c of g.body) hash.update(c as Buffer);
            if (hash.digest('hex') !== v.sha256) { push({ type: 'destination-corrupt', assetId: a.assetId, detail: `content hash differs: ${v.key}`, fixable: true }); broken = true; }
          }
        }
        if (broken && fix) {
          // never keep trusting an asset whose destination is gone: send it back for regeneration (references may stay as-is until the next verify)
          journal.transition(a.assetId, 'RECONCILE_REQUIRED', { runId, error: 'destination objects missing or corrupt' });
          for (const v of vs) journal.upsertVariant({ ...v, verified: false });
          journal.transition(a.assetId, 'PLANNED', { runId, resetAttempts: true });
          for (const i of issues) if (i.assetId === a.assetId && i.fixable) i.fixed = true;
        }
      }
    });
    issues.sort((x, y) => (x.type + (x.assetId ?? '') + x.detail < y.type + (y.assetId ?? '') + y.detail ? -1 : 1));

    // references
    const refs = journal.listRefs({ statuses: ['PENDING', 'UPDATING', 'UPDATED', 'CONFLICT', 'ROLLBACK_CONFLICT'] });
    for (const r of refs) {
      const cur = await db.readValues(r.collection, r.docId, [r.path]);
      if (!cur) { push({ type: 'reference-document-missing', assetId: r.assetId, detail: `${r.collection}/${r.docId} no longer exists`, fixable: false }); continue; }
      const v = cur[r.path];
      const intended = r.newValue ?? resolver.canonicalUrl(r.assetId, cfg.destination.referenceVariantWidth);
      if (r.status === 'UPDATING' && v === intended) {
        push({ type: 'reference-adoptable', assetId: r.assetId, detail: `${r.collection}/${r.docId}/${r.path}: database already holds the new value (crash after write)`, fixable: true, fixed: fix });
        if (fix) journal.setRefStatus(r, 'UPDATED', { newValue: intended, runId });
      } else if (r.status === 'UPDATING' && v === r.originalValue) {
        push({ type: 'reference-adoptable', assetId: r.assetId, detail: `${r.collection}/${r.docId}/${r.path}: write never happened; will be retried`, fixable: true, fixed: fix });
        if (fix) journal.setRefStatus(r, 'PENDING', { runId });
      } else if (r.status === 'UPDATED' && v === r.originalValue) {
        push({ type: 'reference-reverted', assetId: r.assetId, detail: `${r.collection}/${r.docId}/${r.path}: reverted to the legacy value outside this tool`, fixable: true, fixed: fix });
        if (fix) journal.setRefStatus(r, 'ROLLED_BACK', { runId });
      } else if (r.status === 'UPDATED' && v !== r.newValue) {
        push({ type: 'reference-diverged', assetId: r.assetId, detail: `${r.collection}/${r.docId}/${r.path}: holds a value this tool never wrote`, fixable: false });
      }
    }

    // orphans: objects under our namespace that no variant record explains
    const prefix = `${cfg.destination.namespace}/${cfg.destination.namespaceVersion}/`;
    let cursor: string | undefined;
    let orphans = 0;
    do {
      const page = await deps.dest.list(prefix, { cursor, limit: 1000 });
      for (const o of page.objects) {
        if (!known.has(o.key)) {
          orphans++;
          push({ type: 'orphan-object', detail: `${o.key} (${o.size} bytes) not in manifest`, fixable: false });
          if (fix || !deps.dryRun) journal.recordOrphan({ key: o.key, bytes: o.size, reason: 'present in storage but not in manifest', runId, discoveredAt: new Date().toISOString() });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);

    const unresolved = issues.filter((i) => !i.fixed && i.type !== 'orphan-object');
    const report: ReconcileReport = {
      runId, issues, orphans, checkedAssets: assets.length, checkedRefs: refs.length, ok: unresolved.length === 0,
      exitCode: unresolved.length === 0 ? ExitCode.OK : ExitCode.VERIFICATION_INCOMPLETE,
    };
    journal.updateRun(runId, { status: report.ok ? 'COMPLETE' : 'INCOMPLETE', finishedAt: new Date().toISOString() });
    journal.save(runId, 'reconcile:summary', { ...report, issues: issues.slice(0, 500) } as unknown as Record<string, unknown>);
    return report;
  } catch (e) {
    journal.updateRun(runId, { status: 'FAILED', finishedAt: new Date().toISOString(), blockingError: (e as Error).message });
    throw e;
  } finally {
    journal.releaseLock(lock);
  }
}
