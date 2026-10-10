import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { validationError } from '../domain/errors';

/** Resolve `relative` under `root`, refusing anything that escapes it. */
export function safeJoin(root: string, relative: string): string {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, relative);
  const rel = path.relative(rootAbs, target);
  if (rel === '' ) return target;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw validationError('PATH_ESCAPE', 'path escapes its root directory');
  }
  return target;
}

/** Create a private temp directory under `base` (created if needed). */
export function makeTempDir(base: string, prefix = 'mm-'): string {
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, `${prefix}${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** Remove stale `mm-*` temp directories older than `maxAgeMs`. Returns the number removed. */
export function cleanStaleTemp(base: string, maxAgeMs: number, now = Date.now()): number {
  let removed = 0;
  if (!fs.existsSync(base)) return 0;
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith('mm-')) continue;
    const p = path.join(base, name);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory() && now - st.mtimeMs >= maxAgeMs) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* raced with another cleaner */
    }
  }
  return removed;
}
