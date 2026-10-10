import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { MediaUrlResolver, MappingEntry, ResolverOptions } from '../../src/compatibility/resolver';
import { assetIdFor } from '../../src/domain/ids';
import { MappingResolver } from '../../src/compatibility/mapping';
import { readMappingFile, writeMappingFile } from '../../src/reporting/report';
import { withTmp } from '../helpers';
import * as fs from 'node:fs';
import * as path from 'node:path';

const opts: ResolverOptions = {
  legacyHosts: ['cdn.v2.test', '*.r2.dev'], neverRewriteHosts: ['images.pexels.com'], sourceProvider: 's3', sourceBucket: 'bkt',
  publicBaseUrl: 'https://cdn.v2.test', namespace: 'media', namespaceVersion: 'v1', widths: [400, 800, 1200], format: 'webp', referenceVariantWidth: 1200,
};
const entry = (key: string): MappingEntry => ({ assetId: assetIdFor('s3', 'bkt', key), sourceKey: key, state: 'COMPLETE', variants: [400, 800, 1200].map((w) => ({ width: w, effectiveWidth: w, format: 'webp' })) });
const mk = (keys: string[] = ['products/a.jpg', 'products/with space.jpg', 'sliders/ü.jpg']) => new MediaUrlResolver(opts, keys.map(entry));

test('resolver: legacy URLs on every allowed host resolve to the SAME canonical asset URL', () => {
  const r = mk();
  const id = assetIdFor('s3', 'bkt', 'products/a.jpg');
  const expected = `https://cdn.v2.test/media/v1/${id}/1200.webp`;
  for (const u of ['https://cdn.v2.test/products/a.jpg', 'https://pub-abc123.r2.dev/products/a.jpg', 'https://CDN.V2.TEST/products/a.jpg?v=3#frag']) {
    assert.deepEqual(r.resolve(u), { url: expected, assetId: id }, u);
  }
});

test('resolver: encoding — spaces, unicode and percent-encoded forms normalise to the same key', () => {
  const r = mk();
  for (const u of ['https://cdn.v2.test/products/with%20space.jpg', 'https://cdn.v2.test/products/with space.jpg'.replace(' ', '%20')]) assert.ok(r.resolve(u), u);
  assert.ok(r.resolve('https://cdn.v2.test/sliders/%C3%BC.jpg'));
  assert.ok(r.resolve('https://cdn.v2.test/sliders/ü.jpg'));
});

test('resolver (property): idempotent — resolving an already-canonical URL returns it unchanged, for every width', () => {
  const r = mk();
  fc.assert(
    fc.property(fc.constantFrom('products/a.jpg', 'products/with space.jpg', 'sliders/ü.jpg'), fc.constantFrom(400, 800, 1200), (key, w) => {
      const first = r.resolve(`https://cdn.v2.test/${key.split('/').map(encodeURIComponent).join('/')}`, w)!;
      const second = r.resolve(first.url, w)!;
      const third = r.resolve(second.url)!;
      assert.equal(second.url, first.url);
      assert.equal(third.assetId, first.assetId);
      assert.deepEqual(r.classify(first.url), { kind: 'canonical', assetId: first.assetId, width: w, url: first.url });
      return true;
    }),
    { numRuns: 100 },
  );
});

test('resolver: unmapped legacy URLs are NOT guessed (null) and are counted for observability', () => {
  const r = mk(['products/a.jpg']);
  assert.equal(r.resolve('https://cdn.v2.test/products/unknown.jpg'), null);
  assert.equal(r.resolve('https://cdn.v2.test/products/unknown.jpg'), null);
  assert.equal(r.unresolved.get('products/unknown.jpg'), 2);
  assert.equal(r.classify('https://cdn.v2.test/products/unknown.jpg').kind, 'legacy', 'classified as legacy, but not resolvable without a verified mapping');
});

