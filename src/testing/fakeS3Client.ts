import { Readable } from 'node:stream';
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { toBuffer } from '../storage/memoryStorage';

class S3Err extends Error {
  $metadata: { httpStatusCode: number };
  constructor(name: string, status: number, msg = name) {
    super(msg);
    this.name = name;
    this.$metadata = { httpStatusCode: status };
  }
}

export interface FakeS3Faults {
  /** Called before each command; may throw to simulate throttling / permission failures. */
  beforeSend?: (cmd: string, key: string | undefined) => void | Promise<void>;
}

/**
 * Minimal S3 protocol emulation (head/get/put/delete/list incl. Range, If-None-Match, metadata) used to
 * contract-test S3Storage's request/response mapping without a network. NOT a substitute for real R2.
 */
export class FakeS3Client {
  readonly store = new Map<string, { data: Buffer; contentType?: string; cacheControl?: string; metadata: Record<string, string>; etag: string; lastModified: Date }>();
  sent: string[] = [];
  private n = 0;
  constructor(private readonly faults: FakeS3Faults = {}) {}

  async send(cmd: unknown): Promise<any> {
    const name = (cmd as object).constructor.name;
    const input = (cmd as { input: any }).input;
    this.sent.push(name);
    await this.faults.beforeSend?.(name, input.Key);
    if (cmd instanceof HeadObjectCommand) {
      const o = this.store.get(input.Key);
      if (!o) throw new S3Err('NotFound', 404);
      return { ContentLength: o.data.length, ContentType: o.contentType, CacheControl: o.cacheControl, Metadata: o.metadata, ETag: o.etag, LastModified: o.lastModified };
    }
    if (cmd instanceof GetObjectCommand) {
      const o = this.store.get(input.Key);
      if (!o) throw new S3Err('NoSuchKey', 404);
      let data = o.data;
      let contentRange: string | undefined;
      if (input.Range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(input.Range)!;
        const start = Number(m[1]);
        const end = Math.min(m[2] ? Number(m[2]) : data.length - 1, data.length - 1);
        if (start >= data.length) throw new S3Err('InvalidRange', 416);
        contentRange = `bytes ${start}-${end}/${data.length}`;
        data = data.subarray(start, end + 1);
      }
      return {
        Body: Readable.from([data]), ContentLength: data.length, ContentType: o.contentType, CacheControl: o.cacheControl, Metadata: o.metadata,
        ETag: o.etag, LastModified: o.lastModified, ContentRange: contentRange,
      };
    }
    if (cmd instanceof PutObjectCommand) {
      if (input.IfNoneMatch === '*' && this.store.has(input.Key)) throw new S3Err('PreconditionFailed', 412);
      const data = await toBuffer(input.Body);
      if (input.ContentLength !== undefined && input.ContentLength !== data.length) throw new S3Err('IncompleteBody', 400);
      const md: Record<string, string> = {};
      for (const [k, v] of Object.entries(input.Metadata ?? {})) md[k.toLowerCase()] = String(v);
      this.store.set(input.Key, { data, contentType: input.ContentType, cacheControl: input.CacheControl, metadata: md, etag: `"e${this.n++}"`, lastModified: new Date() });
      return {};
    }
    if (cmd instanceof DeleteObjectCommand) {
      this.store.delete(input.Key);
      return {};
    }
    if (cmd instanceof ListObjectsV2Command) {
      const keys = [...this.store.keys()].filter((k) => k.startsWith(input.Prefix ?? '') && (!input.ContinuationToken || k > input.ContinuationToken)).sort();
      const max = input.MaxKeys ?? 1000;
      const page = keys.slice(0, max);
      return {
        Contents: page.map((k) => ({ Key: k, Size: this.store.get(k)!.data.length, LastModified: this.store.get(k)!.lastModified })),
        IsTruncated: keys.length > max,
        NextContinuationToken: keys.length > max ? page[page.length - 1] : undefined,
      };
    }
    throw new Error(`FakeS3Client: unsupported command ${name}`);
  }
}

export { S3Err as FakeS3Error };
