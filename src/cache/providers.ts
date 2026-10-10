import type { CacheInvalidationProvider, CdnVerifier, PurgeResult } from '../core/interfaces';
import { MediaMigrateError } from '../domain/errors';
import { HostPolicy } from '../security/urlPolicy';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
}>;

/** Reject anything that is not a single, concrete, https URL on an allowed host. Zone-wide / wildcard purges are impossible by construction. */
export function validatePurgeTarget(url: string, allowed: HostPolicy): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not an absolute URL';
  }
  if (u.protocol !== 'https:') return 'purge targets must be https';
  if (url.includes('*')) return 'wildcard purge targets are not allowed';
  if (u.username || u.password) return 'credentials in URL';
  if (!allowed.allows(u.hostname)) return `host ${u.hostname} is not an allowed purge host`;
  if (u.pathname === '/' || u.pathname === '') return 'root path purge is not allowed';
  return null;
}

export class NoopCache implements CacheInvalidationProvider {
  readonly kind = 'none';
  async purge(urls: readonly string[]): Promise<PurgeResult> {
    return { ok: true, accepted: [...urls], rejected: [] };
  }
}

export interface CloudflareOptions {
  zoneId: string;
  apiToken: string;
  /** Hosts in this zone that we may purge (legacy hosts + destination host). */
  allowedHosts: readonly string[];
  fetch?: FetchLike;
  batchSize?: number;
  timeoutMs?: number;
}

/** Per-URL purge through the Cloudflare API (max 30 files per call). Purge acceptance != browser/ISP cache cleared. */
export class CloudflareCache implements CacheInvalidationProvider {
  readonly kind = 'cloudflare';
  private readonly hosts: HostPolicy;
  private readonly fetchFn: FetchLike;
  constructor(private readonly o: CloudflareOptions) {
    if (!/^[a-f0-9]{32}$/i.test(o.zoneId)) throw new MediaMigrateError('validation', 'BAD_ZONE', 'Cloudflare zone id must be 32 hex characters');
    this.hosts = new HostPolicy(o.allowedHosts);
    this.fetchFn = o.fetch ?? ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init));
  }

  async purge(urls: readonly string[]): Promise<PurgeResult> {
    const accepted: string[] = [];
    const rejected: PurgeResult['rejected'] = [];
    const valid: string[] = [];
    for (const u of new Set(urls)) {
      const why = validatePurgeTarget(u, this.hosts);
      if (why) rejected.push({ url: u, reason: why });
      else valid.push(u);
    }
    const size = Math.min(this.o.batchSize ?? 30, 30);
    for (let i = 0; i < valid.length; i += size) {
      const batch = valid.slice(i, i + size);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 20_000);
      let res;
      try {
        res = await this.fetchFn(`https://api.cloudflare.com/client/v4/zones/${this.o.zoneId}/purge_cache`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.o.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: batch }),
          signal: ac.signal,
        });
      } catch (e) {
        throw new MediaMigrateError('transient', 'PURGE_NETWORK', `Cloudflare purge request failed: ${(e as Error).message}`, undefined, { cause: e });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 || res.status >= 500) {
        throw new MediaMigrateError('transient', 'PURGE_THROTTLED', `Cloudflare purge returned HTTP ${res.status}`);
      }
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON error body */
      }
      if (res.ok && body?.success === true) accepted.push(...batch);
      else {
        const msg = body?.errors?.map((e: any) => e.message).join('; ') || `HTTP ${res.status}`;
        for (const b of batch) rejected.push({ url: b, reason: msg });
      }
    }
    return { ok: rejected.length === 0, accepted, rejected };
  }
}

/** In-memory cache provider with scriptable failures. Records every purge request. */
export class FakeCache implements CacheInvalidationProvider {
  readonly kind = 'fake';
  readonly purged: string[] = [];
  calls = 0;
  /** Return a string to reject every URL with that reason, throw to simulate transport failure. */
  behaviour: (urls: readonly string[], call: number) => string | undefined = () => undefined;
  constructor(private readonly allowedHosts: readonly string[] = []) {}
  async purge(urls: readonly string[]): Promise<PurgeResult> {
    this.calls++;
    const policy = new HostPolicy(this.allowedHosts);
    const rejected: PurgeResult['rejected'] = [];
    const accepted: string[] = [];
    const failure = this.behaviour(urls, this.calls);
    for (const u of urls) {
      const why = this.allowedHosts.length ? validatePurgeTarget(u, policy) : null;
      if (why) rejected.push({ url: u, reason: why });
      else if (failure) rejected.push({ url: u, reason: failure });
      else {
        accepted.push(u);
        this.purged.push(u);
      }
    }
    return { ok: rejected.length === 0, accepted, rejected };
  }
}

/** HEAD-checks URLs on the configured destination host only (never user-supplied hosts). */
export class HttpCdnVerifier implements CdnVerifier {
  private readonly hosts: HostPolicy;
  private readonly fetchFn: FetchLike;
  constructor(allowedHosts: readonly string[], fetchFn?: FetchLike, private readonly timeoutMs = 15_000) {
    this.hosts = new HostPolicy(allowedHosts);
    this.fetchFn = fetchFn ?? ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init));
  }
  async verify(url: string, expect: { size?: number }): Promise<{ ok: boolean; status: number; detail?: string }> {
    const why = validatePurgeTarget(url, this.hosts);
    if (why) return { ok: false, status: 0, detail: why };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url, { method: 'HEAD', signal: ac.signal });
      if (!res.ok) return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
      const len = res.headers.get('content-length');
      if (expect.size !== undefined && len !== null && Number(len) !== expect.size) return { ok: false, status: res.status, detail: `content-length ${len} != expected ${expect.size}` };
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, status: 0, detail: `request failed: ${(e as Error).message}` };
    } finally {
      clearTimeout(t);
    }
  }
}
