import { createHash } from 'node:crypto';
import type { EngineDeps } from './context';
import { ExitCode } from '../domain/errors';
import { expandAll } from '../database/paths';
import { mapLimit } from '../core/limits';

export interface VerifyReport {
  ok: boolean;
  exitCode: number;
  assetsChecked: number;
  incomplete: number;
  violations: string[];
  warnings: string[];
  canonicalReferencesChecked: number;
  unknownCanonical: number;
  legacyRemaining: number;
}

/**
 * Read-only verification against REAL state:
 *  - each finished asset: all variants present with the journalled size+sha256 (re-hashed when mode=full)
 *  - each UPDATED reference still holds the value we wrote (drift is reported)
 *  - originals still exist (I9)
 *  - every canonical-looking value in approved DB fields maps to a verified asset (I1) — scanned from the DB, not the journal
 * `ok` is false whenever anything is unproven; incomplete migrations are never "verified".
 */
export async function verify(deps: EngineDeps, opts: { sample?: number; concurrency?: number } = {}): Promise<VerifyReport> {
  const { journal, dest, source, db, cfg, resolver } = deps;
  const violations: string[] = [];
  const warnings: string[] = [];
  let incomplete = 0;
  let checked = 0;
  const assets = journal.listAssets();
  const target = opts.sample ? assets.slice(0, opts.sample) : assets;
  // Per-asset checks are network-bound (HEAD/GET per variant): run a bounded number in parallel.
  await mapLimit(target, opts.concurrency ?? 8, async (a) => {
    if (a.state === 'SKIPPED' || a.state === 'ROLLED_BACK') return;
    if (a.state !== 'COMPLETE') { incomplete++; warnings.push(`asset ${a.assetId} (${a.sourceKey}) is ${a.state}, not COMPLETE`); return; }
    checked++;
    if (!(await source.head(a.sourceKey))) violations.push(`I9: original missing for ${a.assetId} (${a.sourceKey})`);
    const vs = journal.listVariants(a.assetId);
    if (vs.length !== cfg.processing.widths.length) violations.push(`${a.assetId}: expected ${cfg.processing.widths.length} variants, found ${vs.length}`);
    for (const v of vs) {
      const h = await dest.head(v.key);
      if (!h) { violations.push(`${a.assetId}: destination object missing ${v.key}`); continue; }
      if (h.size !== v.bytes) { violations.push(`${a.assetId}: size mismatch ${v.key}`); continue; }
      if (cfg.migration.verification.mode === 'full') {
        const g = await dest.get(v.key);
        const hash = createHash('sha256');
        for await (const c of g.body) hash.update(c as Buffer);
        if (hash.digest('hex') !== v.sha256) violations.push(`${a.assetId}: content hash mismatch ${v.key}`);
      } else if (h.metadata.sha256 !== v.sha256) violations.push(`${a.assetId}: checksum metadata mismatch ${v.key}`);
    }
    for (const r of journal.listRefs({ assetId: a.assetId })) {
      const cur = await db.readValues(r.collection, r.docId, [r.path]);
      if (!cur) { violations.push(`${r.collection}/${r.docId} missing`); continue; }
      if (r.status === 'UPDATED' && cur[r.path] !== r.newValue) warnings.push(`drift: ${r.collection}/${r.docId}/${r.path} no longer holds the migrated value`);
    }
  });
  violations.sort();
  warnings.sort();

  // I1 from the database side
  let canonicalChecked = 0;
  let unknown = 0;
  let legacyRemaining = 0;
  for (const coll of cfg.database.collections) {
    for await (const batch of db.scan({ collection: coll.name, fields: coll.fields, batchSize: cfg.migration.batchSize })) {
      for (const r of batch.refs) {
        const c = resolver.classify(r.value);
        if (c.kind === 'legacy') {
          const la = journal.getAsset(c.assetId);
          if (!la || la.state !== 'SKIPPED') legacyRemaining++; // un-migrated and not an explicit policy skip
        }
        if (c.kind !== 'canonical') continue;
        canonicalChecked++;
        const a = journal.getAsset(c.assetId);
        const vs = a ? journal.listVariants(c.assetId) : [];
        if (!a || vs.length === 0 || vs.some((v) => !v.verified)) {
          unknown++;
          violations.push(`I1: ${coll.name}/${r.docId}/${r.path} points to ${c.assetId}, which has no verified destination`);
        } else if (!vs.some((v) => v.width === c.width)) {
          violations.push(`I1: ${coll.name}/${r.docId}/${r.path} points to width ${c.width} which was never generated`);
        }
      }
    }
  }
  if (legacyRemaining > 0) warnings.push(`${legacyRemaining} legacy reference(s) remain in approved fields (not migrated, failed or conflicting): migration is not complete`);

  const ok = violations.length === 0 && incomplete === 0 && legacyRemaining === 0;
  return {
    ok, exitCode: ok ? ExitCode.OK : ExitCode.VERIFICATION_INCOMPLETE, assetsChecked: checked, incomplete, violations, warnings,
    canonicalReferencesChecked: canonicalChecked, unknownCanonical: unknown, legacyRemaining,
  };
}

void expandAll;
