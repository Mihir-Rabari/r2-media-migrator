import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeWorld, seedCatalogue } from '../../src/testing/harness';
import { SqliteJournal } from '../../src/journal/sqliteJournal';
import { computeProgress } from '../../src/observability/progress';
import { buildReport, reportMarkdown, writeReportFiles, exportMapping, buildReviewArtifacts } from '../../src/reporting/report';
import { evaluateReadiness, writeAttestations } from '../../src/migration/readiness';
import { discoverMediaFields } from '../../src/inventory/discover';
import { fmtBytes } from '../../src/observability/logger';
import type { RunRecord } from '../../src/domain/types';

const run = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  runId: id, kind: 'migrate', status: 'RUNNING', configFingerprint: 'fp', dryRun: false, pid: 1, host: 'h', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null,
  lastHeartbeatAt: '2026-01-01T00:00:09.000Z', stopRequested: false, blockingError: null, params: {}, ...over,
});
const asset = (id: string, key = `k/${id}`) => ({ assetId: id, sourceProvider: 's3', sourceBucket: 'b', sourceKey: key, sourceUrl: null, sourceSha256: null, sourceBytes: 10, sourceMime: null, sourceWidth: null, sourceHeight: null, mediaType: 'image' as const });

test('progress: percent and ETA are null unless the denominator is known and the rate is meaningful (never fabricated)', () => {
  const j = new SqliteJournal(':memory:');
  j.createRun(run('r1', { kind: 'process' }));
  for (let i = 0; i < 10; i++) j.upsertDiscovered(asset(`a${i}`), 'r1');
  j.save('r1', 'phase', { phase: 'inventory' });
  let p = computeProgress(j, j.getRun('r1')!, new Date('2026-01-01T00:00:10Z'));
  assert.equal(p.totalKnown, false);
  assert.equal(p.percent, null);
  assert.equal(p.etaSec, null);
  j.save('r1', 'phase', { phase: 'migrate' });
  p = computeProgress(j, j.getRun('r1')!, new Date('2026-01-01T00:00:10Z'));
  assert.equal(p.totalKnown, true);
  assert.equal(p.percent, 0);
  assert.equal(p.etaSec, null, 'no completions yet: no ETA');
  // complete 4 of 10 over 10 s -> 6 remaining at 0.4/s -> 15 s
  for (let i = 0; i < 4; i++) {
    j.transition(`a${i}`, 'PLANNED', { runId: 'r1' });
    j.transition(`a${i}`, 'PROCESSING', { runId: 'r1' });
    j.transition(`a${i}`, 'ASSETS_WRITTEN', { runId: 'r1' });
    j.transition(`a${i}`, 'DESTINATION_VERIFIED', { runId: 'r1' });
  }
  p = computeProgress(j, j.getRun('r1')!, new Date('2026-01-01T00:00:10Z'));
  assert.ok(p.etaSec !== null && Math.abs(p.etaSec - 15) < 1, `eta ${p.etaSec}`);
  assert.equal(p.verifiedDestinations, 4);
  assert.equal(p.completed, 0, 'verified is not COMPLETE (process runs report them as finished work, not as completed assets)');
  // finished runs never show an ETA
  j.updateRun('r1', { status: 'COMPLETE', finishedAt: '2026-01-01T00:00:10.000Z' });
  assert.equal(computeProgress(j, j.getRun('r1')!).etaSec, null);
  j.close();
});

test('progress is derived from durable state: a freshly reopened journal yields the identical snapshot (I15)', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    const res = await w.engine().run('migrate');
    const a = computeProgress(w.journal, w.journal.getRun(res.runId)!, new Date('2030-01-01'));
    w.restart();
    const b = computeProgress(w.journal, w.journal.getRun(res.runId)!, new Date('2030-01-01'));
    assert.deepEqual(b, a);
    assert.equal(a.completed, 4);
    assert.equal(a.total, 4);
    assert.equal(a.percent, 100);
    assert.equal(a.dbUpdates, w.journal.listRefs({ statuses: ['UPDATED'] }).length);
    assert.ok(a.bytesRead > 0 && a.bytesWritten > 0);
    assert.ok(['phase', 'summary'].includes(a.lastCheckpoint!.name));
  } finally {
    w.cleanup();
  }
});

test('progress reporter emits phase events and periodic progress; final event states the real status', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 2);
    const res = await w.engine().run('migrate');
    const types = w.reporter.events.map((e) => e.type);
    assert.ok(types.includes('progress'));
    const fin = w.reporter.events.filter((e) => e.type === 'run.finished').pop() as any;
    assert.equal(fin.status, res.status);
    assert.equal(fin.runId, res.runId);
    for (const e of w.reporter.events) assert.ok(e.ts && e.runId);
  } finally {
    w.cleanup();
  }
});

