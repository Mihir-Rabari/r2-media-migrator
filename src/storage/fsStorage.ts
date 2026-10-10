import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import type { GetOptions, ListPage, ObjectHead, PutOptions, StorageProvider } from '../core/interfaces';
import { MediaMigrateError } from '../domain/errors';
import { safeJoin } from '../security/paths';
import { encodeKeyPath, validateObjectKey } from '../security/urlPolicy';

/**
 * Filesystem-backed object store. Layout: <root>/objects/<key> and <root>/meta/<key>.json.
 * Writes go to a temp file then rename, so readers never observe partial objects.
 * Used for local runs, CLI end-to-end tests and as a dependency-free "provider" for staging rehearsals.
 */
export class FsStorage implements StorageProvider {
  readonly kind = 'fs';
  private readonly objDir: string;
  private readonly metaDir: string;
  constructor(readonly bucket: string, private readonly root: string, private readonly publicBase = 'https://cdn.test') {
    this.objDir = path.join(root, 'objects');
    this.metaDir = path.join(root, 'meta');
    fs.mkdirSync(this.objDir, { recursive: true });
    fs.mkdirSync(this.metaDir, { recursive: true });
  }

  private objPath(key: string) {
    return safeJoin(this.objDir, validateObjectKey(key));
  }
  private metaPath(key: string) {
    return safeJoin(this.metaDir, validateObjectKey(key) + '.json');
  }

  async head(key: string): Promise<ObjectHead | null> {
    const p = this.objPath(key);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    let meta: Partial<ObjectHead> = {};
    try {
      meta = JSON.parse(fs.readFileSync(this.metaPath(key), 'utf8'));
    } catch {
      /* no sidecar: seeded file */
    }
    return {
      key, size: st.size, etag: `"${st.size}-${Math.floor(st.mtimeMs)}"`, contentType: meta.contentType ?? 'application/octet-stream',
      cacheControl: meta.cacheControl, metadata: meta.metadata ?? {}, lastModified: st.mtime,
    };
  }

  async get(key: string, opts: GetOptions = {}) {
    const head = await this.head(key);
    if (!head) throw new MediaMigrateError('not-found', 'NOT_FOUND', `no such object: ${key}`);
    const p = this.objPath(key);
    if (opts.range) {
      const start = opts.range.start;
      const end = Math.min(opts.range.end ?? head.size - 1, head.size - 1);
      if (start >= head.size || start > end) throw new MediaMigrateError('permanent', 'RANGE_NOT_SATISFIABLE', 'range not satisfiable', { total: head.size });
      return { head, body: fs.createReadStream(p, { start, end }), range: { start, end, total: head.size } };
    }
    return { head, body: fs.createReadStream(p) };
  }

  async put(key: string, body: Buffer | Readable, opts: PutOptions): Promise<ObjectHead> {
    const p = this.objPath(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (opts.ifNoneMatch && fs.existsSync(p)) throw new MediaMigrateError('conflict', 'EXISTS', `object already exists: ${key}`);
    const tmp = `${p}.tmp-${randomBytes(4).toString('hex')}`;
    try {
      await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : body, fs.createWriteStream(tmp));
      const size = fs.statSync(tmp).size;
      if (opts.contentLength !== undefined && opts.contentLength !== size) {
        throw new MediaMigrateError('permanent', 'LENGTH_MISMATCH', `declared ${opts.contentLength} bytes, received ${size}`);
      }
      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(opts.metadata ?? {})) metadata[k.toLowerCase()] = v;
      const mp = this.metaPath(key);
      fs.mkdirSync(path.dirname(mp), { recursive: true });
      fs.writeFileSync(mp, JSON.stringify({ contentType: opts.contentType, cacheControl: opts.cacheControl, metadata }));
      fs.renameSync(tmp, p);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return (await this.head(key))!;
  }

  async delete(key: string): Promise<void> {
    fs.rmSync(this.objPath(key), { force: true });
    fs.rmSync(this.metaPath(key), { force: true });
  }

  async list(prefix: string, opts: { limit?: number; cursor?: string } = {}): Promise<ListPage> {
    const limit = opts.limit ?? 1000;
    const all: Array<{ key: string; size: number; lastModified: Date }> = [];
    const walk = (dir: string, rel: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
        else if (!ent.name.includes('.tmp-') && r.startsWith(prefix)) {
          const st = fs.statSync(path.join(dir, ent.name));
          all.push({ key: r, size: st.size, lastModified: st.mtime });
        }
      }
    };
    walk(this.objDir, '');
    const sorted = all.filter((o) => !opts.cursor || o.key > opts.cursor).sort((a, b) => (a.key < b.key ? -1 : 1));
    const page = sorted.slice(0, limit);
    return { objects: page, nextCursor: sorted.length > limit ? page[page.length - 1].key : undefined };
  }

  publicUrl(key: string): string {
    return `${this.publicBase.replace(/\/+$/, '')}/${encodeKeyPath(key)}`;
  }
}

export const sha256OfFile = async (file: string): Promise<{ sha256: string; bytes: number }> => {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    h.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: h.digest('hex'), bytes };
};
