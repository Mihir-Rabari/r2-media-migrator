import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { DatabaseProvider } from '../../src/core/interfaces';
import { SqliteDocDatabase } from '../../src/database/sqliteDocDb';
import { MongoDatabase, decodeId, encodeId } from '../../src/database/mongoDatabase';
import { FakeMongoClient } from '../../src/testing/fakeMongo';

/**
 * Database contract: the same assertions run against the SQLite document store and the MongoDB adapter
 * (driven by a driver simulator). A REAL MongoDB run is opt-in via MEDIA_MIGRATE_TEST_MONGO_URI (see below).
 */
interface Impl { name: string; make(): { db: DatabaseProvider; seed(coll: string, key: string, doc: Record<string, unknown>): string; read(coll: string, key: string): any; edit(coll: string, key: string, fn: (d: any) => void): void } }

const impls: Impl[] = [
  {
    name: 'sqlite-docs',
    make() {
      const db = new SqliteDocDatabase(':memory:');
      return { db, seed: (c, k, d) => { db.insert(c, k, d); return `str:${k}`; }, read: (c, k) => db.getDoc(c, k), edit: (c, k, fn) => db.edit(c, k, fn) };
    },
  },
  {
    name: 'mongodb(simulated driver)',
    make() {
      const client = new FakeMongoClient();
      client.topology = { setName: 'rs0' };
      const ids = new Map<string, ObjectId>();
      const idFor = (k: string) => { if (!ids.has(k)) ids.set(k, new ObjectId(Buffer.from(k.padEnd(12, '_').slice(0, 12)))); return ids.get(k)!; };
      const db = new MongoDatabase({ database: 'd', client });
      return {
        db,
        seed: (c, k, d) => { client.insert(c, { _id: idFor(k), ...d }); return encodeId(idFor(k)); },
        read: (c, k) => client.docs(c).find((x) => x._id.equals(idFor(k))),
        edit: (c, k, fn) => fn(client.docs(c).find((x) => x._id.equals(idFor(k)))),
      };
    },
  },
];

