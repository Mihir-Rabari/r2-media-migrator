import { MongoClient, ObjectId } from 'mongodb';
import type { CasItem, CasResult, DatabaseProvider, DbCapabilities, DbScanBatch, DbScanOptions } from '../core/interfaces';
import { MediaMigrateError } from '../domain/errors';
import { expandAll, getAtPath, rootsOf } from './paths';

/** Serialise a Mongo _id into a stable, typed string. */
export function encodeId(id: unknown): string {
  if (id instanceof ObjectId) return `oid:${id.toHexString()}`;
  if (typeof id === 'string') return `str:${id}`;
  if (typeof id === 'number') return `num:${id}`;
  throw new MediaMigrateError('permanent', 'UNSUPPORTED_ID', `unsupported _id type: ${typeof id}`);
}
export function decodeId(s: string): unknown {
  const i = s.indexOf(':');
  const kind = s.slice(0, i);
  const rest = s.slice(i + 1);
  if (kind === 'oid') return new ObjectId(rest);
  if (kind === 'str') return rest;
  if (kind === 'num') return Number(rest);
  throw new MediaMigrateError('permanent', 'UNSUPPORTED_ID', `unsupported serialised _id: ${s.slice(0, 20)}`);
}

/** Minimal surface of the driver that this adapter uses (lets tests inject a simulator). */
export interface MongoLike {
  db(name: string): any;
  startSession(): any;
  close(): Promise<void>;
}

export interface MongoOptions {
  uri?: string;
  database: string;
  client?: MongoLike;
  serverSelectionTimeoutMs?: number;
}

/**
 * MongoDB adapter. Updates are single-document compare-and-set operations (atomic in MongoDB).
 * Transactions are used only on request AND only when `hello` reports a replica set / mongos.
 */
export class MongoDatabase implements DatabaseProvider {
  readonly kind = 'mongodb';
  private readonly client: MongoLike;
  private connected = false;
  constructor(private readonly o: MongoOptions) {
    this.client = o.client ?? (new MongoClient(o.uri!, { serverSelectionTimeoutMS: o.serverSelectionTimeoutMs ?? 10_000, retryWrites: true }) as unknown as MongoLike);
  }

  private async db() {
    if (!this.connected && 'connect' in this.client) {
      await (this.client as unknown as MongoClient).connect();
      this.connected = true;
    }
    return this.client.db(this.o.database);
  }

  async capabilities(): Promise<DbCapabilities> {
    const db = await this.db();
    try {
      const hello = await db.admin().command({ hello: 1 });
      if (hello.setName) return { transactions: true, reason: `replica set "${hello.setName}"` };
      if (hello.msg === 'isdbgrid') return { transactions: true, reason: 'sharded cluster (mongos)' };
      return { transactions: false, reason: 'standalone server: multi-document transactions are not supported' };
    } catch (e) {
      return { transactions: false, reason: `could not determine topology: ${(e as Error).message}` };
    }
  }

  async *scan(o: DbScanOptions): AsyncIterable<DbScanBatch> {
    const coll = (await this.db()).collection(o.collection);
    const projection: Record<string, 1> = { _id: 1 };
    for (const r of rootsOf(o.fields)) projection[r] = 1;
    if (o.timestampField) projection[o.timestampField.split('.')[0]] = 1;
    let after = o.afterId ? decodeId(o.afterId) : undefined;
    for (;;) {
      const filter: Record<string, any> = {};
      if (after !== undefined) filter._id = { $gt: after };
      if (o.timestampField && (o.since || o.until)) {
        filter[o.timestampField] = { ...(o.since ? { $gte: o.since } : {}), ...(o.until ? { $lt: o.until } : {}) };
      }
      const docs: any[] = await coll.find(filter, { projection }).sort({ _id: 1 }).limit(o.batchSize).toArray();
      if (docs.length === 0) return;
      const refs: DbScanBatch['refs'] = [];
      for (const d of docs) for (const x of expandAll(d, o.fields)) refs.push({ docId: encodeId(d._id), path: x.path, value: x.value });
      after = docs[docs.length - 1]._id;
      yield { refs, lastDocId: encodeId(after), docsScanned: docs.length };
      if (docs.length < o.batchSize) return;
    }
  }

  async readValues(collection: string, docId: string, paths: readonly string[]): Promise<Record<string, unknown> | null> {
    const coll = (await this.db()).collection(collection);
    const projection: Record<string, 1> = {};
    for (const p of paths) projection[p] = 1;
    const doc = await coll.findOne({ _id: decodeId(docId) }, { projection });
    if (!doc) return null;
    return Object.fromEntries(paths.map((p) => [p, getAtPath(doc, p)]));
  }

  async compareAndSet(items: readonly CasItem[], opts: { transactional: boolean }): Promise<CasResult[]> {
    const db = await this.db();
    const one = async (it: CasItem, session?: unknown): Promise<CasResult> => {
      const coll = db.collection(it.collection);
      const filter: Record<string, unknown> = { _id: decodeId(it.docId) };
      const set: Record<string, unknown> = {};
      for (const op of it.ops) {
        filter[op.path] = op.expected;
        set[op.path] = op.next;
      }
      const r = await coll.updateOne(filter, { $set: set }, session ? { session } : undefined);
      if (r.matchedCount === 1) return { ok: true };
      const cur = await coll.findOne({ _id: decodeId(it.docId) }, { projection: Object.fromEntries(it.ops.map((o) => [o.path, 1])), ...(session ? { session } : {}) });
      if (!cur) return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'conflict', actual: Object.fromEntries(it.ops.map((o) => [o.path, getAtPath(cur, o.path)])) };
    };

    if (!opts.transactional) {
      const out: CasResult[] = [];
      for (const it of items) out.push(await one(it));
      return out;
    }
    const caps = await this.capabilities();
    if (!caps.transactions) throw new MediaMigrateError('validation', 'TRANSACTIONS_UNSUPPORTED', `transactional write policy requested but unsupported: ${caps.reason}`);
    const session = this.client.startSession();
    let results: CasResult[] = [];
    try {
      await session.withTransaction(async () => {
        results = [];
        for (const it of items) {
          const r = await one(it, session);
          results.push(r);
          if (!r.ok) {
            await session.abortTransaction();
            return;
          }
        }
      });
    } finally {
      await session.endSession();
    }
    if (results.every((r) => r.ok)) return results;
    return items.map((_, i) => (results[i] && !results[i].ok ? results[i] : { ok: false as const, reason: 'aborted' as const }));
  }

  async sample(collection: string, n: number): Promise<unknown[]> {
    const coll = (await this.db()).collection(collection);
    return coll.aggregate([{ $sample: { size: n } }]).toArray();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
