import { ObjectId } from 'mongodb';
import type { MongoLike } from '../database/mongoDatabase';
import { getAtPath, setAtPath } from '../database/paths';

/**
 * A small simulator of the MongoDB driver subset used by MongoDatabase (equality/_id $gt/date range filters,
 * projection, sort+limit, updateOne $set with array-index paths, $sample, sessions with abortable transactions).
 * It validates the adapter's filter/cursor/id logic; it is NOT evidence about real MongoDB behaviour.
 */
const idKey = (id: unknown): string => (id instanceof ObjectId ? `o:${id.toHexString()}` : `${typeof id}:${String(id)}`);
const cmp = (a: unknown, b: unknown): number => (idKey(a) < idKey(b) ? -1 : idKey(a) > idKey(b) ? 1 : 0);

function matches(doc: any, filter: Record<string, any>): boolean {
  for (const [k, cond] of Object.entries(filter)) {
    const v = k === '_id' ? doc._id : getAtPath(doc, k);
    if (cond && typeof cond === 'object' && !(cond instanceof ObjectId) && !(cond instanceof Date) && !Array.isArray(cond)) {
      for (const [op, x] of Object.entries(cond as Record<string, any>)) {
        if (op === '$gt' && !(cmp(v, x) > 0)) return false;
        if (op === '$gte' && !(v instanceof Date ? v >= x : false)) return false;
        if (op === '$lt' && !(v instanceof Date ? v < x : false)) return false;
        if (!['$gt', '$gte', '$lt'].includes(op)) throw new Error(`fakeMongo: unsupported operator ${op}`);
      }
    } else if (cond instanceof ObjectId) {
      if (!(v instanceof ObjectId) || !v.equals(cond)) return false;
    } else if (v !== cond) return false;
  }
  return true;
}

function project(doc: any, projection?: Record<string, 1>): any {
  if (!projection) return structuredCloneDoc(doc);
  const out: any = { _id: doc._id };
  for (const k of Object.keys(projection)) {
    const segs = k.split('.');
    const root = segs[0];
    if (doc[root] === undefined) continue;
    // Faithful to real MongoDB: a projection through a NUMERIC array index does not return the element
    // (for arrays of scalars it yields an empty array), so callers must project the whole top-level field.
    if (segs.length > 1 && segs.some((x) => /^\d+$/.test(x))) out[root] = Array.isArray(doc[root]) ? [] : structuredCloneDoc(doc[root]);
    else out[root] = structuredCloneDoc(doc[root]);
  }
  return out;
}
const structuredCloneDoc = (d: any): any => (d instanceof ObjectId ? d : d instanceof Date ? new Date(d) : Array.isArray(d) ? d.map(structuredCloneDoc) : d && typeof d === 'object' ? Object.fromEntries(Object.entries(d).map(([k, v]) => [k, structuredCloneDoc(v)])) : d);

export class FakeMongoClient implements MongoLike {
  readonly colls = new Map<string, any[]>();
  topology: { setName?: string; msg?: string } = {};
  updateCalls = 0;
  connect = async () => this;
  private snapshots: Map<string, any[]> | null = null;
  failNextUpdate = false;

  insert(coll: string, doc: any): void {
    if (!this.colls.has(coll)) this.colls.set(coll, []);
    this.colls.get(coll)!.push(structuredCloneDoc(doc));
  }
  docs(coll: string): any[] {
    return this.colls.get(coll) ?? [];
  }

  db(_name: string) {
    const self = this;
    return {
      admin: () => ({ command: async () => ({ ...self.topology }) }),
      collection: (name: string) => ({
        find(filter: Record<string, any>, o: { projection?: Record<string, 1> } = {}) {
          let rows = self.docs(name).filter((d) => matches(d, filter));
          const cursor = {
            sort: (s: Record<string, 1>) => { void s; rows = [...rows].sort((a, b) => cmp(a._id, b._id)); return cursor; },
            limit: (n: number) => { rows = rows.slice(0, n); return cursor; },
            toArray: async () => rows.map((d) => project(d, o.projection)),
          };
          return cursor;
        },
        async findOne(filter: Record<string, any>, o: { projection?: Record<string, 1> } = {}) {
          const d = self.docs(name).find((x) => matches(x, filter));
          return d ? project(d, o.projection) : null;
        },
        async updateOne(filter: Record<string, any>, update: { $set: Record<string, unknown> }) {
          self.updateCalls++;
          if (self.failNextUpdate) { self.failNextUpdate = false; throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); }
          const d = self.docs(name).find((x) => matches(x, filter));
          if (!d) return { matchedCount: 0, modifiedCount: 0 };
          for (const [p, v] of Object.entries(update.$set)) setAtPath(d, p, v);
          return { matchedCount: 1, modifiedCount: 1 };
        },
        aggregate: (pipeline: any[]) => ({ toArray: async () => self.docs(name).slice(0, pipeline[0].$sample.size).map((d) => structuredCloneDoc(d)) }),
      }),
    };
  }

  startSession() {
    const self = this;
    let aborted = false;
    return {
      async withTransaction(fn: () => Promise<void>) {
        self.snapshots = new Map([...self.colls].map(([k, v]) => [k, v.map(structuredCloneDoc)]));
        aborted = false;
        await fn();
        if (aborted) {
          self.colls.clear();
          for (const [k, v] of self.snapshots!) self.colls.set(k, v);
        }
        self.snapshots = null;
      },
      async abortTransaction() { aborted = true; },
      async endSession() { /* nothing */ },
    };
  }

  async close() { /* nothing */ }
}