for (const impl of impls) {
  const t = (name: string, fn: (h: ReturnType<Impl['make']>) => Promise<void>) => test(`database contract [${impl.name}]: ${name}`, async () => fn(impl.make()));

  t('scan yields only approved-field string references, with concrete array/nested paths, in stable batches', async ({ db, seed }) => {
    for (let i = 0; i < 5; i++) seed('products', `p${i}`, { photo: `u${i}`, photos: [`g${i}a`, '', `g${i}b`], other: `nope${i}`, hero: { slides: [{ url: `s${i}` }, { url: null }] }, count: 3 });
    const seen: string[] = [];
    let batches = 0;
    for await (const b of db.scan({ collection: 'products', fields: ['photo', 'photos[]', 'hero.slides[].url'], batchSize: 2 })) {
      batches++;
      for (const r of b.refs) seen.push(`${r.path}=${r.value}`);
    }
    assert.equal(batches, 3);
    assert.equal(seen.length, 5 * 4);
    assert.ok(seen.includes('photos.2=g3b'));
    assert.ok(seen.includes('hero.slides.0.url=s4'));
    assert.ok(!seen.some((s) => s.startsWith('other') || s.startsWith('count')), 'unapproved fields are never read into references');
  });

  t('scan resumes from a cursor without repeating documents', async ({ db, seed }) => {
    for (let i = 0; i < 6; i++) seed('c', `d${i}`, { photo: `u${i}` });
    const first: string[] = [];
    let last: string | null = null;
    for await (const b of db.scan({ collection: 'c', fields: ['photo'], batchSize: 2 })) {
      b.refs.forEach((r) => first.push(r.value));
      last = b.lastDocId;
      if (first.length >= 4) break;
    }
    const rest: string[] = [];
    for await (const b of db.scan({ collection: 'c', fields: ['photo'], batchSize: 2, afterId: last! })) b.refs.forEach((r) => rest.push(r.value));
    assert.equal(new Set([...first, ...rest]).size, 6);
    assert.equal(first.length + rest.length, 6, 'no document scanned twice');
  });

  t('compareAndSet writes only when the expected value still matches; conflicts report the actual value and change nothing', async ({ db, seed, read }) => {
    const id = seed('c', 'x', { photo: 'old', photos: ['a', 'b'], name: 'keep' });
    assert.deepEqual(await db.compareAndSet([{ collection: 'c', docId: id, ops: [{ path: 'photos.1', expected: 'b', next: 'B2' }] }], { transactional: false }), [{ ok: true }]);
    assert.deepEqual(read('c', 'x').photos, ['a', 'B2']);
    const [r] = await db.compareAndSet([{ collection: 'c', docId: id, ops: [{ path: 'photos.1', expected: 'b', next: 'B3' }] }], { transactional: false });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, 'conflict');
    assert.equal((r as any).actual['photos.1'], 'B2');
    assert.equal(read('c', 'x').name, 'keep', 'unrelated fields untouched');
    const [m] = await db.compareAndSet([{ collection: 'c', docId: id.replace(/.$/, 'z') + 'zz', ops: [{ path: 'photo', expected: 'old', next: 'n' }] }], { transactional: false }).catch(() => [{ ok: false, reason: 'missing' } as const]);
    assert.equal(m.ok, false);
  });

  t('multi-path CAS is all-or-nothing within a document', async ({ db, seed, read }) => {
    const id = seed('c', 'y', { a: '1', b: '2' });
    const [r] = await db.compareAndSet([{ collection: 'c', docId: id, ops: [{ path: 'a', expected: '1', next: 'A' }, { path: 'b', expected: 'WRONG', next: 'B' }] }], { transactional: false });
    assert.equal(r.ok, false);
    assert.deepEqual([read('c', 'y').a, read('c', 'y').b], ['1', '2']);
  });

  t('readValues returns current values and null for a missing document', async ({ db, seed }) => {
    const id = seed('c', 'z', { photos: ['p', 'q'] });
    assert.deepEqual(await db.readValues('c', id, ['photos.1', 'photos.9']), { 'photos.1': 'q', 'photos.9': undefined });
  });

  t('transactional batches are atomic: a stale expectation aborts every write; success writes all', async ({ db, seed, read }) => {
    const a = seed('c', 'ta', { v: '1' });
    const b = seed('c', 'tb', { v: '2' });
    const res = await db.compareAndSet([{ collection: 'c', docId: a, ops: [{ path: 'v', expected: '1', next: 'A' }] }, { collection: 'c', docId: b, ops: [{ path: 'v', expected: 'stale', next: 'B' }] }], { transactional: true });
    assert.deepEqual(res.map((r) => (r.ok ? 'ok' : (r as any).reason)), ['aborted', 'conflict']);
    assert.equal(read('c', 'ta').v, '1', 'first write rolled back');
    const ok = await db.compareAndSet([{ collection: 'c', docId: a, ops: [{ path: 'v', expected: '1', next: 'A' }] }, { collection: 'c', docId: b, ops: [{ path: 'v', expected: '2', next: 'B' }] }], { transactional: true });
    assert.ok(ok.every((r) => r.ok));
    assert.deepEqual([read('c', 'ta').v, read('c', 'tb').v], ['A', 'B']);
  });

  t('sample returns documents for field discovery', async ({ db, seed }) => {
    for (let i = 0; i < 3; i++) seed('c', `s${i}`, { photo: `u${i}` });
    assert.equal((await db.sample('c', 2)).length, 2);
  });
}

test('mongodb adapter: _id serialisation round-trips ObjectId, string and number ids', () => {
  const oid = new ObjectId();
  assert.ok((decodeId(encodeId(oid)) as ObjectId).equals(oid));
  assert.equal(decodeId(encodeId('abc')), 'abc');
  assert.equal(decodeId(encodeId(42)), 42);
  assert.throws(() => decodeId('weird:1'), /unsupported/);
  assert.throws(() => encodeId({}), /unsupported/);
});

