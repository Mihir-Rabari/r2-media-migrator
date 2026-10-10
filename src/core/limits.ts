import { MediaMigrateError } from '../domain/errors';

/**
 * Byte-weighted semaphore bounding temporary disk (and in-flight memory) use (invariant I11).
 * Waiters are served FIFO; a request larger than the whole budget fails immediately instead of deadlocking.
 */
export class ByteBudget {
  private used = 0;
  private peakUsed = 0;
  private waiters: Array<{ n: number; resolve: () => void }> = [];
  constructor(readonly capacity: number) {}

  get inUse(): number {
    return this.used;
  }
  get peak(): number {
    return this.peakUsed;
  }
  get waiting(): number {
    return this.waiters.length;
  }

  async acquire(n: number): Promise<() => void> {
    if (n > this.capacity) {
      throw new MediaMigrateError('permanent', 'BUDGET_EXCEEDED', `request of ${n} bytes exceeds temp budget of ${this.capacity}`);
    }
    if (this.used + n > this.capacity || this.waiters.length > 0) {
      await new Promise<void>((resolve) => this.waiters.push({ n, resolve }));
    } else {
      this.take(n);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= n;
      this.drain();
    };
  }

  private take(n: number) {
    this.used += n;
    this.peakUsed = Math.max(this.peakUsed, this.used);
  }

  private drain() {
    while (this.waiters.length && this.used + this.waiters[0].n <= this.capacity) {
      const w = this.waiters.shift()!;
      this.take(w.n);
      w.resolve();
    }
  }
}

/** Counting semaphore tracking the observed high-water mark (asserted by concurrency tests). */
export class Semaphore {
  private active = 0;
  private maxActive = 0;
  private queue: Array<() => void> = [];
  constructor(readonly limit: number) {
    if (limit < 1) throw new MediaMigrateError('validation', 'BAD_CONCURRENCY', 'concurrency must be >= 1');
  }
  get high(): number {
    return this.maxActive;
  }
  get running(): number {
    return this.active;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    else this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Token-bucket style limiter: at most `perSecond` starts per second. Clock and sleep are injectable. */
export class RateLimiter {
  private nextSlot = 0;
  constructor(
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  async take(): Promise<void> {
    if (!(this.perSecond > 0) || !Number.isFinite(this.perSecond)) return;
    const interval = 1000 / this.perSecond;
    const t = this.now();
    const slot = Math.max(this.nextSlot, t);
    this.nextSlot = slot + interval;
    const wait = slot - t;
    if (wait > 0) await this.sleep(wait);
  }
}
