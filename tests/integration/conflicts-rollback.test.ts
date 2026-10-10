import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeWorld, seedCatalogue, NEW_BASE } from '../../src/testing/harness';
import { checkInvariants } from '../../src/testing/invariants';
import { rollback } from '../../src/migration/rollback';
import { reconcile } from '../../src/migration/reconcile';
import { verify } from '../../src/migration/verify';
import { jpegFixture } from '../../src/testing/fixtures';
import { FakeCache } from '../../src/cache/providers';

// ───────────── concurrent modification (I6) ─────────────

test('conflict: a document edited between observation and write is detected (CAS) and the user edit is preserved', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedCatalogue(w, 2);
    w.failpoints.on('db:before-write', (n) => {
      if (n === 1) w.db.edit('products', 'prod0', (d) => { d.photo = 'https://cdn.legacy.test/products/USER-EDIT.jpg'; });
    });
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'INCOMPLETE');
    const doc = w.db.getDoc('products', 'prod0');
    // The first processed asset may be any; find whichever doc has the user's value and make sure it was NOT overwritten
    const edited = w.db.allDocs('products').filter((d) => d.photo.includes('USER-EDIT'));
    assert.ok(edited.length <= 1);
    const conflicted = w.journal.listRefs({ statuses: ['CONFLICT'] });
    assert.ok(conflicted.length >= 1, 'conflict recorded');
    void doc;
    assert.deepEqual(await checkInvariants(w), []);
    assert.ok(w.journal.listAssets().some((a) => a.state === 'CONFLICT'));
    // every conflicting ref keeps the value that was in the database at conflict time
    for (const c of conflicted) {
      const cur = await w.db.readValues(c.collection, c.docId, [c.path]);
      assert.notEqual(cur![c.path], w.resolver.canonicalUrl(c.assetId, 400), 'conflicting reference was not overwritten');
    }
  } finally {
    w.cleanup();
  }
});

test('conflict: edit before the reference stage is detected by observation (value is neither old nor new)', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedCatalogue(w, 1);
    w.failpoints.on('transition:after:DESTINATION_VERIFIED', (n) => {
      if (n === 1) w.db.edit('products', 'prod0', (d) => { d.hoverImage = 'https://elsewhere.example/new-hover.jpg'; });
    });
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'INCOMPLETE');
    assert.equal(w.db.getDoc('products', 'prod0').hoverImage, 'https://elsewhere.example/new-hover.jpg');
  } finally {
    w.cleanup();
  }
});

test('conflict: a conflicting asset can be re-run after the operator fixes the data (retry re-observes)', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedCatalogue(w, 1);
    let first = true;
    w.failpoints.on('db:before-write', () => {
      if (first) { first = false; w.db.edit('products', 'prod0', (d) => { d.photo = 'https://elsewhere.example/x.jpg'; }); }
    });
    const r1 = await w.engine().run('migrate');
    assert.equal(r1.status, 'INCOMPLETE');
    // operator restores the legacy value, then re-arms conflicting assets
    w.db.edit('products', 'prod0', (d) => { d.photo = w.url('products/p0.jpg'); });
    const a = w.journal.listAssets({ states: ['CONFLICT'] });
    assert.ok(a.length >= 1);
    for (const x of a) w.journal.transition(x.assetId, 'PLANNED', { runId: r1.runId, resetAttempts: true });
    const r2 = await w.engine().run('migrate');
    assert.equal(r2.status, 'COMPLETE', r2.message);
    assert.deepEqual(await checkInvariants(w), []);
  } finally {
    w.cleanup();
  }
});

// ───────────── destination integrity ─────────────

test('integrity: corrupted destination bytes (same size & metadata) are caught by full verification, removed, regenerated', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedCatalogue(w, 1);
    let corrupted = false;
    w.failpoints.on('verify:before', () => {
      if (corrupted) return;
      corrupted = true;
      const k = [...w.storage.objects.keys()].find((x) => x.startsWith('media/v1/'))!;
      const o = w.storage.objects.get(k)!;
      const bad = Buffer.from(o.data);
      bad[bad.length - 1] ^= 0xff; // flip a byte; size and sha256 metadata unchanged
      o.data = bad;
    });
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'COMPLETE', res.message);
    assert.deepEqual(await checkInvariants(w), []);
    assert.ok(w.journal.events(res.runId, { limit: 5000 }).some((e) => e.type === 'verify.removed-corrupt-object'));
  } finally {
    w.cleanup();
  }
});

