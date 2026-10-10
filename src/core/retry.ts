import { isRetryable } from '../domain/errors';

export interface RetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 0..1 fraction of the delay randomised. */
  jitter: number;
}

/** Exponential backoff with bounded jitter. `rand` is injectable for deterministic tests. */
export function backoffDelay(attempt: number, p: RetryPolicy, rand: () => number = Math.random): number {
  const exp = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const lo = exp * (1 - p.jitter);
  return Math.round(lo + rand() * (exp - lo)); // always within [exp*(1-jitter), exp] <= maxDelayMs
}

export const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

export interface RetryHooks {
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  classify?: (err: unknown) => boolean;
  shouldStop?: () => boolean;
}

/** Retry only errors classified as transient, never more than policy.maxAttempts times. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, policy: RetryPolicy, hooks: RetryHooks = {}): Promise<T> {
  const classify = hooks.classify ?? isRetryable;
  const sleep = hooks.sleep ?? realSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= policy.maxAttempts || !classify(err) || hooks.shouldStop?.()) throw err;
      const delay = backoffDelay(attempt, policy, hooks.rand);
      hooks.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}
