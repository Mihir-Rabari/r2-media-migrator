import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import * as path from 'node:path';
import type { StorageProvider } from '../../src/core/interfaces';
import { MemoryStorage, toBuffer } from '../../src/storage/memoryStorage';
import { FsStorage } from '../../src/storage/fsStorage';
import { S3Storage } from '../../src/storage/s3Storage';
import { FakeS3Client, FakeS3Error } from '../../src/testing/fakeS3Client';
import { isRetryable, MediaMigrateError } from '../../src/domain/errors';
import { rmrf, tmpDir } from '../helpers';

interface Impl {
  name: string;
  make: () => { storage: StorageProvider; cleanup: () => void };
}

const impls: Impl[] = [
  { name: 'memory', make: () => ({ storage: new MemoryStorage('b', 'https://cdn.test'), cleanup: () => undefined }) },
  {
    name: 'fs',
    make: () => {
      const dir = tmpDir('mm-fs-');
      return { storage: new FsStorage('b', dir, 'https://cdn.test'), cleanup: () => rmrf(dir) };
    },
  },
  {
    name: 's3(fake protocol)',
    make: () => ({ storage: new S3Storage({ bucket: 'b', publicBaseUrl: 'https://cdn.test', client: new FakeS3Client() as never }), cleanup: () => undefined }),
  },
];

// Opt-in: run the SAME suite against a real S3-compatible bucket (R2) when credentials are provided.
const real = process.env.MEDIA_MIGRATE_TEST_S3_BUCKET;
if (real) {
  impls.push({
    name: 's3(REAL)',
    make: () => ({
      storage: new S3Storage({
        bucket: real,
        endpoint: process.env.MEDIA_MIGRATE_TEST_S3_ENDPOINT,
        accessKeyId: process.env.MEDIA_MIGRATE_TEST_S3_KEY,
        secretAccessKey: process.env.MEDIA_MIGRATE_TEST_S3_SECRET,
        publicBaseUrl: process.env.MEDIA_MIGRATE_TEST_S3_PUBLIC ?? 'https://example.invalid',
      }),
      cleanup: () => undefined,
    }),
  });
}

const prefix = `contract-${Date.now()}/`;

