import type { GetOptions, MediaProcessor, ObjectHead, PutOptions, StorageProvider } from '../core/interfaces';
import type { Readable } from 'node:stream';

export interface StorageHooks {
  head?: (key: string) => void | Promise<void>;
  get?: (key: string) => void | Promise<void>;
  put?: (key: string, size: number) => void | Promise<void>;
  delete?: (key: string) => void | Promise<void>;
}

/** Wrap any StorageProvider with async interception points (latency, barriers, injected errors, counting). */
export function interceptStorage(inner: StorageProvider, hooks: StorageHooks): StorageProvider {
  return {
    kind: inner.kind,
    bucket: inner.bucket,
    publicUrl: (k) => inner.publicUrl(k),
    list: (p, o) => inner.list(p, o),
    async head(key) { await hooks.head?.(key); return inner.head(key); },
    async get(key, opts?: GetOptions) { await hooks.get?.(key); return inner.get(key, opts); },
    async put(key, body: Buffer | Readable, opts: PutOptions): Promise<ObjectHead> {
      await hooks.put?.(key, Buffer.isBuffer(body) ? body.length : opts.contentLength ?? 0);
      return inner.put(key, body, opts);
    },
    async delete(key) { await hooks.delete?.(key); return inner.delete(key); },
  };
}

/** A processor that fails for chosen widths/files (processor crash simulation). */
export function faultyProcessor(inner: MediaProcessor, failWhen: (call: number, width: number) => Error | null): MediaProcessor {
  let calls = 0;
  return {
    version: inner.version,
    probe: (f, l) => inner.probe(f, l),
    validate: (f, e) => inner.validate(f, e),
    async generate(f, p, s, o, l) {
      calls++;
      const err = failWhen(calls, s.width);
      if (err) throw err;
      return inner.generate(f, p, s, o, l);
    },
  };
}

/** Concurrency probe: records the maximum number of simultaneously active operations. */
export class ConcurrencyProbe {
  active = 0;
  max = 0;
  total = 0;
  async around<T>(fn: () => Promise<T>): Promise<T> {
    this.active++;
    this.total++;
    this.max = Math.max(this.max, this.active);
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }
}

/** All `parties` callers wait here until everyone has arrived (deterministic proof of real parallelism). */
export class Barrier {
  private arrived = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly parties: number) {}
  async wait(): Promise<void> {
    this.arrived++;
    if (this.arrived >= this.parties) {
      this.waiters.forEach((w) => w());
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }
}
