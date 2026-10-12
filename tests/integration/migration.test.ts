import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedCatalogue, NEW_BASE } from '../../src/testing/harness';
import { assertInvariants } from '../../src/testing/invariants';

test('migration: first run migrates every legacy reference, leaves external URLs and unapproved fields alone, and passes all invariants', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 4);
    const before = JSON.stringify(w.db.allDocs('products').map((d) => d.customAttributes));
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'COMPLETE', res.message);
    assert.equal(res.exitCode, 0);

    // every approved reference now points at a canonical, verified asset
    const p0 = w.db.getDoc('products', 'prod0');
    assert.match(p0.photo, new RegExp(`^${NEW_BASE}/media/v1/a[a-z2-7]{24}/400\\.webp$`));
    assert.equal(p0.photos.length, 2);
    assert.ok(p0.photos.every((u: string) => u.startsWith(NEW_BASE)));
    assert.ok(p0.hoverImage.startsWith(NEW_BASE), 'r2.dev legacy host is normalised too');

    // unapproved field and non-matching hosts untouched (I4, invariant 7 of the spec)
    assert.equal(JSON.stringify(w.db.allDocs('products').map((d) => d.customAttributes)), before);
    const s = w.db.getDoc('settings', 'site');
    assert.equal(s.logoImage, 'https://images.pexels.com/photos/1/third-party.jpeg');
    assert.equal(s.homeSections.categories[1].image, 'https://ik.imagekit.io/x/y.jpg');
    assert.ok(s.homeSections.categories[0].image.startsWith(NEW_BASE));
    assert.equal(p0.name, 'Product 0');
    assert.equal(p0.price, 100);

    // 5 distinct source images -> 5 assets x 3 variants in storage, originals still present (I9)
    const assets = w.journal.listAssets();
    assert.equal(assets.length, 5);
    assert.ok(assets.every((a) => a.state === 'COMPLETE'));
    const variantKeys = [...w.storage.objects.keys()].filter((k) => k.startsWith('media/v1/'));
    assert.equal(variantKeys.length, 15);
    assert.ok(w.storage.objects.has('products/p0.jpg'));
    // cache headers on immutable objects
    assert.equal(w.storage.objects.get(variantKeys[0])!.head.cacheControl, 'public, max-age=31536000, immutable');

    // every object records its deterministic idempotency key, asset id and checksum
    const meta = w.storage.objects.get(variantKeys[0])!.head.metadata;
    assert.match(meta['idempotency-key'], /^[0-9a-f]{32}$/);
    assert.match(meta['sha256'], /^[0-9a-f]{64}$/);
    assert.match(meta['asset-id'], /^a[a-z2-7]{24}$/);

    await assertInvariants(w);
  } finally {
    w.cleanup();
  }
});

test('migration: shared media (same image referenced many times / via two hosts) yields ONE asset and many references', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    await w.engine().run('migrate');
    const a = w.journal.listAssets().find((x) => x.sourceKey === 'products/p0.jpg')!;
    const refs = w.journal.listRefs({ assetId: a.assetId });
    assert.ok(refs.length >= 4, `expected several refs, got ${refs.length}`);
    assert.ok(refs.every((r) => r.status === 'UPDATED'));
  } finally {
    w.cleanup();
  }
});

test('migration: re-running a completed migration changes nothing (I3 idempotency)', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    const first = await w.engine().run('migrate');
    assert.equal(first.status, 'COMPLETE');
    const dbSnap = w.db.snapshot();
    const objSnap = JSON.stringify([...w.storage.objects].map(([k, o]) => [k, o.head.metadata.sha256, o.head.size]));
    const putsBefore = w.storage.mutations;
    const second = await w.engine().run('migrate');
    assert.equal(second.status, 'COMPLETE');
    assert.equal(w.db.snapshot(), dbSnap, 'database untouched');
    assert.equal(w.storage.mutations, putsBefore, 'no storage writes');
    assert.equal(JSON.stringify([...w.storage.objects].map(([k, o]) => [k, o.head.metadata.sha256, o.head.size])), objSnap);
    await assertInvariants(w);
  } finally {
    w.cleanup();
  }
});