test('integrity: a foreign object occupying a destination key is never overwritten -> CONFLICT', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedCatalogue(w, 1);
    const eng = w.engine();
    await eng.run('inventory');
    const a = w.journal.listAssets().find((x) => x.sourceKey === 'products/p0.jpg')!;
    const key = `media/v1/${a.assetId}/100.webp`;
    w.storage.seed(key, Buffer.from('somebody else was here'), 'text/plain');
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'INCOMPLETE');
    assert.equal(w.journal.getAsset(a.assetId)!.state, 'CONFLICT');
    assert.equal(w.storage.objects.get(key)!.data.toString(), 'somebody else was here');
    assert.match(w.journal.getAsset(a.assetId)!.lastError!, /refusing to overwrite|occupied/);
    assert.ok(w.db.getDoc('products', 'prod0').photo.includes('legacy'), 'database untouched');
  } finally {
    w.cleanup();
  }
});

test('integrity: source content that changes between attempts is flagged (source-changed), not silently re-migrated', async () => {
  const w = makeWorld({ processing: { concurrency: 1 }, migration: { retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0, maxItemAttempts: 10 } } });
  try {
    await seedCatalogue(w, 1);
    w.failpoints.arm('upload:before', { mode: 'error', times: 100 });
    await w.engine().run('migrate');
    const a = w.journal.listAssets().find((x) => x.sourceSha256)!;
    assert.ok(a, 'a first attempt recorded the source hash');
    w.storage.seed(a.sourceKey, await jpegFixture(640, 400, 77), 'image/jpeg'); // someone replaced the original
    w.failpoints.disarmAll();
    w.journal.transition(a.assetId, 'PLANNED', { runId: w.journal.listRuns(1)[0].runId, resetAttempts: true });
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'INCOMPLETE');
    assert.equal(w.journal.getAsset(a.assetId)!.state, 'CONFLICT');
    assert.match(w.journal.getAsset(a.assetId)!.lastError!, /source content changed/);
  } finally {
    w.cleanup();
  }
});

// ───────────── cache (I8) ─────────────

test('cache: a failed purge is visible, classified, keeps the run INCOMPLETE; references stay migrated; retry completes', async () => {
  const w = makeWorld({ processing: { concurrency: 1 }, cache: { provider: 'cloudflare', zoneIdEnv: 'Z', apiTokenEnv: 'T', purgeLegacyUrls: true, onFailure: 'flag' } });
  try {
    await seedCatalogue(w, 2);
    w.cache.behaviour = () => 'rate limited by provider';
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'INCOMPLETE');
    assert.equal(w.journal.listAssets({ states: ['COMPLETE'] }).length, 0, 'no asset may be COMPLETE with a failed purge');
    assert.ok(w.journal.listAssets().every((a) => a.cacheStatus === 'FAILED'));
    assert.ok(w.journal.listCacheOps(res.runId).some((o) => o.status === 'FAILED' && o.action === 'purge'));
    assert.equal(w.db.getDoc('products', 'prod0').photo.startsWith(NEW_BASE), true, 'references are already migrated');
    // provider recovers; resume the same run
    w.cache.behaviour = () => undefined;
    w.restart();
    const res2 = await w.engine().run('migrate', { runId: res.runId, resume: true });
    assert.equal(res2.status, 'COMPLETE', res2.message);
    assert.ok(w.cache.purged.every((u) => u.startsWith('https://cdn.legacy.test') || u.includes('r2.dev')), 'only legacy URLs purged');
    assert.deepEqual(await checkInvariants(w), []);
  } finally {
    w.cleanup();
  }
});

test('cache: purge targets outside the allowed hosts are refused (no arbitrary / zone-wide purge)', async () => {
  const c = new FakeCache(['cdn.legacy.test']);
  const r = await c.purge(['https://evil.example/a.jpg', 'https://cdn.legacy.test/*', 'https://cdn.legacy.test/', 'http://cdn.legacy.test/a.jpg', 'https://cdn.legacy.test/ok.jpg']);
  assert.deepEqual(r.accepted, ['https://cdn.legacy.test/ok.jpg']);
  assert.equal(r.rejected.length, 4);
});

// ───────────── rollback (I13) ─────────────

