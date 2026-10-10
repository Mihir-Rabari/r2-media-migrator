import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
type SharpOutputInfo = Awaited<ReturnType<ReturnType<typeof sharp>['toFile']>>;
import type { GeneratedVariant, MediaProcessor, ProbeResult, ProcessLimits, VariantSpec } from '../core/interfaces';
import { MediaMigrateError } from '../domain/errors';
import { sniff } from './mime';

const FORMAT_MIME: Record<string, string> = { webp: 'image/webp', avif: 'image/avif', jpeg: 'image/jpeg', png: 'image/png' };

export interface SharpProcessorOptions {
  /** libvips worker threads per operation; keep low when running several jobs concurrently. */
  threads?: number;
  allowedInputFormats?: readonly string[];
  /** Fail on decoder warnings too (catches truncated JPEGs). Default true. */
  strictDecode?: boolean;
}

/** Which output encoders this runtime really has (so `avif` is never offered blindly). */
export function supportedOutputFormats(): string[] {
  const out: string[] = [];
  for (const f of ['webp', 'avif', 'jpeg', 'png'] as const) {
    const fmt = (sharp.format as any)[f === 'avif' ? 'heif' : f];
    if (fmt?.output?.buffer) out.push(f);
  }
  return out;
}

/** Deterministic image processor on sharp/libvips. Never upscales; applies EXIF orientation; strips metadata by default. */
export class SharpProcessor implements MediaProcessor {
  readonly version: string;
  private readonly allowed: Set<string>;
  private readonly failOn: 'warning' | 'error';
  constructor(opts: SharpProcessorOptions = {}) {
    sharp.cache(false); // bounded memory: no libvips operation cache
    sharp.concurrency(opts.threads ?? 1);
    this.failOn = opts.strictDecode === false ? 'error' : 'warning';
    this.allowed = new Set(opts.allowedInputFormats ?? ['jpeg', 'png', 'webp', 'gif', 'tiff']);
    this.version = `sharp-${sharp.versions.sharp ?? 'x'}+vips-${sharp.versions.vips}`;
  }

  async probe(filePath: string, limits: ProcessLimits): Promise<ProbeResult> {
    const st = fs.statSync(filePath);
    if (st.size > limits.maxFileBytes) throw new MediaMigrateError('permanent', 'FILE_TOO_LARGE', `file is ${st.size} bytes, limit ${limits.maxFileBytes}`);
    if (st.size === 0) throw new MediaMigrateError('permanent', 'EMPTY_FILE', 'file is empty');
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(64);
    try {
      fs.readSync(fd, head, 0, 64, 0);
    } finally {
      fs.closeSync(fd);
    }
    const sn = sniff(head);
    if (!sn || sn.mediaType !== 'image') {
      throw new MediaMigrateError('permanent', 'UNSUPPORTED_CONTENT', `content is not a supported raster image (${sn?.mime ?? 'unknown'})`, { sniffed: sn?.mime ?? null });
    }
    let meta: SharpMetadata;
    try {
      meta = await sharp(filePath, { limitInputPixels: limits.maxPixels, failOn: 'error', animated: true }).metadata();
    } catch (e) {
      throw new MediaMigrateError('permanent', 'CORRUPT_IMAGE', `cannot decode image: ${(e as Error).message}`, undefined, { cause: e });
    }
    const format = meta.format ?? 'unknown';
    const normalised = format === 'heif' ? (sn.mime === 'image/avif' ? 'avif' : 'heif') : format;
    if (!this.allowed.has(normalised)) {
      throw new MediaMigrateError('permanent', 'UNSUPPORTED_FORMAT', `input format "${normalised}" is not allowed`, { format: normalised });
    }
    const pages = meta.pages ?? 1;
    const width = meta.width ?? 0;
    const pageHeight = meta.pageHeight ?? meta.height ?? 0;
    if (!width || !pageHeight) throw new MediaMigrateError('permanent', 'CORRUPT_IMAGE', 'image has no dimensions');
    if (width * pageHeight * pages > limits.maxPixels) {
      throw new MediaMigrateError('permanent', 'TOO_MANY_PIXELS', `image has ${width * pageHeight * pages} pixels, limit ${limits.maxPixels}`);
    }
    return {
      mime: sn.mime, format: normalised, width, height: pageHeight, animated: pages > 1, pages, hasAlpha: !!meta.hasAlpha,
      orientation: meta.orientation, hasIcc: !!meta.icc, colorspace: meta.space,
    };
  }

