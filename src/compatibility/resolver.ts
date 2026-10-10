import { assetIdFor } from '../domain/ids';
import { HostPolicy, encodeKeyPath, parseAllowedUrl } from '../security/urlPolicy';

export interface ResolverOptions {
  legacyHosts: readonly string[];
  neverRewriteHosts?: readonly string[];
  allowHttp?: boolean;
  /** Provider/bucket identify the source for asset-id derivation. */
  sourceProvider: string;
  sourceBucket: string;
  includePrefixes?: readonly string[];
  excludePrefixes?: readonly string[];
  /** Destination public base (e.g. https://cdn.example.com) and layout. */
  publicBaseUrl: string;
  namespace: string;
  namespaceVersion: string;
  widths: readonly number[];
  format: string;
  referenceVariantWidth: number;
}

export type Classification =
  | { kind: 'legacy'; key: string; host: string; assetId: string; search: string }
  | { kind: 'canonical'; assetId: string; width: number; url: string }
  | { kind: 'excluded'; key: string; reason: string }
  | { kind: 'external'; host: string | null }
  | { kind: 'invalid' };

export interface MappingEntry {
  assetId: string;
  sourceKey: string;
  /** Widths that actually exist and are verified, with real pixel widths. */
  variants: Array<{ width: number; effectiveWidth: number; format: string; /** object key in the destination bucket */ key?: string }>;
  state: string;
}

const CANONICAL_TAIL = /^([a-z2-7]{25})\/(\d+)\.([a-z0-9]+)$/;

/**
 * Pure, DB-free URL classifier/resolver. Only assets present in the (verified) mapping resolve; unknown
 * legacy URLs are reported, never guessed. normalize(normalize(x)) === normalize(x).
 */
export class MediaUrlResolver {
  private readonly legacy: HostPolicy;
  private readonly never: HostPolicy;
  private readonly destPolicy: HostPolicy;
  private readonly destOrigin: string;
  private readonly destPathPrefix: string;
  private readonly byKey = new Map<string, MappingEntry>();
  private readonly byId = new Map<string, MappingEntry>();
  /** Counts of unresolved legacy references, for observability. */
  readonly unresolved = new Map<string, number>();

  constructor(private readonly o: ResolverOptions, mapping: Iterable<MappingEntry> = []) {
    this.legacy = new HostPolicy(o.legacyHosts, o.allowHttp ?? false);
    this.never = new HostPolicy(o.neverRewriteHosts ?? [], true);
    const base = new URL(o.publicBaseUrl);
    this.destOrigin = base.origin;
    this.destPathPrefix = base.pathname.replace(/\/+$/, '');
    this.destPolicy = new HostPolicy([base.hostname], o.allowHttp ?? false);
    for (const m of mapping) this.add(m);
  }

  add(m: MappingEntry): void {
    this.byKey.set(m.sourceKey, m);
    this.byId.set(m.assetId, m);
  }
  get size(): number {
    return this.byId.size;
  }

  private inScope(key: string): string | null {
    const ns = `${this.o.namespace}/`;
    if (key.startsWith(ns)) return 'inside-destination-namespace';
    if ((this.o.excludePrefixes ?? []).some((p) => key.startsWith(p))) return 'excluded-prefix';
    const inc = this.o.includePrefixes ?? [];
    if (inc.length && !inc.some((p) => key.startsWith(p))) return 'outside-include-prefixes';
    return null;
  }

  /** Canonical URL for an asset at a given nominal width. */
  canonicalUrl(assetId: string, width: number = this.o.referenceVariantWidth): string {
    return `${this.destOrigin}${this.destPathPrefix}/${this.o.namespace}/${this.o.namespaceVersion}/${assetId}/${width}.${this.o.format}`;
  }

  classify(input: string): Classification {
    if (typeof input !== 'string' || !input) return { kind: 'invalid' };
    // canonical?
    const canon = this.parseCanonical(input);
    if (canon) return canon;
    let host: string | null = null;
    try {
      host = new URL(input.trim()).hostname.toLowerCase();
    } catch {
      return { kind: 'external', host: null }; // relative paths, data: URIs, junk — never ours to rewrite
    }
    if (this.never.allows(host)) return { kind: 'external', host };
    const parsed = parseAllowedUrl(input, this.legacy);
    if (!parsed) return this.legacy.allows(host) ? { kind: 'invalid' } : { kind: 'external', host };
    const reason = this.inScope(parsed.key);
    if (reason) return { kind: 'excluded', key: parsed.key, reason };
    return { kind: 'legacy', key: parsed.key, host: parsed.host, assetId: assetIdFor(this.o.sourceProvider, this.o.sourceBucket, parsed.key), search: parsed.search };
  }

  private parseCanonical(input: string): Classification | null {
    let u: URL;
    try {
      u = new URL(input.trim());
    } catch {
      return null;
    }
    if (u.origin !== this.destOrigin || u.username || u.password) return null;
    const prefix = `${this.destPathPrefix}/${this.o.namespace}/${this.o.namespaceVersion}/`;
    if (!u.pathname.startsWith(prefix)) return null;
    const m = CANONICAL_TAIL.exec(u.pathname.slice(prefix.length));
    if (!m || m[3] !== this.o.format) return null;
    return { kind: 'canonical', assetId: m[1], width: Number(m[2]), url: this.canonicalUrl(m[1], Number(m[2])) };
  }

  /** Object key of a variant in the destination bucket. */
  variantObjectKey(assetId: string, width: number = this.o.referenceVariantWidth): string {
    return `${this.o.namespace}/${this.o.namespaceVersion}/${assetId}/${width}.${this.o.format}`;
  }
  get referenceWidth(): number {
    return this.o.referenceVariantWidth;
  }

  /**
   * Resolve any media URL to its canonical form.
   *  - canonical -> itself (idempotent)
   *  - legacy with a verified mapping -> canonical reference URL
   *  - everything else -> null (caller keeps the original value)
   */
  resolve(input: string, width?: number): { url: string; assetId: string } | null {
    const c = this.classify(input);
    if (c.kind === 'canonical') {
      const e = this.byId.get(c.assetId);
      if (width === undefined) return { url: c.url, assetId: c.assetId };
      return e && this.hasWidth(e, width) ? { url: this.canonicalUrl(c.assetId, width), assetId: c.assetId } : null;
    }
    if (c.kind !== 'legacy') return null;
    const e = this.byKey.get(c.key);
    if (!e) {
      this.unresolved.set(c.key, (this.unresolved.get(c.key) ?? 0) + 1);
      return null;
    }
    const w = width ?? this.o.referenceVariantWidth;
    if (!this.hasWidth(e, w)) return null;
    return { url: this.canonicalUrl(e.assetId, w), assetId: e.assetId };
  }

  private hasWidth(e: MappingEntry, w: number): boolean {
    return e.variants.some((v) => v.width === w);
  }

  /** Mapping entry for a key (used by the HTTP compatibility handler). */
  lookupKey(key: string): MappingEntry | undefined {
    return this.byKey.get(key);
  }

  /** The legacy public URL for a key on a given host (used for cache purge lists). */
  legacyUrl(host: string, key: string): string {
    return `https://${host}/${encodeKeyPath(key)}`;
  }

  /** Is this URL on the destination origin (used to refuse purging foreign hosts). */
  isDestinationUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return this.destPolicy.allows(u.hostname);
    } catch {
      return false;
    }
  }
  isLegacyHost(host: string): boolean {
    return this.legacy.allows(host);
  }
}