test('migration: dry run performs zero mutations anywhere (I2) and records a sample report + review artifacts', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    const dbSnap = w.db.snapshot();
    const objs = w.storage.objects.size;
    const res = await w.engine({ dryRun: true }).run('dry-run', { limit: 3 });
    assert.equal(res.status, 'DRY_RUN_COMPLETE');
    assert.equal(w.db.snapshot(), dbSnap);
    assert.equal(w.storage.objects.size, objs);
    assert.equal(w.storage.mutations, 0);
    assert.equal(w.cache.calls, 0);
    const evts = w.journal.events(res.runId, { limit: 500 }).filter((e) => e.type === 'dryrun.asset');
    assert.equal(evts.length, 3);
    assert.ok((evts[0].detail.variants as unknown[]).length === 3);
    assert.ok((evts[0].detail.referenceChanges as unknown[]).length >= 1);
    // a later real run can proceed (dry run only planned)
    const real = await w.engine().run('migrate');
    assert.equal(real.status, 'COMPLETE');
  } finally {
    w.cleanup();
  }
});

test('migration: dry-run guard sits BELOW the engine — even a buggy stage that tries to write is blocked', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 2);
    const eng = w.engine({ dryRun: true });
    await assert.rejects(eng.d.dest.put('media/v1/x', Buffer.from('x'), { contentType: 'a/b' }), /dry-run/);
    await assert.rejects(eng.d.db.compareAndSet([], { transactional: false }), /dry-run/);
    await assert.rejects(eng.d.cache.purge(['https://x']), /dry-run/);
    await assert.rejects(eng.d.source.delete('products/p0.jpg'), /dry-run/);
    assert.equal(w.storage.mutations, 0);
  } finally {
    w.cleanup();
  }
});

test('migration: a dry run AFTER process still samples (staged assets) and confirms destination objects match what would be produced', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    await w.engine().run('process');
    const snap = w.db.snapshot();
    const puts = w.storage.mutations;
    const dry = await w.engine({ dryRun: true }).run('dry-run', { limit: 10 });
    assert.equal(dry.status, 'DRY_RUN_COMPLETE');
    const evs = w.journal.events(dry.runId, { limit: 500 }).filter((e) => e.type === 'dryrun.asset');
    assert.equal(evs.length, 4, 'all 4 staged assets sampled');
    for (const e of evs) for (const v of e.detail.variants as Array<{ destinationMatches: boolean }>) assert.equal(v.destinationMatches, true);
    assert.equal(w.db.snapshot(), snap);
    assert.equal(w.storage.mutations, puts);
  } finally {
    w.cleanup();
  }
});

test('config: flipping safety.allowProductionMutations does not change the semantic fingerprint', async () => {
  const { loadConfig } = await import('../../src/config/load');
  const { testConfig } = await import('../../src/testing/harness');
  const base = JSON.parse(JSON.stringify(testConfig()));
  const a = await loadConfig({ rawConfig: base, env: {}, requireSecrets: false });
  base.safety.allowProductionMutations = true;
  const b = await loadConfig({ rawConfig: base, env: {}, requireSecrets: false });
  assert.equal(a.configFingerprint, b.configFingerprint);
  base.safety.neverRewriteHosts = ['x.example.com'];
  const c = await loadConfig({ rawConfig: base, env: {}, requireSecrets: false });
  assert.notEqual(a.configFingerprint, c.configFingerprint);
});

test('migration: process stages assets (verified, no DB change); migrate then finishes without regenerating', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    const dbSnap = w.db.snapshot();
    const r1 = await w.engine().run('process');
    assert.equal(r1.status, 'COMPLETE');
    assert.equal(w.db.snapshot(), dbSnap, 'process never touches references');
    assert.ok(w.journal.listAssets().every((a) => a.state === 'DESTINATION_VERIFIED'));
    const writes = w.storage.mutations;
    const r2 = await w.engine().run('migrate');
    assert.equal(r2.status, 'COMPLETE');
    assert.equal(w.storage.mutations, writes, 'verified variants reused, not rewritten');
    assert.notEqual(w.db.snapshot(), dbSnap);
  } finally {
    w.cleanup();
  }
});

