import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { expandAll } from '../database/paths';
import { computeProgress } from '../observability/progress';
import type { World } from './harness';

/**
 * Executable safety invariants (I1, I5, I7, I9, I11, I15 + journal integrity), checked against REAL state:
 * the database, the object store and the journal — never against what the engine claims.
 */
export async function checkInvariants(w: World, opts: { expectNoTemp?: boolean } = {}): Promise<string[]> {
  const bad: string[] = [];
  const j = w.journal;
  const cfg = w.cfg;
  const resolver = w.resolver ?? w.engine().d.resolver;

  // journal-level integrity (includes I1 at the journal level)
  const ic = j.integrityCheck();
  if (!ic.ok) bad.push(...ic.messages.map((m) => `journal: ${m}`));

  // I1 + I5: every canonical value actually present in the database
  const refs = j.listRefs({});
  for (const coll of cfg.database.collections) {
    for (const doc of w.db.allDocs(coll.name)) {
      for (const f of expandAll(doc, coll.fields)) {
        const c = resolver.classify(f.value);
        if (c.kind !== 'canonical') continue;
        const asset = j.getAsset(c.assetId);
        if (!asset) { bad.push(`I1: ${coll.name}/${doc._id}/${f.path} points to unknown asset ${c.assetId}`); continue; }
        const vs = j.listVariants(c.assetId);
        if (vs.length === 0 || vs.some((v) => !v.verified)) bad.push(`I1: ${coll.name}/${doc._id}/${f.path} points to asset ${c.assetId} with unverified variants`);
        for (const v of vs) {
          const o = w.storage.objects.get(v.key);
          if (!o) bad.push(`I1: variant object missing in storage: ${v.key}`);
          else if (createHash('sha256').update(o.data).digest('hex') !== v.sha256) bad.push(`I1: variant bytes do not match journal checksum: ${v.key}`);
        }
        const ref = refs.find((r) => r.collection === coll.name && r.docId === `str:${doc._id}` && r.path === f.path);
        if (!ref) bad.push(`I5: ${coll.name}/${doc._id}/${f.path} was rewritten but has no journal reference record`);
        else if (ref.status !== 'UPDATED' && ref.status !== 'UPDATING') bad.push(`I5: ${coll.name}/${doc._id}/${f.path} holds canonical value but journal says ${ref.status}`);
        else if (!ref.runId) bad.push(`I5: reference ${f.path} has no run attribution`);
      }
    }
  }

  // I7: COMPLETE assets satisfy every postcondition
  for (const a of j.listAssets({ states: ['COMPLETE'] })) {
    const vs = j.listVariants(a.assetId);
    const rs = j.listRefs({ assetId: a.assetId });
    if (vs.length !== cfg.processing.widths.length || vs.some((v) => !v.verified)) bad.push(`I7: ${a.assetId} COMPLETE without all verified variants`);
    if (rs.length === 0 || rs.some((r) => r.status !== 'UPDATED')) bad.push(`I7: ${a.assetId} COMPLETE with non-UPDATED references`);
    if (!['NOT_REQUIRED', 'CONFIRMED'].includes(a.cacheStatus)) bad.push(`I7: ${a.assetId} COMPLETE with cache status ${a.cacheStatus}`);
  }

  // I9: originals remain (every asset that is not skipped-as-missing)
  for (const a of j.listAssets()) {
    if (a.state === 'SOURCE_MISSING' || a.state === 'DISCOVERED') continue;
    const o = w.storage.objects.get(a.sourceKey);
    if (!o) bad.push(`I9: original missing for ${a.assetId} (${a.sourceKey})`);
    else if (a.sourceSha256 && createHash('sha256').update(o.data).digest('hex') !== a.sourceSha256) bad.push(`I9: original changed for ${a.assetId}`);
  }

  // I11: no temp leftovers
  if (opts.expectNoTemp !== false) {
    const tmp = path.join(w.dir, 'tmp');
    if (fs.existsSync(tmp) && fs.readdirSync(tmp).length > 0) bad.push(`I11: temp directory not cleaned: ${fs.readdirSync(tmp).join(',')}`);
  }

  // I15: progress equals durable state
  const run = j.listRuns(1)[0];
  if (run) {
    const p = computeProgress(j, run);
    const bs = j.countByState();
    if (p.total !== Object.values(bs).reduce((x, y) => x + y, 0)) bad.push('I15: progress total != journal total');
    if (p.completed !== (bs.COMPLETE ?? 0)) bad.push('I15: progress completed != journal COMPLETE count');
    if (p.failed !== (bs.FAILED ?? 0)) bad.push('I15: progress failed != journal FAILED count');
  }
  return bad;
}

export async function assertInvariants(w: World, opts: { expectNoTemp?: boolean } = {}): Promise<void> {
  const bad = await checkInvariants(w, opts);
  if (bad.length) throw new Error(`invariant violations:\n - ${bad.join('\n - ')}`);
}