test('rollback: restores EXACT original values (database snapshot equality), keeps objects, records orphans', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    const original = w.db.snapshot();
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'COMPLETE');
    assert.notEqual(w.db.snapshot(), original);
    const objs = w.storage.objects.size;
    const rb = await rollback(w.engine().d, { dryRun: false, confirmed: true });
    assert.equal(rb.exitCode, 0);
    assert.equal(w.db.snapshot(), original, 'byte-exact restoration of the database');
    assert.equal(w.storage.objects.size, objs, 'nothing deleted from storage');
    assert.ok(w.journal.listAssets().every((a) => a.state === 'ROLLED_BACK'));
    assert.ok(w.journal.listOrphans().length >= 1);
    assert.deepEqual(await checkInvariants(w), []);

    // migrating again after a rollback works and is idempotent with the first migration
    const again = await w.engine().run('migrate');
    assert.equal(again.status, 'COMPLETE', again.message);
    assert.deepEqual(await checkInvariants(w), []);
  } finally {
    w.cleanup();
  }
});

test('rollback: never overwrites a concurrent user edit (ROLLBACK_CONFLICT), restores the rest, exit code 6', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    await w.engine().run('migrate');
    w.db.edit('products', 'prod1', (d) => { d.photo = 'https://cdn.legacy.test/products/user-replaced.jpg'; });
    const rb = await rollback(w.engine().d, { dryRun: false, confirmed: true });
    assert.equal(rb.exitCode, 6);
    assert.equal(rb.conflicts.length, 1);
    assert.equal(w.db.getDoc('products', 'prod1').photo, 'https://cdn.legacy.test/products/user-replaced.jpg', 'user edit preserved');
    assert.ok(w.db.getDoc('products', 'prod0').photo.includes('cdn.legacy.test'), 'unconflicted refs were restored');
    assert.equal(w.journal.listRefs({ statuses: ['ROLLBACK_CONFLICT'] }).length, 1);
  } finally {
    w.cleanup();
  }
});

test('rollback: requires explicit confirmation; dry-run changes nothing and reports the plan', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 2);
    await w.engine().run('migrate');
    const snap = w.db.snapshot();
    await assert.rejects(rollback(w.engine().d, { dryRun: false, confirmed: false }), /--yes/);
    const dry = await rollback(w.engine().d, { dryRun: true, confirmed: false });
    assert.ok(dry.rolledBack > 0);
    assert.equal(w.db.snapshot(), snap);
  } finally {
    w.cleanup();
  }
});

test('rollback: a partially completed migration (crash mid-way) can be rolled back; only UPDATED refs are touched', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedCatalogue(w, 3);
    const original = w.db.snapshot();
    w.failpoints.arm('transition:before:REFERENCES_UPDATED', { mode: 'crash', after: 2 });
    await assert.rejects(w.engine().run('migrate'));
    w.restart();
    assert.notEqual(w.db.snapshot(), original);
    const rb = await rollback(w.engine().d, { dryRun: false, confirmed: true });
    assert.equal(rb.exitCode, 0);
    assert.equal(w.db.snapshot(), original);
  } finally {
    w.cleanup();
  }
});

// ───────────── reconcile + verify (I14) ─────────────

test('reconcile: detects and (with --fix) repairs a missing destination object, records orphans, never deletes', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 2);
    await w.engine().run('migrate');
    const victim = [...w.storage.objects.keys()].find((k) => k.startsWith('media/v1/'))!;
    w.storage.objects.delete(victim); // manual intervention
    w.storage.seed('media/v1/aaaaaaaaaaaaaaaaaaaaaaaaa/400.webp', Buffer.from('stray'), 'image/webp'); // stray upload
    const strays = w.storage.objects.size;

    const ro = await reconcile(w.engine().d, { fix: false });
    assert.equal(ro.ok, false);
    assert.equal(ro.exitCode, 5);
    assert.ok(ro.issues.some((i) => i.type === 'destination-missing'));
    assert.ok(ro.issues.some((i) => i.type === 'orphan-object'));
    assert.equal(w.storage.objects.size, strays, 'read-only reconcile deletes nothing');

    const rf = await reconcile(w.engine().d, { fix: true });
    assert.ok(rf.issues.filter((i) => i.type === 'destination-missing').every((i) => i.fixed));
    assert.ok(w.journal.listOrphans().some((o) => o.key.endsWith('aaaaaaaaaaaaaaaaaaaaaaaaa/400.webp')));
    assert.ok(w.storage.objects.has('media/v1/aaaaaaaaaaaaaaaaaaaaaaaaa/400.webp'), 'orphans are recorded, not deleted');
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'COMPLETE', res.message);
    assert.ok(w.storage.objects.has(victim), 'missing object was regenerated');
    const v = await verify(w.engine().d);
    assert.equal(v.ok, true, v.violations.join('; '));
  } finally {
    w.cleanup();
  }
});

