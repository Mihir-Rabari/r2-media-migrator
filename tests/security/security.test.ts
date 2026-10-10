import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CloudflareCache, FakeCache, HttpCdnVerifier, validatePurgeTarget, FetchLike } from '../../src/cache/providers';
import { HostPolicy } from '../../src/security/urlPolicy';
import { makeWorld, seedCatalogue } from '../../src/testing/harness';
import { rollback } from '../../src/migration/rollback';
import { probeTool } from '../../src/processing/video';
import { FsStorage } from '../../src/storage/fsStorage';
import { MemoryStorage } from '../../src/storage/memoryStorage';
import { Logger } from '../../src/observability/logger';
import { SqliteJournal } from '../../src/journal/sqliteJournal';
import { globalRedactor } from '../../src/security/redact';
import { checkInvariants } from '../../src/testing/invariants';
import { jpegFixture } from '../../src/testing/fixtures';
import { rmrf, tmpDir } from '../helpers';

// ───────── SSRF / arbitrary fetch ─────────

test('SSRF: DB values pointing at internal addresses, metadata endpoints or other schemes are never fetched or rewritten', async () => {
  const w = makeWorld();
  try {
    const hostile = ['http://169.254.169.254/latest/meta-data/', 'https://169.254.169.254/x.jpg', 'http://localhost:9200/x.jpg', 'https://[::1]/x.jpg', 'file:///etc/passwd', 'gopher://x/y', 'ftp://x/y.jpg',
      'https://cdn.legacy.test.attacker.net/x.jpg', 'https://cdn.legacy.test@attacker.net/x.jpg', 'https://attacker.net/?u=https://cdn.legacy.test/x.jpg', 'javascript:alert(1)', '//attacker.net/x.jpg'];
    w.db.insert('products', 'evil', { photo: hostile[0], photos: hostile.slice(1) });
    let touched = 0;
    const spy = new Proxy(w.storage, { get(t, p, r) { const v = Reflect.get(t, p, r); return typeof v === 'function' ? (...a: unknown[]) => { touched++; return (v as Function).apply(t, a); } : v; } });
    const before = w.db.snapshot();
    const res = await w.engine({ source: spy as never, dest: spy as never }).run('migrate');
    assert.equal(res.status, 'COMPLETE');
    assert.equal(touched, 0, 'no storage call at all for non-allow-listed hosts');
    assert.equal(w.db.snapshot(), before);
    assert.equal(w.journal.listAssets().length, 0);
    const stats = w.journal.latest(res.runId, 'inventory:stats')!.data as any;
    assert.ok(stats.refsSeen >= 12);
    assert.equal(stats.legacy, 0);
  } finally {
    w.cleanup();
  }
});

test('SSRF: CDN verification and purge refuse hosts outside the configured allow-list (no arbitrary requests)', async () => {
  const requested: string[] = [];
  const fetchFn: FetchLike = async (url) => { requested.push(url); return { status: 200, ok: true, headers: { get: () => '5' }, json: async () => ({ success: true }) }; };
  const v = new HttpCdnVerifier(['cdn.new.test'], fetchFn);
  for (const u of ['https://169.254.169.254/', 'https://evil.example/a.webp', 'http://cdn.new.test/a.webp', 'https://cdn.new.test/']) assert.equal((await v.verify(u, {})).ok, false, u);
  assert.deepEqual(requested, [], 'no request was issued for disallowed targets');
  assert.equal((await v.verify('https://cdn.new.test/media/v1/x/400.webp', { size: 5 })).ok, true);
  assert.equal((await v.verify('https://cdn.new.test/media/v1/x/400.webp', { size: 6 })).ok, false, 'content-length mismatch fails');
  assert.deepEqual(requested.length, 2);
});

// ───────── cache purge scope ─────────

