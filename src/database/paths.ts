import { validationError } from '../domain/errors';

/**
 * Field patterns: dotted paths where `[]` iterates an array. Examples:
 *   photo            photos[]            homeSections.categories[].image
 * Concrete paths use numeric segments: photos.2, homeSections.categories.0.image
 */
const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$-]*(\[\])?$/;

export function validateFieldPattern(p: string): string {
  if (!p || p.length > 256) throw validationError('BAD_FIELD_PATTERN', `invalid field pattern: ${JSON.stringify(p)}`);
  for (const seg of p.split('.')) {
    if (!SEGMENT.test(seg)) throw validationError('BAD_FIELD_PATTERN', `invalid segment "${seg}" in field pattern "${p}"`);
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') throw validationError('BAD_FIELD_PATTERN', `forbidden segment "${seg}"`);
    if (seg.startsWith('$')) throw validationError('BAD_FIELD_PATTERN', `operator segments are not allowed: "${seg}"`);
  }
  return p;
}

/** True if a concrete path is an instance of a pattern. */
export function pathMatchesPattern(concrete: string, pattern: string): boolean {
  const c = concrete.split('.');
  const p = pattern.split('.');
  let ci = 0;
  for (const seg of p) {
    if (ci >= c.length) return false;
    if (seg.endsWith('[]')) {
      if (c[ci] !== seg.slice(0, -2) || !/^\d+$/.test(c[ci + 1] ?? '')) return false;
      ci += 2;
    } else {
      if (c[ci] !== seg) return false;
      ci += 1;
    }
  }
  return ci === c.length;
}

export function getAtPath(doc: unknown, path: string): unknown {
  let cur: any = doc;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function setAtPath(doc: any, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') throw validationError('BAD_PATH', `cannot traverse ${path}`);
    cur = cur[segs[i]];
  }
  if (cur === null || typeof cur !== 'object') throw validationError('BAD_PATH', `cannot set ${path}`);
  cur[segs[segs.length - 1]] = value;
}

/** Expand a pattern against a document, yielding every concrete path holding a non-empty string. */
export function expandPattern(doc: unknown, pattern: string): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  const walk = (node: unknown, segs: string[], prefix: string) => {
    if (segs.length === 0) {
      if (typeof node === 'string' && node.length > 0) out.push({ path: prefix, value: node });
      return;
    }
    if (node === null || node === undefined || typeof node !== 'object') return;
    const [seg, ...rest] = segs;
    const join = (s: string) => (prefix ? `${prefix}.${s}` : s);
    if (seg.endsWith('[]')) {
      const name = seg.slice(0, -2);
      const arr = (node as any)[name];
      if (!Array.isArray(arr)) return;
      arr.forEach((el, i) => walk(el, rest, `${join(name)}.${i}`));
    } else {
      walk((node as any)[seg], rest, join(seg));
    }
  };
  walk(doc, pattern.split('.'), '');
  return out;
}

/** Top-level field names touched by a set of patterns (for projections). */
export const rootsOf = (patterns: readonly string[]): string[] => [...new Set(patterns.map((p) => p.split('.')[0].replace('[]', '')))];

/** Collect all expanded refs for several patterns, de-duplicated by concrete path. */
export function expandAll(doc: unknown, patterns: readonly string[]): Array<{ path: string; value: string }> {
  const seen = new Map<string, string>();
  for (const p of patterns) for (const r of expandPattern(doc, p)) seen.set(r.path, r.value);
  return [...seen].map(([path, value]) => ({ path, value }));
}
