import type { EngineDeps, InventoryStats, RunOptions } from '../migration/context';
import { emptyStats } from '../migration/context';
import { mediaTypeFromMime, mimeFromKey } from '../processing/mime';
import { isRetryable, MediaMigrateError } from '../domain/errors';
import { withRetry } from '../core/retry';

/**
 * Scan every configured collection for approved media fields, classify each value, and journal
 * (asset, reference) pairs for legacy URLs. External / unknown-host / canonical values are only COUNTED —
 * they are never recorded as migratable references (invariant I4).
 * Resumable: a cursor checkpoint is saved after every batch.
 */
export async function inventoryDatabase(
  deps: EngineDeps,
  runId: string,
  opts: RunOptions,
  shouldStop: () => boolean,
): Promise<InventoryStats> {
  const { journal, db, resolver, cfg, logger } = deps;
  const prior = journal.latest(runId, 'inventory:stats');
  const stats: InventoryStats = prior ? (prior.data as unknown as InventoryStats) : emptyStats();
  const batchSize = opts.batchSize ?? cfg.migration.batchSize;

  for (const coll of cfg.database.collections) {
    if (journal.latest(runId, `inventory:done:${coll.name}`)) continue;
    const cursor = journal.latest(runId, `inventory:cursor:${coll.name}`);
    const scan = db.scan({
      collection: coll.name,
      fields: coll.fields,
      batchSize,
      timestampField: coll.timestampField,
      since: opts.since,
      until: opts.until,
      afterId: (cursor?.data.afterId as string | undefined) ?? undefined,
    });
    for await (const batch of scan) {
      if (shouldStop()) return stats;
      stats.docsScanned += batch.docsScanned;
      journal.tx(() => {
        for (const r of batch.refs) {
          stats.refsSeen++;
          const c = resolver.classify(r.value);
          switch (c.kind) {
            case 'legacy': {
              stats.legacy++;
              stats.byCollection[coll.name] = (stats.byCollection[coll.name] ?? 0) + 1;
              const before = journal.getAsset(c.assetId);
              const asset = journal.upsertDiscovered(
                {
                  assetId: c.assetId, sourceProvider: deps.source.kind, sourceBucket: deps.source.bucket, sourceKey: c.key, sourceUrl: r.value,
                  sourceSha256: null, sourceBytes: null, sourceMime: null, sourceWidth: null, sourceHeight: null,
                  mediaType: mediaTypeFromMime(mimeFromKey(c.key)),
                },
                runId,
              );
              if (!before) stats.newAssets++;
              const existing = journal.getRef({ collection: coll.name, docId: r.docId, path: r.path });
              if (!existing) {
                journal.upsertRef({ collection: coll.name, docId: r.docId, path: r.path, assetId: c.assetId, originalValue: r.value, newValue: null, status: 'PENDING', runId });
                reopenIfNeeded(deps, runId, asset.assetId, stats);
              } else if (existing.status === 'ROLLED_BACK' && existing.originalValue === r.value) {
                // value is back to the legacy URL after a rollback: eligible to migrate again
                journal.setRefStatus(existing, 'PENDING', { runId });
                reopenIfNeeded(deps, runId, asset.assetId, stats);
              }
              break;
            }
            case 'canonical': stats.canonical++; break;
            case 'excluded': stats.excluded++; break;
            case 'invalid': stats.invalid++; break;
            case 'external': {
              const h = c.host ?? '(relative-or-opaque)';
              stats.external[h] = (stats.external[h] ?? 0) + 1;
              break;
            }
          }
        }
      });
      journal.save(runId, `inventory:cursor:${coll.name}`, { afterId: batch.lastDocId });
      journal.save(runId, 'inventory:stats', stats as unknown as Record<string, unknown>);
      logger.debug('inventory.batch', { collection: coll.name, refs: batch.refs.length }, { runId });
    }
    journal.save(runId, `inventory:done:${coll.name}`, { at: new Date().toISOString() });
  }
  journal.save(runId, 'inventory:stats', stats as unknown as Record<string, unknown>);
  journal.save(runId, 'inventory:complete', { at: new Date().toISOString() });
  return stats;
}