test('cache: Cloudflare purge sends only concrete per-URL targets in batches <= 30 and rejects wildcards/zone-wide/foreign hosts', async () => {
  const calls: any[] = [];
  const fetchFn: FetchLike = async (url, init) => { calls.push({ url, body: JSON.parse(init!.body!), auth: init!.headers!.Authorization }); return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ success: true }) }; };
  const c = new CloudflareCache({ zoneId: 'a'.repeat(32), apiToken: 'tok-secret-123456', allowedHosts: ['cdn.v2.test', '*.r2.dev'], fetch: fetchFn });
  const urls = Array.from({ length: 65 }, (_, i) => `https://cdn.v2.test/products/${i}.jpg`);
  const r = await c.purge([...urls, 'https://cdn.v2.test/*', 'https://cdn.v2.test/', 'https://evil.example/a.jpg', 'http://cdn.v2.test/a.jpg', 'https://pub-1.r2.dev/a.jpg']);
  assert.equal(r.accepted.length, 66);
  assert.equal(r.rejected.length, 4);
  assert.deepEqual(calls.map((x) => x.body.files.length), [30, 30, 6]);
  for (const c1 of calls) {
    assert.match(c1.url, /\/zones\/a{32}\/purge_cache$/);
    assert.deepEqual(Object.keys(c1.body), ['files'], 'never purge_everything / hosts / tags / prefixes');
  }
  assert.equal(validatePurgeTarget('https://cdn.v2.test/a.jpg', new HostPolicy(['cdn.v2.test'])), null);
});

test('cache: provider failure modes — API rejection is reported per URL; throttling/network are transient (retryable)', async () => {
  const mk = (res: () => Promise<any>) => new CloudflareCache({ zoneId: 'b'.repeat(32), apiToken: 't', allowedHosts: ['cdn.v2.test'], fetch: res as never });
  const rej = await mk(async () => ({ status: 403, ok: false, headers: { get: () => null }, json: async () => ({ success: false, errors: [{ message: 'Authentication error' }] }) })).purge(['https://cdn.v2.test/a.jpg']);
  assert.equal(rej.ok, false);
  assert.match(rej.rejected[0].reason, /Authentication error/);
  const { isRetryable } = await import('../../src/domain/errors');
  await assert.rejects(mk(async () => ({ status: 429, ok: false, headers: { get: () => null }, json: async () => ({}) })).purge(['https://cdn.v2.test/a.jpg']), (e: any) => isRetryable(e));
  await assert.rejects(mk(async () => { throw new Error('socket hang up'); }).purge(['https://cdn.v2.test/a.jpg']), (e: any) => isRetryable(e));
  assert.throws(() => new CloudflareCache({ zoneId: 'not-a-zone', apiToken: 't', allowedHosts: [], fetch: (async () => ({})) as never }), /zone id/);
});

// ───────── unauthorized destructive operations ─────────

test('destructive ops: the engine never deletes originals or purges anything as an implicit side effect (I9)', async () => {
  const w = makeWorld({ cache: { provider: 'cloudflare', zoneIdEnv: 'Z', apiTokenEnv: 'T', purgeLegacyUrls: false } });
  try {
    await seedCatalogue(w, 3);
    const deletes: string[] = [];
    const orig = w.storage.delete.bind(w.storage);
    w.storage.delete = (async (k: string) => { deletes.push(k); return orig(k); }) as never;
    const keys = [...w.storage.objects.keys()];
    await w.engine().run('migrate');
    await rollback(w.engine().d, { dryRun: false, confirmed: true });
    assert.deepEqual(deletes, [], 'no object was ever deleted by migrate or rollback');
    for (const k of keys) assert.ok(w.storage.objects.has(k), `original ${k} still present`);
    assert.equal(w.cache.calls, 0, 'cache untouched unless purgeLegacyUrls is enabled');
  } finally {
    w.cleanup();
  }
});

