import { createHash, randomBytes } from 'node:crypto';

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Stable asset identity derived from the source *location* (never the filename alone, never the bytes —
 * bytes are verified separately). Lowercase base32, safe in URLs and object keys.
 */
export function assetIdFor(provider: string, bucket: string, normalizedKey: string): string {
  const digest = createHash('sha256').update(`${provider}\u0000${bucket}\u0000${normalizedKey}`).digest();
  return 'a' + base32(digest).slice(0, 24);
}

export interface VariantProfile {
  width: number;
  format: string;
}
export const profileName = (p: VariantProfile): string => `w${p.width}-${p.format}`;

/** Immutable destination key for a variant. */
export function variantKey(namespace: string, version: string, assetId: string, p: VariantProfile): string {
  return `${trimSlashes(namespace)}/${version}/${assetId}/${p.width}.${p.format}`;
}

export const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, '');

/** Deterministic idempotency key for a side effect. */
export function idempotencyKey(scope: string, assetId: string, stage: string, discriminator = ''): string {
  return sha256Hex(`${scope}|${assetId}|${stage}|${discriminator}`).slice(0, 32);
}

export function newRunId(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `run_${ts}_${randomBytes(4).toString('hex')}`;
}

/** Stable JSON (sorted keys) for fingerprints. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export const fingerprint = (value: unknown): string => sha256Hex(stableStringify(value)).slice(0, 16);