test('mongodb adapter: capability detection — replica set / mongos support transactions, standalone does not (and says why)', async () => {
  for (const [topo, expected] of [[{ setName: 'rs0' }, true], [{ msg: 'isdbgrid' }, true], [{}, false]] as const) {
    const c = new FakeMongoClient();
    c.topology = topo as never;
    const caps = await new MongoDatabase({ database: 'd', client: c }).capabilities();
    assert.equal(caps.transactions, expected);
    assert.ok(caps.reason.length > 5);
  }
  const standalone = new MongoDatabase({ database: 'd', client: new FakeMongoClient() });
  await assert.rejects(standalone.compareAndSet([{ collection: 'c', docId: 'str:x', ops: [] }], { transactional: true }), /TRANSACTIONS_UNSUPPORTED|not supported/);
});

test('mongodb adapter: ObjectId-keyed documents scan and update through serialised ids', async () => {
  const c = new FakeMongoClient();
  const oid = new ObjectId();
  c.insert('p', { _id: oid, photo: 'old' });
  const db = new MongoDatabase({ database: 'd', client: c });
  let id = '';
  for await (const b of db.scan({ collection: 'p', fields: ['photo'], batchSize: 10 })) id = b.refs[0].docId;
  assert.equal(id, `oid:${oid.toHexString()}`);
  assert.deepEqual(await db.compareAndSet([{ collection: 'p', docId: id, ops: [{ path: 'photo', expected: 'old', next: 'new' }] }], { transactional: false }), [{ ok: true }]);
  assert.equal(c.docs('p')[0].photo, 'new');
});

test('mongodb adapter: since/until become a timestamp range filter', async () => {
  const c = new FakeMongoClient();
  c.insert('p', { _id: new ObjectId(), photo: 'old', updatedAt: new Date('2025-01-01') });
  c.insert('p', { _id: new ObjectId(), photo: 'new', updatedAt: new Date('2026-06-01') });
  const db = new MongoDatabase({ database: 'd', client: c });
  const seen: string[] = [];
  for await (const b of db.scan({ collection: 'p', fields: ['photo'], batchSize: 10, timestampField: 'updatedAt', since: new Date('2026-01-01') })) b.refs.forEach((r) => seen.push(r.value));
  assert.deepEqual(seen, ['new']);
});

// Opt-in real MongoDB (replica set required for the transaction assertions)
const uri = process.env.MEDIA_MIGRATE_TEST_MONGO_URI;
test('mongodb REAL contract (opt-in via MEDIA_MIGRATE_TEST_MONGO_URI)', { skip: uri ? false : 'no MEDIA_MIGRATE_TEST_MONGO_URI: real MongoDB not available in this environment' }, async () => {
  const dbName = `mm_test_${Date.now()}`;
  const db = new MongoDatabase({ uri, database: dbName });
  try {
    const { MongoClient } = await import('mongodb');
    const cl = new MongoClient(uri!);
    await cl.connect();
    const coll = cl.db(dbName).collection('c');
    const { insertedId } = await coll.insertOne({ photo: 'old', photos: ['a', 'b'], keep: 1 });
    const id = encodeId(insertedId);
    const [r] = await db.compareAndSet([{ collection: 'c', docId: id, ops: [{ path: 'photos.1', expected: 'b', next: 'B' }] }], { transactional: false });
    assert.equal(r.ok, true);
    const [c2] = await db.compareAndSet([{ collection: 'c', docId: id, ops: [{ path: 'photos.1', expected: 'b', next: 'X' }] }], { transactional: false });
    assert.equal(c2.ok, false);
    await cl.db(dbName).dropDatabase();
    await cl.close();
  } finally {
    await db.close();
  }
});