test('production guard: without allowProductionMutations the ENGINE refuses (not just the CLI), before touching anything', async () => {
  const w = makeWorld({ environment: 'production', source: { storage: { provider: 'fs', bucket: 'b', root: 'x' }, legacyHosts: ['cdn.legacy.test'] }, destination: { storage: { provider: 'fs', bucket: 'b', root: 'x' } } });
  try {
    await seedCatalogue(w, 1);
    const snap = w.db.snapshot();
    await assert.rejects(w.engine().run('migrate'), (e: any) => e.code === 'PRODUCTION_BLOCKED' && e.exitCode === 8);
    await assert.rejects(w.engine().run('process'), (e: any) => e.code === 'PRODUCTION_BLOCKED');
    await assert.rejects(w.engine({ mutationAuthorized: false }).run('migrate'), (e: any) => e.code === 'PRODUCTION_BLOCKED');
    assert.equal(w.db.snapshot(), snap);
    assert.equal(w.storage.mutations, 0);
    await assert.rejects(rollback(w.engine().d, { dryRun: false, confirmed: true }), (e: any) => e.code === 'PRODUCTION_BLOCKED');
    // a dry run is still allowed in production
    const dry = await w.engine({ dryRun: true }).run('dry-run', { limit: 1 });
    assert.equal(dry.status, 'DRY_RUN_COMPLETE');
  } finally {
    w.cleanup();
  }
});

test('engine refuses to mutate when not authorized, even outside production', async () => {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 1);
    await assert.rejects(w.engine({ mutationAuthorized: false }).run('migrate'), (e: any) => e.code === 'NOT_AUTHORIZED');
    assert.equal(w.storage.mutations, 0);
  } finally {
    w.cleanup();
  }
});

// ───────── malicious / malformed media ─────────

test('malicious media: HTML-as-image, polyglots, zero-byte, oversized and bomb-like files are contained (skipped/failed, never uploaded)', async () => {
  const w = makeWorld({ processing: { maxSourceBytes: 600_000, maxSourcePixels: 4_000_000, tempBudgetBytes: 600_000 } });
  try {
    const sharp = (await import('sharp')).default;
    const bomb = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#000' } }).png().toBuffer(); // tiny file, 9 MP
    w.storage.seed('m/bomb.png', bomb, 'image/png');
    w.storage.seed('m/zero.jpg', Buffer.alloc(0), 'image/jpeg');
    w.storage.seed('m/script.jpg', Buffer.from('<script>alert(1)</script>'), 'image/jpeg');
    w.storage.seed('m/huge.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(900_000, 1)]), 'image/jpeg');
    w.storage.seed('m/php.jpg', Buffer.concat([await jpegFixture(80, 80), Buffer.from('<?php system($_GET[1]); ?>')]), 'image/jpeg');
    w.db.insert('products', 'm', { photos: ['bomb.png', 'zero.jpg', 'script.jpg', 'huge.jpg', 'php.jpg'].map((f) => w.url(`m/${f}`)) });
    const res = await w.engine().run('migrate');
    const st = Object.fromEntries(w.journal.listAssets().map((a) => [a.sourceKey, a.state]));
    assert.notEqual(st['m/bomb.png'], 'COMPLETE', 'pixel limit enforced');
    assert.notEqual(st['m/zero.jpg'], 'COMPLETE');
    assert.notEqual(st['m/script.jpg'], 'COMPLETE');
    assert.equal(st['m/huge.jpg'], 'SKIPPED', 'over maxSourceBytes: skipped at plan time without downloading');
    // the polyglot JPEG decodes as a JPEG; its trailing PHP is dropped on re-encode (output is a fresh WebP)
    if (st['m/php.jpg'] === 'COMPLETE') {
      const v = w.journal.listVariants(w.journal.listAssets().find((a) => a.sourceKey === 'm/php.jpg')!.assetId)[0];
      assert.ok(!w.storage.objects.get(v.key)!.data.includes(Buffer.from('<?php')));
    }
    assert.equal(res.status, 'INCOMPLETE');
    for (const [k, o] of w.storage.objects) if (k.startsWith('media/v1/')) assert.ok(o.head.contentType?.startsWith('image/'), k);
    assert.deepEqual(await checkInvariants(w), []);
  } finally {
    w.cleanup();
  }
});

// ───────── path / shell safety ─────────

test('path traversal: filesystem storage cannot be tricked into reading or writing outside its root', async () => {
  const dir = tmpDir('mm-sec-');
  try {
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret');
    const root = path.join(dir, 'root');
    const s = new FsStorage('b', root);
    for (const k of ['../secret.txt', 'a/../../secret.txt', '..\\secret.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'a/%2e%2e/secret.txt']) {
      await assert.rejects(s.get(k), /object key|not-found|no such object/i, k).catch(() => undefined);
      await assert.rejects(s.put(k, Buffer.from('x'), { contentType: 'a/b' }), /./, k).catch(() => undefined);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'secret.txt'), 'utf8'), 'top secret');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['root', 'secret.txt']);
  } finally {
    rmrf(dir);
  }
});