test('report: states honestly what happened — dry run, partial scope, incomplete runs — and lists failures, timings, counters', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    w.storage.seed('x/broken.jpg', Buffer.from('not an image at all, just text'), 'image/jpeg');
    w.db.insert('products', 'broken', { photo: w.url('x/gone.jpg') });
    const dry = await w.engine({ dryRun: true }).run('dry-run', { limit: 2 });
    let r = buildReport(w.journal, dry.runId);
    assert.ok(r.honesty.some((h) => /DRY RUN: nothing was uploaded/.test(h)));
    assert.ok(r.honesty.some((h) => /PARTIAL SCOPE/.test(h)));

    const part = await w.engine().run('migrate', { limit: 2 });
    r = buildReport(w.journal, part.runId);
    assert.ok(r.honesty.some((h) => /PARTIAL SCOPE/.test(h)));

    const full = await w.engine().run('migrate');
    assert.equal(full.status, 'INCOMPLETE');
    r = buildReport(w.journal, full.runId);
    assert.ok(r.honesty.some((h) => /NOT a successful completed migration/.test(h)));
    assert.ok(r.failed.some((f) => f.state === 'SOURCE_MISSING' && /gone\.jpg/.test(f.sourceKey)));
    assert.ok(r.timings['download'] || r.timings['stage:process']);
    assert.ok(r.counters.bytesRead > 0);
    assert.equal(r.journalIntegrity.ok, true);
    const md = reportMarkdown(r);
    assert.match(md, /Failed \/ blocked assets/);
    assert.match(md, /INCOMPLETE/);
    const { dir, files } = writeReportFiles(w.journal, full.runId, path.join(w.dir, 'reports'));
    for (const f of files) assert.ok(fs.existsSync(f), f);
    const assets = fs.readFileSync(path.join(dir, 'assets.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(assets.length, w.journal.listAssets().length);
    // mapping export only contains verified assets
    const mapping = exportMapping(w.journal);
    assert.ok(mapping.every((m) => ['DESTINATION_VERIFIED', 'REFERENCES_UPDATED', 'CACHE_HANDLED', 'COMPLETE'].includes(m.state)));
    assert.ok(!mapping.some((m) => /gone\.jpg|broken/.test(m.sourceKey)));
  } finally {
    w.cleanup();
  }
});

test('review artifacts: contact sheet + HTML are generated for dry-run samples', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    const dry = await w.engine({ dryRun: true }).run('dry-run', { limit: 4 });
    const dir = path.join(w.dir, 'reports', dry.runId);
    const out = await buildReviewArtifacts(path.join(dir, 'samples'), dir, w.journal, dry.runId);
    assert.equal(out.count, 4);
    assert.ok(out.png && fs.statSync(out.png).size > 1000);
    const html = fs.readFileSync(out.html, 'utf8');
    assert.match(html, /Visual review/);
    assert.match(html, /% of source/);
    const sharp = (await import('sharp')).default;
    assert.ok((await sharp(out.png!).metadata()).width! >= 800);
  } finally {
    w.cleanup();
  }
});

test('readiness: production gates block until evidence + attestations exist, and attestations are bound to the config fingerprint', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 2);
    const journalDir = path.join(w.dir, 'journal');
    let rep = evaluateReadiness(w.journal, 'fp-1', journalDir);
    assert.equal(rep.ready, false);
    assert.ok(rep.gates.filter((g) => g.status === 'BLOCKED').length >= 8);

    const eng = w.engine();
    const fp = eng.d.configFingerprint;
    await eng.run('dry-run', { limit: 20 }).catch(() => undefined);
    await w.engine({ dryRun: true }).run('dry-run', { limit: 20 });
    await w.engine().run('process');
    await w.engine().run('inventory');
    rep = evaluateReadiness(w.journal, fp, journalDir);
    const auto = rep.gates.filter((g) => g.kind === 'automatic');
    assert.ok(auto.every((g) => g.status === 'PASS'), JSON.stringify(auto.filter((g) => g.status !== 'PASS')));
    assert.equal(rep.ready, false, 'attestations still missing');

    writeAttestations(journalDir, { configFingerprint: fp, automatedTestsPassed: true, rollbackTested: true, compatibilityTested: true, mappingReviewed: true, sampleReviewApproved: true, authorizedBy: 'Operator', authorizedAt: new Date().toISOString() });
    assert.equal(evaluateReadiness(w.journal, fp, journalDir).ready, true);
    // changing the configuration invalidates every attestation
    const other = evaluateReadiness(w.journal, 'different-fingerprint', journalDir);
    assert.equal(other.ready, false);
    assert.ok(other.gates.find((g) => g.id === 'authorization')!.detail.includes('different configuration'));
  } finally {
    w.cleanup();
  }
});

test('discover: suggests media-looking fields missing from the map and never reports mapped ones as unmapped', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    w.db.insert('products', 'extra', { videoThumb: 'https://other.example/clip.mp4', gallery: [{ src: w.url('products/p0.jpg') }], photo: w.url('products/p1.jpg') });
    const eng = w.engine();
    const found = await discoverMediaFields(eng.d.db, eng.d.resolver, [{ name: 'products', fields: ['photo', 'photos[]', 'hoverImage'] }], 50);
    const by = Object.fromEntries(found.map((f) => [f.pattern, f]));
    assert.equal(by['photo'].alreadyConfigured, true);
    assert.equal(by['photos[]'].alreadyConfigured, true);
    assert.equal(by['gallery[].src'].alreadyConfigured, false);
    assert.equal(by['customAttributes.note'].alreadyConfigured, false, 'unapproved field that holds a legacy URL is surfaced for review');
    assert.ok(by['videoThumb'].externalHits >= 1 && by['videoThumb'].legacyHostHits === 0);
    assert.equal(by['name'], undefined);
  } finally {
    w.cleanup();
  }
});

test('fmtBytes formats sizes', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(5 * 1024 ** 3), '5.0 GB');
});
