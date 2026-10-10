import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { createLegacyMediaHandler, parseRange } from '../../src/compatibility/handler';
import { MediaUrlResolver, MappingEntry } from '../../src/compatibility/resolver';
import { MemoryStorage } from '../../src/storage/memoryStorage';
import { assetIdFor } from '../../src/domain/ids';

const opts = {
  legacyHosts: ['cdn.v2.test'], sourceProvider: 'memory', sourceBucket: 'bkt', publicBaseUrl: 'https://cdn.v2.test', namespace: 'media', namespaceVersion: 'v1',
  widths: [400, 1200], format: 'webp', referenceVariantWidth: 1200,
};
const id = assetIdFor('memory', 'bkt', 'products/a.jpg');
const mapping: MappingEntry[] = [{ assetId: id, sourceKey: 'products/a.jpg', state: 'COMPLETE', variants: [{ width: 400, effectiveWidth: 400, format: 'webp' }, { width: 1200, effectiveWidth: 1000, format: 'webp' }] }];
const BODY = Buffer.from('0123456789abcdefghij');

async function serve(handlerOpts: Partial<Parameters<typeof createLegacyMediaHandler>[0]> = {}, withNext = false) {
  const storage = new MemoryStorage('bkt');
  storage.seed(`media/v1/${id}/1200.webp`, BODY, 'image/webp');
  storage.seed(`media/v1/${id}/400.webp`, Buffer.from('small'), 'image/webp');
  storage.seed('products/a.jpg', Buffer.from('ORIGINAL-BYTES'), 'image/jpeg');
  const resolver = new MediaUrlResolver(opts, mapping);
  const unresolved: string[] = [];
  const h = createLegacyMediaHandler({ resolver, routePrefixes: ['/legacy'], mode: 'redirect', onUnresolved: (k) => unresolved.push(k), ...handlerOpts, storage });
  const server = http.createServer((req, res) => {
    if (withNext) h(req, res, (e) => { res.writeHead(e ? 500 : 418); res.end('fallthrough'); });
    else void h(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
  return { get, unresolved, storage, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('compat redirect: a mapped legacy path redirects to the canonical URL on the configured origin only', async () => {
  const s = await serve();
  try {
    const r = await s.get('/legacy/products/a.jpg?cachebust=1');
    assert.equal(r.status, 308);
    assert.equal(r.headers.location, `https://cdn.v2.test/media/v1/${id}/1200.webp`);
    assert.match(String(r.headers['cache-control']), /max-age=86400/);
    const w = await s.get('/legacy/products/a.jpg?w=400');
    assert.equal(w.headers.location, `https://cdn.v2.test/media/v1/${id}/400.webp`);
    assert.equal((await s.get('/legacy/products/a.jpg?w=999')).status, 400, 'only mapped widths');
    assert.equal((await s.get('/legacy/products/a.jpg?w=1e3')).status, 400);
    const head = await s.get('/legacy/products/a.jpg', 'HEAD');
    assert.equal(head.status, 308);
    assert.equal((await s.get('/legacy/products/a.jpg', 'POST')).status, 405);
  } finally {
    await s.close();
  }
});

test('compat redirect: configurable status (302/307) and precise prefix matching (no partial-segment matches)', async () => {
  const s = await serve({ redirectStatus: 302 });
  try {
    assert.equal((await s.get('/legacy/products/a.jpg')).status, 302);
    assert.equal((await s.get('/legacyx/products/a.jpg')).status, 404, '/legacyx is not under /legacy');
    assert.equal((await s.get('/other/products/a.jpg')).status, 404);
    assert.equal((await s.get('/legacy')).status, 400, 'prefix with no key is a bad request, not a lookup');
    assert.equal((await s.get('/legacy/')).status, 400);
  } finally {
    await s.close();
  }
});

test('compat: unmapped assets are never guessed — 404 (or next()) and counted for observability', async () => {
  const s = await serve({}, true);
  try {
    const r = await s.get('/legacy/products/nope.jpg');
    assert.equal(r.status, 418, 'falls through to the app instead of inventing a URL');
    assert.deepEqual(s.unresolved, ['products/nope.jpg']);
    assert.equal((await s.get('/unrelated/path')).status, 418, 'non-matching paths pass through untouched');
  } finally {
    await s.close();
  }
});

test('compat security: traversal, encoded separators, double encoding, open-redirect and header-injection attempts are all refused', async () => {
  const s = await serve();
  try {
    const attacks = [
      '/legacy/../../etc/passwd', '/legacy/%2e%2e/%2e%2e/etc/passwd', '/legacy/products%2fa.jpg', '/legacy/products%5ca.jpg', '/legacy/%252e%252e/x', '/legacy/products/a.jpg%00.png',
      '/legacy//evil.com/a.jpg', '/legacy/https://evil.com/a.jpg', '/legacy/products/a.jpg%0d%0aLocation:%20https://evil.com', '/legacy/%',
    ];
    for (const a of attacks) {
      const r = await s.get(a);
      assert.ok([400, 404].includes(r.status), `${a} -> ${r.status}`);
      assert.ok(!r.headers.location || String(r.headers.location).startsWith('https://cdn.v2.test/'), `${a} leaked a redirect to ${r.headers.location}`);
    }
    // the Location header is always built from config, never from the request
    const ok = await s.get('/legacy/products/a.jpg?redirect=https://evil.com&url=https://evil.com&next=//evil.com');
    assert.equal(ok.headers.location, `https://cdn.v2.test/media/v1/${id}/1200.webp`);
  } finally {
    await s.close();
  }
});

test('compat redirect: a canonical URL that would land back inside the handler\'s own prefix is refused (loop guard)', async () => {
  const resolver = new MediaUrlResolver({ ...opts, publicBaseUrl: 'https://app.example.com/legacy', namespace: 'media' }, mapping);
  const h = createLegacyMediaHandler({ resolver, routePrefixes: ['/legacy'], mode: 'redirect' });
  const server = http.createServer((req, res) => void h(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/legacy/products/a.jpg', headers: { host: 'app.example.com' } }, (res) => { res.resume(); resolve(res.statusCode!); });
    });
    assert.equal(status, 508);
  } finally {
    server.close();
  }
});

test('compat stream: HEAD/GET, content headers, ranges, conditional requests and invalid ranges', async () => {
  const s = await serve({ mode: 'stream' });
  try {
    const full = await s.get('/legacy/products/a.jpg');
    assert.equal(full.status, 200);
    assert.deepEqual(full.body, BODY);
    assert.equal(full.headers['content-type'], 'image/webp');
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.headers['content-length'], String(BODY.length));
    assert.ok(full.headers.etag);

    const head = await s.get('/legacy/products/a.jpg', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], String(BODY.length));

    const part = await s.get('/legacy/products/a.jpg', 'GET', { Range: 'bytes=2-5' });
    assert.equal(part.status, 206);
    assert.equal(part.body.toString(), '2345');
    assert.equal(part.headers['content-range'], `bytes 2-5/${BODY.length}`);
    const suffix = await s.get('/legacy/products/a.jpg', 'GET', { Range: 'bytes=-4' });
    assert.equal(suffix.body.toString(), 'ghij');
    const open = await s.get('/legacy/products/a.jpg', 'GET', { Range: 'bytes=15-' });
    assert.equal(open.body.toString(), 'fghij');
    const bad = await s.get('/legacy/products/a.jpg', 'GET', { Range: 'bytes=500-600' });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers['content-range'], `bytes */${BODY.length}`);
    const multi = await s.get('/legacy/products/a.jpg', 'GET', { Range: 'bytes=0-1,3-4' });
    assert.equal(multi.status, 200, 'multi-range is served as the whole object');

    const cond = await s.get('/legacy/products/a.jpg', 'GET', { 'If-None-Match': String(full.headers.etag) });
    assert.equal(cond.status, 304);
    assert.equal(cond.body.length, 0);

    const orig = await createdOriginal();
    assert.equal(orig, 'ORIGINAL-BYTES');
  } finally {
    await s.close();
  }
  async function createdOriginal() {
    const s2 = await serve({ mode: 'stream', serve: 'original' });
    try {
      return (await s2.get('/legacy/products/a.jpg')).body.toString();
    } finally {
      await s2.close();
    }
  }
});

test('compat stream: only keys derived from the verified mapping are ever read from storage (no arbitrary proxying)', async () => {
  const s = await serve({ mode: 'stream' });
  const reads: string[] = [];
  const orig = s.storage.get.bind(s.storage);
  s.storage.get = (async (k: string, o?: any) => { reads.push(k); return orig(k, o); }) as never;
  try {
    for (const p of ['/legacy/products/secret-not-in-mapping.jpg', '/legacy/media/v1/anything/400.webp', '/legacy/products/a.jpg/../../x']) await s.get(p);
    await s.get('/legacy/products/a.jpg');
    assert.deepEqual(reads, [`media/v1/${id}/1200.webp`]);
  } finally {
    await s.close();
  }
});

test('compat stream: large objects are streamed with backpressure, not buffered (64 MB, bounded RSS growth)', async () => {
  const storage = new MemoryStorage('bkt');
  const big = Buffer.alloc(64 * 1024 * 1024, 7);
  storage.seed(`media/v1/${id}/1200.webp`, big, 'image/webp');
  // emulate a network-backed store: data arrives in 64 KB chunks, never as one 64 MB buffer
  const realGet = storage.get.bind(storage);
  storage.get = (async (k: string, o?: any) => {
    const g = await realGet(k, o);
    const data = storage.objects.get(k)!.data;
    async function* chunks() { for (let i = 0; i < data.length; i += 65536) yield data.subarray(i, i + 65536); }
    return { ...g, body: Readable.from(chunks()) };
  }) as never;
  const h = createLegacyMediaHandler({ resolver: new MediaUrlResolver(opts, mapping), routePrefixes: ['/legacy'], mode: 'stream', storage });
  const server = http.createServer((req, res) => void h(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const base = process.memoryUsage().rss;
    let peak = base;
    const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
    const total: number = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/legacy/products/a.jpg' }, (res) => {
        let n = 0;
        res.on('data', (c) => (n += c.length));
        res.on('end', () => resolve(n));
      }).on('error', reject);
    });
    clearInterval(t);
    assert.equal(total, big.length);
    assert.ok((peak - base) / 1024 / 1024 < 48, `RSS grew ${((peak - base) / 1024 / 1024).toFixed(1)} MB`);
  } finally {
    server.close();
  }
});

test('parseRange: single ranges, suffix, open-ended, invalid and multi', () => {
  assert.deepEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=0-999', 10), { start: 0, end: 9 });
  assert.equal(parseRange('bytes=10-12', 10), 'invalid');
  assert.equal(parseRange('bytes=5-2', 10), 'invalid');
  assert.equal(parseRange('bytes=-0', 10), 'invalid');
  assert.equal(parseRange('bytes=abc', 10), 'invalid');
  assert.equal(parseRange('bytes=0-1,4-5', 10), null);
  assert.equal(parseRange(undefined, 10), null);
});
