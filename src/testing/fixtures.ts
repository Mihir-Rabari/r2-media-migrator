import sharp from 'sharp';

/**
 * Programmatically generated, licence-free image fixtures. Pixel data is a pure function of the
 * arguments, so fixtures are reproducible without committing binaries.
 */
function pattern(w: number, h: number, channels: 3 | 4, seed = 0): Buffer {
  const buf = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels;
      buf[i] = (x * 255 / Math.max(1, w - 1) + seed * 40) & 255;
      buf[i + 1] = (y * 255 / Math.max(1, h - 1)) & 255;
      buf[i + 2] = ((x ^ y) * 3 + seed) & 255;
      if (channels === 4) buf[i + 3] = x < w / 2 ? 255 : 64; // right half semi-transparent
    }
  }
  return buf;
}

export async function jpegFixture(w: number, h: number, seed = 0, quality = 90): Promise<Buffer> {
  return sharp(pattern(w, h, 3, seed), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality }).toBuffer();
}
export async function pngFixture(w: number, h: number, alpha = true, seed = 0): Promise<Buffer> {
  const c = alpha ? 4 : 3;
  return sharp(pattern(w, h, c, seed), { raw: { width: w, height: h, channels: c } }).png().toBuffer();
}
export async function webpFixture(w: number, h: number, seed = 0): Promise<Buffer> {
  return sharp(pattern(w, h, 3, seed), { raw: { width: w, height: h, channels: 3 } }).webp({ quality: 80 }).toBuffer();
}
/** Stored w x h with EXIF orientation tag set (6 = rotate 90 CW => displays as h x w). */
export async function exifRotatedJpeg(w: number, h: number, orientation = 6): Promise<Buffer> {
  return sharp(pattern(w, h, 3), { raw: { width: w, height: h, channels: 3 } }).jpeg().withMetadata({ orientation }).toBuffer();
}
/** JPEG carrying EXIF (camera make) + the given orientation, to test metadata stripping. */
export async function jpegWithExif(w: number, h: number): Promise<Buffer> {
  return sharp(pattern(w, h, 3), { raw: { width: w, height: h, channels: 3 } })
    .jpeg()
    .withExif({ IFD0: { Make: 'FixtureCam', Copyright: 'fixture' } })
    .toBuffer();
}
async function frames(w: number, h: number, n: number): Promise<Buffer[]> {
  return Promise.all(
    Array.from({ length: n }, (_, i) => sharp(pattern(w, h, 3, i), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()),
  );
}
export async function animatedGif(w: number, h: number, n = 3): Promise<Buffer> {
  return sharp(await frames(w, h, n), { join: { animated: true } } as never).gif({ loop: 0, delay: Array(n).fill(100) }).toBuffer();
}
export async function animatedWebp(w: number, h: number, n = 3): Promise<Buffer> {
  return sharp(await frames(w, h, n), { join: { animated: true } } as never).webp({ loop: 0, delay: Array(n).fill(100) }).toBuffer();
}
/** Smooth gradient (no high-frequency noise) for perceptual-similarity checks. */
export async function smoothJpeg(w: number, h: number): Promise<Buffer> {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    buf[i] = (x * 255) / w; buf[i + 1] = (y * 255) / h; buf[i + 2] = 128 + 60 * Math.sin((x + y) / 90);
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}
export const truncated = (b: Buffer, keep = 0.5): Buffer => b.subarray(0, Math.floor(b.length * keep));
export const svgFixture = (): Buffer => Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
export const htmlFixture = (): Buffer => Buffer.from('<!DOCTYPE html><html><body>not an image</body></html>');
export const randomBytes = (n: number, seed = 1): Buffer => {
  const b = Buffer.alloc(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    b[i] = s >>> 24;
  }
  return b;
};
