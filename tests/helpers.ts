import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function tmpDir(prefix = 'mmt-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Run `fn` with a fresh temp dir that is removed afterwards. */
export async function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = tmpDir();
  try {
    return await fn(dir);
  } finally {
    rmrf(dir);
  }
}

/** Deterministic PRNG (mulberry32) for reproducible randomized tests. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
