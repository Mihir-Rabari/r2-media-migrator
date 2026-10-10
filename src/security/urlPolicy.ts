import { validationError } from '../domain/errors';

/**
 * Object-key validation. Keys come from untrusted database content and bucket listings.
 * Rejects traversal, absolute paths, control characters and ambiguous separators.
 */
export function validateObjectKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) throw validationError('BAD_KEY', 'object key is empty');
  if (key.length > 1024) throw validationError('BAD_KEY', 'object key too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) throw validationError('BAD_KEY', 'object key contains control characters');
  if (key.includes('\\')) throw validationError('BAD_KEY', 'object key contains a backslash');
  if (key.startsWith('/')) throw validationError('BAD_KEY', 'object key must not start with "/"');
  if (/^[a-zA-Z]:/.test(key)) throw validationError('BAD_KEY', 'object key looks like a drive path');
  const segs = key.split('/');
  for (const s of segs) {
    if (s === '' ) throw validationError('BAD_KEY', 'object key has an empty path segment');
    if (s === '.' || s === '..') throw validationError('BAD_KEY', 'object key has a traversal segment');
  }
  return key;
}

export const isValidObjectKey = (key: string): boolean => {
  try {
    validateObjectKey(key);
    return true;
  } catch {
    return false;
  }
};

/** Host allow-list supporting exact hosts and `*.suffix` patterns (one or more labels). */
export class HostPolicy {
  private readonly exact = new Set<string>();
  private readonly suffixes: string[] = [];
  constructor(patterns: readonly string[], private readonly allowHttp = false) {
    for (const raw of patterns) {
      const p = raw.trim().toLowerCase();
      if (!p) continue;
      if (p.startsWith('*.')) this.suffixes.push(p.slice(1)); // ".r2.dev"
      else this.exact.add(p);
    }
  }
  allows(host: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    if (this.exact.has(h)) return true;
    return this.suffixes.some((s) => h.endsWith(s) && h.length > s.length);
  }
  allowsProtocol(protocol: string): boolean {
    return protocol === 'https:' || (this.allowHttp && protocol === 'http:');
  }
}

export interface ParsedMediaUrl {
  host: string;
  /** Percent-decoded exactly once, no leading slash. */
  key: string;
  search: string;
  hash: string;
}

/**
 * Strictly parse an http(s) URL and return its decoded object key.
 * Returns null (never throws) for anything that is not a plain, credential-free, default-port URL on an allowed host.
 */
export function parseAllowedUrl(input: string, policy: HostPolicy): ParsedMediaUrl | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096) return null;
  const trimmed = input.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (!policy.allowsProtocol(u.protocol)) return null;
  if (u.username || u.password) return null;
  if (u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80'))) return null;
  const host = u.hostname.toLowerCase();
  if (!policy.allows(host)) return null;
  // Reject encoded separators / dots before decoding: %2f %5c %2e%2e etc.
  if (/%2f|%5c|%00/i.test(u.pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  // Double-encoding: a decoded value that still decodes to something different is ambiguous.
  if (/%[0-9a-f]{2}/i.test(decoded)) {
    try {
      if (decodeURIComponent(decoded) !== decoded) return null;
    } catch {
      return null;
    }
  }
  const key = decoded.replace(/^\/+/, '');
  if (!isValidObjectKey(key)) return null;
  return { host, key, search: u.search, hash: u.hash };
}

/** Encode a key into a URL path (each segment encoded; slashes preserved). */
export const encodeKeyPath = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

/** Normalise a base URL: https only (unless allowed), no credentials, no query/hash, no trailing slash. */
export function parseBaseUrl(input: string, opts: { allowHttp?: boolean } = {}): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw validationError('BAD_URL', `malformed URL: ${input.slice(0, 80)}`);
  }
  if (u.protocol !== 'https:' && !(opts.allowHttp && u.protocol === 'http:')) throw validationError('BAD_URL', `URL must use https: ${u.origin}`);
  if (u.username || u.password) throw validationError('BAD_URL', 'URL must not embed credentials');
  if (u.search || u.hash) throw validationError('BAD_URL', 'base URL must not have query or fragment');
  return u;
}