test('reconcile: adopts a reference whose DB write landed but was never journalled (crash after write)', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedCatalogue(w, 1);
    w.failpoints.arm('db:after-write', { mode: 'crash', after: 0 });
    await assert.rejects(w.engine().run('migrate'));
    w.restart();
    assert.ok(w.journal.listRefs({ statuses: ['UPDATING'] }).length === 1);
    const r = await reconcile(w.engine().d, { fix: true });
    assert.ok(r.issues.some((i) => i.type === 'reference-adoptable' && i.fixed));
    assert.equal(w.journal.listRefs({ statuses: ['UPDATING'] }).length, 0);
  } finally {
    w.cleanup();
  }
});

test('verify: passes on a healthy migration, FAILS on missing variants, unknown canonical URLs, and incomplete runs (I1/I10)', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 2);
    const incomplete = await verify(w.engine().d);
    assert.equal(incomplete.ok, false, 'nothing migrated yet: cannot claim verified');
    await w.engine().run('migrate');
    const ok = await verify(w.engine().d);
    assert.equal(ok.ok, true, ok.violations.join('; '));
    assert.equal(ok.exitCode, 0);

    // a canonical-looking URL that was never produced by the tool
    w.db.edit('products', 'prod0', (d) => { d.photos[0] = `${NEW_BASE}/media/v1/${'z'.repeat(25)}/400.webp`; });
    const bad = await verify(w.engine().d);
    assert.equal(bad.ok, false);
    assert.equal(bad.exitCode, 5);
    assert.ok(bad.violations.some((v) => v.startsWith('I1')));

    // destination object removed
    w.db.edit('products', 'prod0', (d) => { d.photos[0] = d.photo; });
    const victim = [...w.storage.objects.keys()].find((k) => k.startsWith('media/v1/'))!;
    w.storage.objects.delete(victim);
    const bad2 = await verify(w.engine().d);
    assert.equal(bad2.ok, false);
    assert.ok(bad2.violations.some((v) => v.includes('destination object missing')));
  } finally {
    w.cleanup();
  }
});

// ───────────── database write policy ─────────────

test('database: transaction mode on a topology without transactions is refused BEFORE any mutation', async () => {
  const { SqliteDocDatabase } = await import('../../src/database/sqliteDocDb');
  const w = makeWorld({ database: { writePolicy: { mode: 'transaction' } } });
  try {
    await seedCatalogue(w, 1);
    const db = new SqliteDocDatabase(':memory:', false);
    const snap = w.storage.objects.size;
    await assert.rejects(w.engine({ db }).run('migrate'), /TRANSACTIONS_UNSUPPORTED|does not support transactions/);
    assert.equal(w.storage.mutations, 0);
    assert.equal(w.storage.objects.size, snap);
  } finally {
    w.cleanup();
  }
});

test('database: transaction mode on a supporting topology updates a bounded batch atomically', async () => {
  const w = makeWorld({ database: { writePolicy: { mode: 'transaction', batchSize: 3 } } });
  try {
    await seedCatalogue(w, 3);
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'COMPLETE', res.message);
    assert.deepEqual(await checkInvariants(w), []);
  } finally {
    w.cleanup();
  }
});

test('database: atomic batch is all-or-nothing — one stale expectation aborts every write in the batch', async () => {
  const { SqliteDocDatabase } = await import('../../src/database/sqliteDocDb');
  const db = new SqliteDocDatabase(':memory:');
  db.insert('c', 'a', { x: 'one' });
  db.insert('c', 'b', { x: 'two' });
  const res = await db.compareAndSet(
    [
      { collection: 'c', docId: 'str:a', ops: [{ path: 'x', expected: 'one', next: 'ONE' }] },
      { collection: 'c', docId: 'str:b', ops: [{ path: 'x', expected: 'STALE', next: 'TWO' }] },
    ],
    { transactional: true },
  );
  assert.deepEqual(res.map((r) => (r.ok ? 'ok' : (r as any).reason)), ['aborted', 'conflict']);
  assert.equal(db.getDoc('c', 'a').x, 'one');
  assert.equal(db.getDoc('c', 'b').x, 'two');
  void createHash;
});