test('migration: missing source, video, svg, html-as-jpg and corrupt files are classified — never silently "migrated"', async () => {
  const w = makeWorld();
  try {
    const { svgFixture, htmlFixture, jpegFixture, truncated } = await import('../../src/testing/fixtures');
    w.storage.seed('a/ok.jpg', await jpegFixture(300, 200), 'image/jpeg');
    w.storage.seed('a/vector.svg', svgFixture(), 'image/svg+xml');
    w.storage.seed('a/soft404.jpg', htmlFixture(), 'image/jpeg');
    w.storage.seed('a/broken.jpg', truncated(await jpegFixture(600, 600, 1), 0.3), 'image/jpeg');
    w.storage.seed('a/clip.mp4', Buffer.from('0000ftypmp42'), 'video/mp4');
    w.db.insert('products', 'x', { photo: w.url('a/ok.jpg'), photos: [w.url('a/vector.svg'), w.url('a/soft404.jpg'), w.url('a/broken.jpg'), w.url('a/clip.mp4'), w.url('a/gone.jpg')] });
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'INCOMPLETE', 'broken + missing assets must make the run incomplete');
    const st = Object.fromEntries(w.journal.listAssets().map((a) => [a.sourceKey, a.state]));
    assert.equal(st['a/ok.jpg'], 'COMPLETE');
    assert.equal(st['a/vector.svg'], 'SKIPPED');
    assert.equal(st['a/soft404.jpg'], 'SKIPPED');
    assert.equal(st['a/clip.mp4'], 'SKIPPED');
    assert.equal(st['a/broken.jpg'], 'FAILED');
    assert.equal(st['a/gone.jpg'], 'SOURCE_MISSING');
    const doc = w.db.getDoc('products', 'x');
    assert.ok(doc.photo.startsWith(NEW_BASE));
    assert.equal(doc.photos[0], w.url('a/vector.svg'), 'skipped/failed refs keep their original values');
    assert.equal(doc.photos[2], w.url('a/broken.jpg'));
    assert.equal(doc.photos[4], w.url('a/gone.jpg'));
    await assertInvariants(w);
  } finally {
    w.cleanup();
  }
});

test('migration: duplicate content under different keys is reported as a duplicate group but keeps separate identities', async () => {
  const w = makeWorld();
  try {
    const { jpegFixture } = await import('../../src/testing/fixtures');
    const b = await jpegFixture(300, 200, 9);
    w.storage.seed('d/one.jpg', b, 'image/jpeg');
    w.storage.seed('d/two.jpg', b, 'image/jpeg');
    w.db.insert('products', 'x', { photo: w.url('d/one.jpg'), photos: [w.url('d/two.jpg')] });
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'COMPLETE');
    const groups = w.journal.duplicateGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].assetIds.length, 2);
    const doc = w.db.getDoc('products', 'x');
    assert.notEqual(doc.photo, doc.photos[0]);
  } finally {
    w.cleanup();
  }
});

test('migration: scoped runs report PARTIAL SCOPE and --limit bounds the work', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 4);
    const res = await w.engine().run('migrate', { limit: 2 });
    assert.match(res.message, /PARTIAL SCOPE/);
    assert.equal(w.journal.listAssets().filter((a) => a.state === 'COMPLETE').length, 2);
    assert.equal(res.summary.scope, 'partial');
  } finally {
    w.cleanup();
  }
});

test('migration: --since/--until restrict the scan by the configured timestamp field', async () => {
  const w = makeWorld();
  try {
    const { jpegFixture } = await import('../../src/testing/fixtures');
    w.storage.seed('t/old.jpg', await jpegFixture(200, 100, 1), 'image/jpeg');
    w.storage.seed('t/new.jpg', await jpegFixture(200, 100, 2), 'image/jpeg');
    w.db.insert('products', 'old', { photo: w.url('t/old.jpg'), updatedAt: '2025-01-01T00:00:00.000Z' });
    w.db.insert('products', 'new', { photo: w.url('t/new.jpg'), updatedAt: '2026-06-01T00:00:00.000Z' });
    await w.engine().run('inventory', { since: new Date('2026-01-01') });
    assert.deepEqual(w.journal.listAssets().map((a) => a.sourceKey), ['t/new.jpg']);
  } finally {
    w.cleanup();
  }
});
