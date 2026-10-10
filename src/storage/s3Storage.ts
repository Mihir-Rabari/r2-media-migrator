import { Readable } from 'node:stream';
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import type { GetOptions, ListPage, ObjectHead, PutOptions, StorageProvider } from '../core/interfaces';
import { MediaMigrateError } from '../domain/errors';
import { encodeKeyPath, validateObjectKey } from '../security/urlPolicy';

export interface S3StorageOptions {
  bucket: string;
  /** e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  publicBaseUrl: string;
  /** Injectable for tests: anything with `send(command)`. */
  client?: Pick<S3Client, 'send'>;
  requestTimeoutMs?: number;
}

/** Translate SDK errors into the tool's taxonomy (transient errors keep SDK metadata so isRetryable works). */
export function mapS3Error(err: unknown, key: string): Error {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; message?: string; code?: string };
  const status = e?.$metadata?.httpStatusCode;
  if (e?.name === 'NoSuchKey' || e?.name === 'NotFound' || status === 404) {
    return new MediaMigrateError('not-found', 'NOT_FOUND', `no such object: ${key}`, undefined, { cause: err });
  }
  if (e?.name === 'PreconditionFailed' || status === 412) {
    return new MediaMigrateError('conflict', 'EXISTS', `object already exists: ${key}`, undefined, { cause: err });
  }
  if (status === 401 || status === 403 || e?.name === 'AccessDenied') {
    return new MediaMigrateError('permanent', 'ACCESS_DENIED', `access denied for ${key} (check credentials / bucket permissions)`, undefined, { cause: err });
  }
  if (status === 416 || e?.name === 'InvalidRange') {
    return new MediaMigrateError('permanent', 'RANGE_NOT_SATISFIABLE', 'range not satisfiable', undefined, { cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

function toHead(key: string, r: any): ObjectHead {
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.Metadata ?? {})) metadata[k.toLowerCase()] = String(v);
  return {
    key, size: Number(r.ContentLength ?? 0), etag: r.ETag, contentType: r.ContentType, cacheControl: r.CacheControl, metadata, lastModified: r.LastModified,
  };
}

/** S3-compatible (Cloudflare R2, AWS S3, MinIO) storage adapter. */
export class S3Storage implements StorageProvider {
  readonly kind = 's3';
  readonly bucket: string;
  private readonly client: Pick<S3Client, 'send'>;
  constructor(private readonly o: S3StorageOptions) {
    this.bucket = o.bucket;
    this.client =
      o.client ??
      new S3Client({
        region: o.region ?? 'auto',
        endpoint: o.endpoint,
        forcePathStyle: o.forcePathStyle,
        credentials: o.accessKeyId && o.secretAccessKey ? { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey } : undefined,
        maxAttempts: 1, // retries are owned by the engine's retry policy so they are counted and bounded
        requestHandler: { requestTimeout: o.requestTimeoutMs ?? 30_000, connectionTimeout: 10_000 } as never,
      });
  }

  async head(key: string): Promise<ObjectHead | null> {
    validateObjectKey(key);
    try {
      return toHead(key, await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })));
    } catch (e) {
      const m = mapS3Error(e, key);
      if (m instanceof MediaMigrateError && m.kind === 'not-found') return null;
      throw m;
    }
  }

  async get(key: string, opts: GetOptions = {}) {
    validateObjectKey(key);
    let range: string | undefined;
    if (opts.range) range = `bytes=${opts.range.start}-${opts.range.end ?? ''}`;
    try {
      const r: any = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }), { abortSignal: opts.signal } as never);
      const head = toHead(key, r);
      let rangeInfo: { start: number; end: number; total: number } | undefined;
      if (opts.range && typeof r.ContentRange === 'string') {
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(r.ContentRange);
        if (m) {
          rangeInfo = { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
          head.size = rangeInfo.total;
        }
      }
      const body: Readable = r.Body instanceof Readable ? r.Body : Readable.fromWeb(r.Body);
      return { head, body, range: rangeInfo };
    } catch (e) {
      throw mapS3Error(e, key);
    }
  }

  async put(key: string, body: Buffer | Readable, opts: PutOptions): Promise<ObjectHead> {
    validateObjectKey(key);
    if (!Buffer.isBuffer(body) && opts.contentLength === undefined) {
      throw new MediaMigrateError('internal', 'NEEDS_LENGTH', 'stream uploads require contentLength');
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket, Key: key, Body: body, ContentType: opts.contentType, CacheControl: opts.cacheControl, Metadata: opts.metadata,
          ContentLength: opts.contentLength ?? (Buffer.isBuffer(body) ? body.length : undefined), IfNoneMatch: opts.ifNoneMatch ? '*' : undefined,
        }),
      );
    } catch (e) {
      throw mapS3Error(e, key);
    }
    const head = await this.head(key);
    if (!head) throw new MediaMigrateError('transient', 'PUT_NOT_VISIBLE', `object ${key} not visible after put`);
    return head;
  }

  async delete(key: string): Promise<void> {
    validateObjectKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e) {
      throw mapS3Error(e, key);
    }
  }

  async list(prefix: string, opts: { limit?: number; cursor?: string } = {}): Promise<ListPage> {
    try {
      const r: any = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: opts.limit ?? 1000, ContinuationToken: opts.cursor }),
      );
      return {
        objects: (r.Contents ?? []).filter((c: any) => c.Key && !c.Key.endsWith('/')).map((c: any) => ({ key: c.Key, size: c.Size ?? 0, lastModified: c.LastModified })),
        nextCursor: r.IsTruncated ? r.NextContinuationToken : undefined,
      };
    } catch (e) {
      throw mapS3Error(e, prefix);
    }
  }

  publicUrl(key: string): string {
    return `${this.o.publicBaseUrl.replace(/\/+$/, '')}/${encodeKeyPath(key)}`;
  }
}
