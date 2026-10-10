import type { DatabaseProvider } from '../core/interfaces';
import type { MediaUrlResolver } from '../compatibility/resolver';
import { pathMatchesPattern } from '../database/paths';

export interface DiscoveredField {
  collection: string;
  /** Pattern form: `photos[]`, `homeSections.categories[].image`. */
  pattern: string;
  samples: number;
  legacyHostHits: number;
  mediaExtensionHits: number;
  externalHits: number;
  alreadyConfigured: boolean;
  example: string | null;
}

const MEDIA_EXT = /\.(jpe?g|png|webp|gif|avif|svg|mp4|webm|mov)(\?|#|$)/i;

/** Collect leaf strings with their pattern-form paths. Arrays collapse to `[]`; depth and size bounded. */
function leaves(node: unknown, prefix: string, out: Array<{ pattern: string; value: string }>, depth = 0): void {
  if (depth > 8 || out.length > 5000) return;
  if (typeof node === 'string') {
    out.push({ pattern: prefix, value: node });
    return;
  }
  if (Array.isArray(node)) {
    for (const el of node.slice(0, 50)) leaves(el, `${prefix}[]`, out, depth + 1);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '_id' || k.startsWith('$')) continue;
      leaves(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  }
}

/**
 * Sample documents and report which fields *look like* media references (legacy-host URL or media file extension).
 * This only SUGGESTS fields; nothing is ever written to the database for a field that is not in the config map.
 */
export async function discoverMediaFields(
  db: DatabaseProvider, resolver: MediaUrlResolver, collections: ReadonlyArray<{ name: string; fields: readonly string[] }>, sampleSize = 200,
): Promise<DiscoveredField[]> {
  const out: DiscoveredField[] = [];
  for (const c of collections) {
    const byPattern = new Map<string, DiscoveredField>();
    for (const doc of await db.sample(c.name, sampleSize)) {
      const ls: Array<{ pattern: string; value: string }> = [];
      leaves(doc, '', ls);
      for (const l of ls) {
        const cls = resolver.classify(l.value);
        const isLegacy = cls.kind === 'legacy' || cls.kind === 'excluded' || cls.kind === 'canonical';
        const isExt = MEDIA_EXT.test(l.value) && /^https?:\/\//i.test(l.value);
        if (!isLegacy && !isExt) continue;
        let f = byPattern.get(l.pattern);
        if (!f) {
          f = { collection: c.name, pattern: l.pattern, samples: 0, legacyHostHits: 0, mediaExtensionHits: 0, externalHits: 0, alreadyConfigured: c.fields.some((p) => p === l.pattern), example: l.value };
          byPattern.set(l.pattern, f);
        }
        f.samples++;
        if (isLegacy) f.legacyHostHits++;
        else if (isExt) f.externalHits++;
        if (isExt) f.mediaExtensionHits++;
      }
    }
    out.push(...[...byPattern.values()].sort((a, b) => b.samples - a.samples));
  }
  void pathMatchesPattern;
  return out;
}