/** A finished/rolled-back asset gained a new pending reference: send it back through the reference stage. */
function reopenIfNeeded(deps: EngineDeps, runId: string, assetId: string, stats: InventoryStats): void {
  const a = deps.journal.getAsset(assetId)!;
  if (a.state === 'COMPLETE') {
    deps.journal.transition(assetId, 'RECONCILE_REQUIRED', { runId, detail: { reason: 'new-reference-found' } });
    deps.journal.transition(assetId, 'DESTINATION_VERIFIED', { runId, detail: { reason: 'new-reference-found' } });
    stats.reopened++;
  } else if (a.state === 'ROLLED_BACK') {
    deps.journal.transition(assetId, 'PLANNED', { runId, detail: { reason: 'reference-restored-after-rollback' }, resetAttempts: true });
    stats.reopened++;
  }
}

/**
 * Plan: HEAD each discovered source, classify (image / video / unsupported / too large / missing).
 * No downloads, no mutations except journal state.
 */
export async function planAssets(deps: EngineDeps, runId: string, opts: RunOptions, shouldStop: () => boolean): Promise<Record<string, number>> {
  const { journal, source, cfg } = deps;
  const summary: Record<string, number> = { planned: 0, skipped: 0, missing: 0, failed: 0 };
  const only = opts.assetIds ? new Set(opts.assetIds) : null;
  for (const a of journal.listAssets({ states: ['DISCOVERED'] })) {
    if (shouldStop()) break;
    if (only && !only.has(a.assetId)) continue;
    try {
      const head = await withRetry(() => source.head(a.sourceKey), toPolicy(deps), { sleep: deps.sleep, rand: deps.rand });
      if (!head) {
        journal.transition(a.assetId, 'SOURCE_MISSING', { runId, error: `source object not found: ${a.sourceKey}` });
        summary.missing++;
        continue;
      }
      const ctype = head.contentType?.split(';')[0].trim() ?? null;
      const mime = ctype && ctype !== 'application/octet-stream' ? ctype : mimeFromKey(a.sourceKey);
      const mt = mediaTypeFromMime(mime);
      const patch = { sourceBytes: head.size, sourceMime: mime, mediaType: mt } as const;
      if (mt === 'video') {
        journal.patchAsset(a.assetId, patch, runId);
        journal.transition(a.assetId, 'SKIPPED', { runId, patch: { skipReason: 'video-pipeline-not-enabled' } });
        summary.skipped++;
      } else if (mt !== 'image') {
        journal.patchAsset(a.assetId, patch, runId);
        journal.transition(a.assetId, 'SKIPPED', { runId, patch: { skipReason: `unsupported-type:${mime ?? 'unknown'}` } });
        summary.skipped++;
      } else if (head.size > cfg.processing.maxSourceBytes) {
        journal.patchAsset(a.assetId, patch, runId);
        journal.transition(a.assetId, 'SKIPPED', { runId, patch: { skipReason: `too-large:${head.size}` } });
        summary.skipped++;
      } else {
        journal.patchAsset(a.assetId, patch, runId);
        journal.transition(a.assetId, 'PLANNED', { runId });
        summary.planned++;
      }
    } catch (e) {
      if (e instanceof MediaMigrateError && e.kind === 'permanent') {
        journal.transition(a.assetId, 'FAILED', { runId, error: `plan: ${e.message}`, incrementAttempts: true });
        summary.failed++;
      } else if (isRetryable(e)) {
        journal.recordFailure(a.assetId, runId, `plan: ${(e as Error).message}`); // stays DISCOVERED; next run retries
        summary.failed++;
      } else throw e;
    }
  }
  return summary;
}

function toPolicy(deps: EngineDeps) {
  const r = deps.cfg.migration.retry;
  return { maxAttempts: r.maxAttempts, baseDelayMs: r.baseDelayMs, maxDelayMs: r.maxDelayMs, jitter: r.jitter };
}