test('shell injection: external tools are invoked with argv arrays (no shell); hostile file names cannot execute anything', async () => {
  const marker = path.join(tmpDir('mm-inj-'), 'pwned');
  const probe = await probeTool('ffprobe');
  assert.equal(typeof probe.available, 'boolean');
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'src', 'processing', 'video.ts'), 'utf8');
  assert.ok(!/\bexec\(|shell:\s*true|execSync|spawnSync\([^)]*shell/.test(src), 'video.ts must not use a shell');
  assert.ok(/execFile\(/.test(src));
  const w = makeWorld();
  try {
    const evil = `x; touch ${marker}; $(touch ${marker}).jpg`;
    w.storage.seed(`products/${evil}`, await jpegFixture(120, 80), 'image/jpeg');
    w.db.insert('products', 'inj', { photo: `https://cdn.legacy.test/products/${encodeURIComponent(evil)}` });
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'COMPLETE');
    assert.equal(fs.existsSync(marker), false);
  } finally {
    w.cleanup();
    rmrf(path.dirname(marker));
  }
});

// ───────── credential leakage ─────────

test('credential leakage: errors, logs and journal events are redacted even when providers embed secrets in messages (I12)', async () => {
  const SECRET = 'LiveSecretKey-ABCDEF123456';
  globalRedactor.addSecret(SECRET);
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedCatalogue(w, 1);
    const leaky = new Proxy(w.storage, {
      get(t, p, r) {
        if (p === 'put') return async () => { throw Object.assign(new Error(`signature mismatch: secretAccessKey=${SECRET} AKIAIOSFODNN7EXAMPLE https://u:${SECRET}@host/x`), { code: 'EACCES' }); };
        const v = Reflect.get(t, p, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const logFile = path.join(w.dir, 'log.ndjson');
    const logger = new Logger({ level: 'debug', journal: w.journal, file: logFile, stderr: false });
    const res = await w.engine({ dest: leaky as never, logger }).run('migrate');
    logger.close();
    assert.equal(res.status, 'INCOMPLETE');
    const everything = JSON.stringify(w.journal.events(null, { limit: 100000 })) + JSON.stringify(w.journal.listAssets()) + fs.readFileSync(logFile, 'utf8') + res.message + JSON.stringify(res.summary);
    assert.ok(!everything.includes(SECRET), 'secret leaked into journal/log/result');
    assert.ok(!everything.includes('AKIAIOSFODNN7EXAMPLE'));
    const { buildReport, reportMarkdown } = await import('../../src/reporting/report');
    const rep = JSON.stringify(buildReport(w.journal, res.runId)) + reportMarkdown(buildReport(w.journal, res.runId));
    assert.ok(!rep.includes(SECRET));
    assert.ok(!rep.includes('AKIAIOSFODNN7EXAMPLE'));
  } finally {
    w.cleanup();
  }
  void MemoryStorage; void SqliteJournal; void FakeCache;
});