  async generate(filePath: string, probe: ProbeResult, spec: VariantSpec, outPath: string, limits: ProcessLimits): Promise<GeneratedVariant> {
    const animated = spec.animated && probe.animated;
    let img = sharp(filePath, { limitInputPixels: limits.maxPixels, failOn: this.failOn, animated, sequentialRead: true });
    if (!animated) img = img.rotate(); // honour EXIF orientation, then drop the tag
    img = img.resize({ width: spec.width, withoutEnlargement: true, fit: 'inside' });
    img = img.toColourspace('srgb');
    if (spec.format === 'jpeg' && probe.hasAlpha) img = img.flatten({ background: '#ffffff' });
    if (spec.metadata === 'keep-all') img = img.keepMetadata();
    else if (spec.metadata === 'keep-icc') img = img.keepIccProfile();
    switch (spec.format) {
      case 'webp':
        img = img.webp({ quality: spec.quality, effort: spec.effort, lossless: spec.lossless ?? false });
        break;
      case 'avif':
        img = img.avif({ quality: spec.quality, effort: Math.min(spec.effort, 9) });
        break;
      case 'jpeg':
        img = img.jpeg({ quality: spec.quality, mozjpeg: true });
        break;
      case 'png':
        img = img.png({ effort: spec.effort });
        break;
    }
    let info: SharpOutputInfo;
    try {
      info = await img.toFile(outPath);
    } catch (e) {
      fs.rmSync(outPath, { force: true });
      throw new MediaMigrateError('permanent', 'PROCESSING_FAILED', `image processing failed: ${(e as Error).message}`, undefined, { cause: e });
    }
    const buf = fs.readFileSync(outPath);
    return {
      filePath: outPath, width: info.width, height: animated ? info.pageHeight ?? info.height : info.height, bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'), mime: FORMAT_MIME[spec.format], format: spec.format,
    };
  }

  async validate(filePath: string, expect: { maxWidth: number; format: string; mime: string }): Promise<ProbeResult> {
    let meta: SharpMetadata;
    try {
      meta = await sharp(filePath, { failOn: 'error', animated: true }).metadata();
      await sharp(filePath, { failOn: 'error', animated: true }).stats(); // forces a full decode: catches truncation
    } catch (e) {
      throw new MediaMigrateError('integrity', 'OUTPUT_INVALID', `generated file does not decode: ${(e as Error).message}`, undefined, { cause: e });
    }
    const fmt = meta.format === 'heif' ? 'avif' : meta.format;
    if (fmt !== expect.format) throw new MediaMigrateError('integrity', 'OUTPUT_FORMAT', `expected ${expect.format}, got ${fmt}`);
    if ((meta.width ?? 0) > expect.maxWidth || !meta.width) throw new MediaMigrateError('integrity', 'OUTPUT_WIDTH', `width ${meta.width} exceeds ${expect.maxWidth}`);
    return {
      mime: expect.mime, format: fmt ?? 'unknown', width: meta.width, height: meta.pageHeight ?? meta.height ?? 0, animated: (meta.pages ?? 1) > 1,
      pages: meta.pages ?? 1, hasAlpha: !!meta.hasAlpha, orientation: meta.orientation, hasIcc: !!meta.icc, colorspace: meta.space,
    };
  }
}