test('resolver (I4): third-party, look-alike, never-rewrite and malformed hosts are NEVER classified as legacy or rewritten', () => {
  const r = mk();
  const external = [
    'https://images.pexels.com/photos/1/x.jpeg', 'https://ik.imagekit.io/ma42/x.jpg', 'https://v2-fashion.s3.amazonaws.com/x.jpg', 'https://youtu.be/abc',
    'https://cdn.v2.test.evil.com/products/a.jpg', 'https://evil-cdn.v2.test/products/a.jpg', 'https://r2.dev/products/a.jpg', 'https://example.com/cdn.v2.test/products/a.jpg',
    '/relative/path.jpg', 'data:image/png;base64,AAAA', 'not a url', '',
  ];
  for (const u of external) {
    const c = r.classify(u);
    assert.ok(c.kind === 'external' || c.kind === 'invalid', `${u} -> ${c.kind}`);
    assert.equal(r.resolve(u), null, u);
  }
});

test('resolver: canonical-looking URLs on other origins or with other namespaces are not treated as ours', () => {
  const r = mk();
  const id = assetIdFor('s3', 'bkt', 'products/a.jpg');
  for (const u of [`https://evil.example/media/v1/${id}/400.webp`, `https://cdn.v2.test/media/v2/${id}/400.webp`, `https://cdn.v2.test/other/v1/${id}/400.webp`, `https://cdn.v2.test/media/v1/${id}/400.png`, `https://cdn.v2.test/media/v1/SHORT/400.webp`]) {
    assert.notEqual(r.classify(u).kind, 'canonical', u);
  }
});

test('resolver: width selection only offers widths that exist in the verified mapping', () => {
  const e = entry('products/a.jpg');
  e.variants = [{ width: 400, effectiveWidth: 400, format: 'webp' }];
  const r = new MediaUrlResolver(opts, [e]);
  assert.equal(r.resolve('https://cdn.v2.test/products/a.jpg', 1200), null, 'reference width 1200 was never generated');
  assert.ok(r.resolve('https://cdn.v2.test/products/a.jpg', 400));
});

test('resolver: include/exclude prefixes and the destination namespace are out of scope for rewriting', () => {
  const r = new MediaUrlResolver({ ...opts, excludePrefixes: ['private/'], includePrefixes: ['products/', 'private/'] }, []);
  assert.equal(r.classify('https://cdn.v2.test/private/secret.jpg').kind, 'excluded');
  assert.equal(r.classify('https://cdn.v2.test/other/x.jpg').kind, 'excluded');
  assert.equal(r.classify('https://cdn.v2.test/products/x.jpg').kind, 'legacy');
  const r2 = new MediaUrlResolver(opts, []);
  assert.equal(r2.classify('https://cdn.v2.test/media/old-dir/x.jpg').kind, 'excluded', 'objects inside the destination namespace are never sources');
});

test('mapping: JSONL export is atomic, corrupt lines are skipped (unresolved is safe), and the resolver reloads on change', async () => {
  await withTmp((dir) => {
    const f = path.join(dir, 'map', 'mapping.jsonl');
    assert.deepEqual(readMappingFile(f), []);
    writeMappingFile(f, [entry('products/a.jpg')]);
    fs.appendFileSync(f, 'this is not json\n{"assetId":"x"}\n');
    assert.equal(readMappingFile(f).length, 1, 'garbage and structurally invalid lines skipped');
    let now = 0;
    const m = new MappingResolver(opts, f, 1000, () => now);
    assert.ok(m.current.resolve('https://cdn.v2.test/products/a.jpg'));
    assert.equal(m.current.resolve('https://cdn.v2.test/products/b.jpg'), null);
    writeMappingFile(f, [entry('products/a.jpg'), entry('products/b.jpg')]);
    assert.equal(m.current.resolve('https://cdn.v2.test/products/b.jpg'), null, 'not re-checked within the interval');
    now += 2000;
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    assert.ok(m.current.resolve('https://cdn.v2.test/products/b.jpg'), 'picked up after refresh');
    fs.rmSync(f);
    now += 2000;
    assert.equal(m.current.resolve('https://cdn.v2.test/products/a.jpg'), null, 'mapping removed -> nothing resolves');
  });
});
