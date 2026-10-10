import { Readable } from 'node:stream';
import type { GetOptions, ListPage, ObjectHead, PutOptions, StorageProvider } from '../core/interfaces';
import { MediaMigrateError } from '../domain/errors';
import { encodeKeyPath, validateObjectKey } from '../security/urlPolicy';

export async function toBuffer(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

interface Stored {
  data: Buffer;
  head: ObjectHead;
}

/** Deterministic in-memory object store implementing the full StorageProvider contract. */
export class MemoryStorage implements StorageProvider {
  readonly kind = 'memory';
  readonly objects = new Map<string, Stored>();
  private seq = 0;
  /** Count of mutating calls, for dry-run assertions. */
  mutations = 0;

  constructor(readonly bucket = 'memory-bucket', private readonly publicBase = 'https://cdn.test') {}

  /** Test helper: seed an object directly (not counted as a mutation). */
  seed(key: string, data: Buffer, contentType = 'application/octet-stream', metadata: Record<string, string> = {}): void {
    this.objects.set(key, {
      data,
      head: { key, size: data.length, etag: `"seed${this.seq++}"`, contentType, metadata, lastModified: new Date(0) },
    });
  }

  async head(key: string): Promise<ObjectHead | null> {
    validateObjectKey(key);
    const o = this.objects.get(key);
    return o ? { ...o.head, metadata: { ...o.head.metadata } } : null;
  }

  async get(key: string, opts: GetOptions = {}) {
    validateObjectKey(key);
    const o = this.objects.get(key);
    if (!o) throw new MediaMigrateError('not-found', 'NOT_FOUND', `no such object: ${key}`);
    const total = o.data.length;
    if (opts.range) {
      const start = opts.range.start;
      const end = Math.min(opts.range.end ?? total - 1, total - 1);
      if (start >= total || start > end) throw new MediaMigrateError('permanent', 'RANGE_NOT_SATISFIABLE', 'range not satisfiable', { total });
      return { head: { ...o.head }, body: Readable.from([o.data.subarray(start, end + 1)]), range: { start, end, total } };
    }
    return { head: { ...o.head }, body: Readable.from([o.data]) };
  }

  async put(key: string, body: Buffer | Readable, opts: PutOptions): Promise<ObjectHead> {
    validateObjectKey(key);
    this.mutations++;
    const data = await toBuffer(body); // an erroring stream throws here, leaving nothing stored (atomic)
    if (opts.contentLength !== undefined && opts.contentLength !== data.length) {
      throw new MediaMigrateError('permanent', 'LENGTH_MISMATCH', `declared ${opts.contentLength} bytes, received ${data.length}`);
    }
    if (opts.ifNoneMatch && this.objects.has(key)) throw new MediaMigrateError('conflict', 'EXISTS', `object already exists: ${key}`);
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.metadata ?? {})) metadata[k.toLowerCase()] = v;
    const head: ObjectHead = {
      key, size: data.length, etag: `"m${this.seq++}"`, contentType: opts.contentType, cacheControl: opts.cacheControl, metadata,
      lastModified: new Date(),
    };
    this.objects.set(key, { data, head });
    return { ...head, metadata: { ...metadata } };
  }

  async delete(key: string): Promise<void> {
    validateObjectKey(key);
    this.mutations++;
    this.objects.delete(key);
  }

  async list(prefix: string, opts: { limit?: number; cursor?: string } = {}): Promise<ListPage> {
    const limit = opts.limit ?? 1000;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && (!opts.cursor || k > opts.cursor)).sort();
    const page = keys.slice(0, limit);
    return {
      objects: page.map((k) => ({ key: k, size: this.objects.get(k)!.data.length, lastModified: this.objects.get(k)!.head.lastModified })),
      nextCursor: keys.length > limit ? page[page.length - 1] : undefined,
    };
  }

  publicUrl(key: string): string {
    return `${this.publicBase.replace(/\/+$/, '')}/${encodeKeyPath(key)}`;
  }
}
