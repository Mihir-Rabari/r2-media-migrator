import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import type { StorageProvider } from '../core/interfaces';
import { isValidObjectKey } from '../security/urlPolicy';
import type { MediaUrlResolver } from './resolver';

export interface LegacyHandlerOptions {
  /** Resolver loaded with the VERIFIED mapping (see `export-mapping`). Only mapped assets are ever served/redirected. */
  resolver: MediaUrlResolver | (() => MediaUrlResolver);
  /** Path prefixes this handler owns, e.g. ['/legacy-media']. Matching is exact on segment boundaries. */
  routePrefixes: readonly string[];
  mode: 'redirect' | 'stream';
  redirectStatus?: 301 | 302 | 307 | 308;
  /** Required for mode=stream. Reads are restricted to keys derived from the mapping. */
  storage?: StorageProvider;
  /** stream mode: serve the optimised variant (default) or the untouched original under the legacy key. */
  serve?: 'variant' | 'original';
  /** Called for every request that matched a prefix but had no verified mapping. */
  onUnresolved?: (key: string) => void;
  /** Prepended to the path remainder to form the object key (e.g. 'products/'). */
  keyPrefix?: string;
  cacheControl?: string;
}

type Next = (err?: unknown) => void;

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

/** Parse a single `bytes=` range. Returns null for absent/unsupported (multi-range => serve whole), 'invalid' if unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return header.includes(',') ? null : 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

/**
 * Framework-neutral handler for LEGACY media URLs THAT ACTUALLY REACH OUR APPLICATION. Works as Express middleware
 * (`app.use(handler)`) or a bare `http` listener. It cannot see traffic sent straight to a CDN hostname.
 *
 * Safety: the only inputs are the request path and optional `?w=`; the object key is derived from the path, validated,
 * and must exist in the verified mapping. No URL is ever fetched; redirects only target the configured destination origin;
 * redirect loops are refused.
 */
export function createLegacyMediaHandler(o: LegacyHandlerOptions) {
  const prefixes = [...o.routePrefixes].map((p) => p.replace(/\/+$/, ''));
  if (prefixes.some((p) => !p.startsWith('/') || p === '')) throw new Error('routePrefixes must be non-empty absolute paths');
  if (o.mode === 'stream' && !o.storage) throw new Error('stream mode requires a storage provider');
  const status = o.redirectStatus ?? 308;
  const getResolver = typeof o.resolver === 'function' ? o.resolver : () => o.resolver as MediaUrlResolver;

  return async function legacyMediaHandler(req: IncomingMessage, res: ServerResponse, next?: Next): Promise<void> {
    try {
      const rawUrl = req.url ?? '/';
      const qIdx = rawUrl.indexOf('?');
      const rawPath = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
      const query = qIdx === -1 ? '' : rawUrl.slice(qIdx + 1);
      const prefix = prefixes.find((p) => rawPath === p || rawPath.startsWith(p + '/'));
      if (!prefix) {
        if (next) return next();
        return send(res, 404, 'not found');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });

      // path -> key: percent-decode ONCE; refuse encoded separators / double encoding / traversal
      const rest = rawPath.slice(prefix.length).replace(/^\/+/, '');
      if (!rest || /%2f|%5c|%00|%2e%2e/i.test(rest)) return send(res, 400, 'bad request');
      let decoded: string;
      try {
        decoded = decodeURIComponent(rest);
      } catch {
        return send(res, 400, 'bad request');
      }
      if (/%[0-9a-f]{2}/i.test(decoded)) return send(res, 400, 'bad request');
      const key = (o.keyPrefix ?? '') + decoded;
      if (!isValidObjectKey(key)) return send(res, 400, 'bad request');

      const resolver = getResolver();
      const entry = resolver.lookupKey(key);
      if (!entry) {
        o.onUnresolved?.(key);
        if (next) return next(); // let the app's own handlers decide (never guess a canonical URL)
        return send(res, 404, 'not found');
      }

      // optional width selection, strictly limited to widths that exist and are verified
      let width = resolver.referenceWidth;
      const wParam = new URLSearchParams(query).get('w');
      if (wParam !== null) {
        const w = Number(wParam);
        if (!/^\d+$/.test(wParam) || !entry.variants.some((v) => v.width === w)) return send(res, 400, 'unsupported width');
        width = w;
      }

      if (o.mode === 'redirect') {
        const target = resolver.canonicalUrl(entry.assetId, width);
        const t = new URL(target);
        const sameHost = (req.headers.host ?? '').toLowerCase() === t.host.toLowerCase();
        if (sameHost && prefixes.some((p) => t.pathname === p || t.pathname.startsWith(p + '/'))) {
          return send(res, 508, 'redirect loop prevented');
        }
        res.writeHead(status, {
          Location: target, 'Cache-Control': o.cacheControl ?? (status === 301 || status === 308 ? 'public, max-age=86400' : 'public, max-age=300'),
          'Content-Length': 0, 'X-Content-Type-Options': 'nosniff',
        });
        return void res.end();
      }

      // ---- bounded streaming (never buffers the object)
      const storage = o.storage!;
      const objKey = o.serve === 'original' ? entry.sourceKey : resolver.variantObjectKey(entry.assetId, width);
      const head = await storage.head(objKey);
      if (!head) return send(res, 404, 'not found');
      const etag = head.etag;
      const baseHeaders: Record<string, string> = {
        'Content-Type': head.contentType ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': o.cacheControl ?? head.cacheControl ?? 'public, max-age=86400',
      };
      if (etag) baseHeaders.ETag = etag;
      if (head.lastModified) baseHeaders['Last-Modified'] = head.lastModified.toUTCString();

      const inm = req.headers['if-none-match'];
      if (etag && inm && inm.split(',').some((t) => t.trim() === etag || t.trim() === '*')) {
        res.writeHead(304, baseHeaders);
        return void res.end();
      }
      const range = parseRange(req.headers.range, head.size);
      if (range === 'invalid') {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${head.size}`, 'Content-Length': 0 });
        return void res.end();
      }
      if (req.method === 'HEAD') {
        res.writeHead(range ? 206 : 200, { ...baseHeaders, 'Content-Length': range ? range.end - range.start + 1 : head.size, ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${head.size}` } : {}) });
        return void res.end();
      }
      const got = await storage.get(objKey, range ? { range } : {});
      res.writeHead(range ? 206 : 200, {
        ...baseHeaders, 'Content-Length': range ? range.end - range.start + 1 : head.size,
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${head.size}` } : {}),
      });
      pipeline(got.body, res, () => undefined); // backpressure-aware; errors after headers terminate the socket
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      if (next) return next(e);
      send(res, 502, 'upstream error');
    }
  };
}
