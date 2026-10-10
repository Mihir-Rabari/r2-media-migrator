import * as path from 'node:path';

export interface Sniffed {
  mime: string;
  ext: string;
  mediaType: 'image' | 'video' | 'other';
}

/** Content-based type detection from magic bytes (extensions are never trusted). */
export function sniff(head: Buffer): Sniffed | null {
  const b = head;
  const ascii = (s: number, e: number) => b.subarray(s, e).toString('latin1');
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', mediaType: 'image' };
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG') return { mime: 'image/png', ext: 'png', mediaType: 'image' };
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp', mediaType: 'image' };
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return { mime: 'image/gif', ext: 'gif', mediaType: 'image' };
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) {
    return { mime: 'image/tiff', ext: 'tiff', mediaType: 'image' };
  }
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif', mediaType: 'image' };
    if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) return { mime: 'image/heif', ext: 'heic', mediaType: 'image' };
    return { mime: 'video/mp4', ext: 'mp4', mediaType: 'video' };
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'video/webm', ext: 'webm', mediaType: 'video' };
  const text = b.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (text.startsWith('<?xml') || text.startsWith('<svg')) return { mime: 'image/svg+xml', ext: 'svg', mediaType: 'other' };
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return { mime: 'text/html', ext: 'html', mediaType: 'other' };
  return null;
}

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.heic': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
export const mimeFromKey = (key: string): string | null => EXT_MIME[path.extname(key).toLowerCase()] ?? null;
export const mediaTypeFromMime = (mime: string | null): 'image' | 'video' | 'other' =>
  mime?.startsWith('image/') && mime !== 'image/svg+xml' ? 'image' : mime?.startsWith('video/') ? 'video' : 'other';