for (const impl of impls) {
  const t = (name: string, fn: (s: StorageProvider) => Promise<void>) =>
    test(`storage contract [${impl.name}]: ${name}`, async () => {
      const { storage, cleanup } = impl.make();
      try {
        await fn(storage);
      } finally {
        cleanup();
      }
    });

  t('put/head/get round-trip preserves bytes, content-type, cache-control and metadata', async (s) => {
    const data = Buffer.from('hello world');
    const head = await s.put(`${prefix}a.txt`, data, { contentType: 'text/plain', cacheControl: 'public, max-age=31536000, immutable', metadata: { SHA256: 'abc' } });
    assert.equal(head.size, data.length);
    const h = await s.head(`${prefix}a.txt`);
    assert.equal(h!.contentType, 'text/plain');
    assert.equal(h!.metadata.sha256, 'abc');
    if (impl.name !== 's3(REAL)') assert.equal(h!.cacheControl, 'public, max-age=31536000, immutable');
    const g = await s.get(`${prefix}a.txt`);
    assert.deepEqual(await toBuffer(g.body), data);
  });

  t('head of a missing key is null; get of a missing key is a not-found error', async (s) => {
    assert.equal(await s.head(`${prefix}missing`), null);
    await assert.rejects(s.get(`${prefix}missing`), (e: any) => e instanceof MediaMigrateError && e.kind === 'not-found');
  });

  t('ifNoneMatch refuses to overwrite and leaves the original intact', async (s) => {
    await s.put(`${prefix}c.bin`, Buffer.from('one'), { contentType: 'application/octet-stream' });
    await assert.rejects(s.put(`${prefix}c.bin`, Buffer.from('two'), { contentType: 'application/octet-stream', ifNoneMatch: true }), (e: any) => e.kind === 'conflict');
    assert.equal((await toBuffer((await s.get(`${prefix}c.bin`)).body)).toString(), 'one');
  });

  t('repeated identical writes to the same versioned key are idempotent', async (s) => {
    for (let i = 0; i < 3; i++) await s.put(`${prefix}d.bin`, Buffer.from('same'), { contentType: 'application/octet-stream', metadata: { sha256: 'x' } });
    assert.equal((await s.head(`${prefix}d.bin`))!.size, 4);
  });

  t('range requests return the requested slice with total size', async (s) => {
    await s.put(`${prefix}r.bin`, Buffer.from('0123456789'), { contentType: 'application/octet-stream' });
    const g = await s.get(`${prefix}r.bin`, { range: { start: 2, end: 5 } });
    assert.equal((await toBuffer(g.body)).toString(), '2345');
    assert.deepEqual(g.range, { start: 2, end: 5, total: 10 });
    await assert.rejects(s.get(`${prefix}r.bin`, { range: { start: 50 } }));
  });

  t('stream put requires matching contentLength; a mismatch stores nothing', async (s) => {
    await assert.rejects(s.put(`${prefix}e.bin`, Readable.from([Buffer.from('abc')]), { contentType: 'x/y', contentLength: 99 }));
    assert.equal(await s.head(`${prefix}e.bin`), null);
  });

  t('an interrupted upload stream leaves no partial object', async (s) => {
    const broken = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('connection reset'));
      },
    });
    await assert.rejects(s.put(`${prefix}f.bin`, broken, { contentType: 'x/y', contentLength: 100 }));
    assert.equal(await s.head(`${prefix}f.bin`), null);
  });

  t('list is prefix-scoped, ordered and paginated by cursor', async (s) => {
    for (const n of ['l/1', 'l/2', 'l/3', 'other/1']) await s.put(`${prefix}${n}`, Buffer.from(n), { contentType: 'text/plain' });
    const p1 = await s.list(`${prefix}l/`, { limit: 2 });
    assert.deepEqual(p1.objects.map((o) => o.key), [`${prefix}l/1`, `${prefix}l/2`]);
    assert.ok(p1.nextCursor);
    const p2 = await s.list(`${prefix}l/`, { limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(p2.objects.map((o) => o.key), [`${prefix}l/3`]);
    assert.equal(p2.nextCursor, undefined);
  });

  t('delete removes the object and is idempotent', async (s) => {
    await s.put(`${prefix}x.bin`, Buffer.from('x'), { contentType: 'x/y' });
    await s.delete(`${prefix}x.bin`);
    await s.delete(`${prefix}x.bin`);
    assert.equal(await s.head(`${prefix}x.bin`), null);
  });

  t('hostile keys are rejected before touching storage', async (s) => {
    for (const k of ['../etc/passwd', '/abs', 'a//b', 'a/../b', 'a\\b', 'a\u0000b']) {
      await assert.rejects(s.put(k, Buffer.from('x'), { contentType: 'x/y' }), /object key/, k);
      await assert.rejects(s.head(k), /object key/, k);
    }
  });

  t('publicUrl maps keys onto the CDN base with per-segment encoding', async (s) => {
    const u = s.publicUrl('media/v1/a b/ü.webp');
    assert.match(u, /^https:\/\/[^/]+\/media\/v1\/a%20b\/%C3%BC\.webp$/);
  });
}

// ───── S3 adapter specifics (error mapping) ─────

test('s3 adapter: error mapping — throttling is transient, 403 is permanent, 404 is not-found', async () => {
  const mk = (err: () => Error) =>
    new S3Storage({ bucket: 'b', publicBaseUrl: 'https://cdn.test', client: { send: async () => { throw err(); } } as never });
  await assert.rejects(mk(() => new FakeS3Error('SlowDown', 503)).head('k/x'), (e: any) => isRetryable(e));
  await assert.rejects(mk(() => new FakeS3Error('AccessDenied', 403)).put('k/x', Buffer.from('1'), { contentType: 'a/b' }), (e: any) => e.code === 'ACCESS_DENIED' && !isRetryable(e));
  assert.equal(await mk(() => new FakeS3Error('NotFound', 404)).head('k/x'), null);
});

test('s3 adapter: timeout / reset errors are classified retryable', async () => {
  const s = new S3Storage({ bucket: 'b', publicBaseUrl: 'https://cdn.test', client: { send: async () => { const e: any = new Error('boom'); e.code = 'ECONNRESET'; throw e; } } as never });
  await assert.rejects(s.get('k/x'), (e: any) => isRetryable(e));
});

test('s3 adapter: stream put without contentLength is refused', async () => {
  const s = new S3Storage({ bucket: 'b', publicBaseUrl: 'https://cdn.test', client: new FakeS3Client() as never });
  await assert.rejects(s.put('k/x', Readable.from([Buffer.from('a')]), { contentType: 'a/b' }), /contentLength/);
});

test('fs storage: keys cannot escape the root even if validation were bypassed', async () => {
  const dir = tmpDir('mm-fs-');
  try {
    const s = new FsStorage('b', dir);
    await assert.rejects(s.put('a/../../escape', Buffer.from('x'), { contentType: 'a/b' }));
    assert.equal((await s.list('')).objects.length, 0);
    void path;
  } finally {
    rmrf(dir);
  }
});
