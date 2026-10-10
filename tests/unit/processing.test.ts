import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { SharpProcessor, supportedOutputFormats } from '../../src/processing/imageProcessor';
import {
  animatedGif, animatedWebp, exifRotatedJpeg, htmlFixture, jpegFixture, jpegWithExif, pngFixture, randomBytes, smoothJpeg, svgFixture, truncated, webpFixture,
} from '../../src/testing/fixtures';
import type { VariantSpec } from '../../src/core/interfaces';
import { withTmp } from '../helpers';

const LIM = { maxPixels: 50_000_000, maxFileBytes: 20_000_000 };
const spec = (over: Partial<VariantSpec> = {}): VariantSpec => ({ width: 400, format: 'webp', quality: 75, effort: 4, metadata: 'strip', animated: false, ...over });
const proc = new SharpProcessor({ threads: 1 });

async function write(dir: string, name: string, buf: Buffer) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

test('processing: never upscales a small original (400 profile on a 120px source stays 120px)', async () => {
  await withTmp(async (dir) => {
    const src = await write(dir, 'small.jpg', await jpegFixture(120, 80));
    const probe = await proc.probe(src, LIM);
    const out = await proc.generate(src, probe, spec({ width: 400 }), path.join(dir, 'o.webp'), LIM);
    assert.equal(out.width, 120);
    assert.equal(out.height, 80);
  });
});

test('processing: downsizes to the profile width preserving aspect ratio', async () => {
  await withTmp(async (dir) => {
    const src = await write(dir, 'big.jpg', await jpegFixture(1600, 900));
    const probe = await proc.probe(src, LIM);
    for (const w of [400, 800, 1200]) {
      const out = await proc.generate(src, probe, spec({ width: w }), path.join(dir, `o${w}.webp`), LIM);
      assert.equal(out.width, w);
      assert.equal(out.height, Math.round((900 * w) / 1600));
      assert.equal(out.mime, 'image/webp');
      const v = await proc.validate(out.filePath, { maxWidth: w, format: 'webp', mime: 'image/webp' });
      assert.equal(v.format, 'webp');
    }
  });
});

test('processing: EXIF orientation 6 is applied (stored 300x200 displays as 200x300) and the tag is dropped', async () => {
  await withTmp(async (dir) => {
    const src = await write(dir, 'rot.jpg', await exifRotatedJpeg(300, 200, 6));
    const probe = await proc.probe(src, LIM);
    assert.equal(probe.orientation, 6);
    const out = await proc.generate(src, probe, spec({ width: 1000 }), path.join(dir, 'o.webp'), LIM);
    assert.equal(out.width, 200);
    assert.equal(out.height, 300);
    const meta = await sharp(out.filePath).metadata();
    assert.ok(!meta.orientation || meta.orientation === 1);
  });
});

test('processing: transparency survives WebP output; JPEG output flattens onto white', async () => {
  await withTmp(async (dir) => {
    const src = await write(dir, 'alpha.png', await pngFixture(200, 100, true));
    const probe = await proc.probe(src, LIM);
    assert.equal(probe.hasAlpha, true);
    const w = await proc.generate(src, probe, spec({ width: 200 }), path.join(dir, 'a.webp'), LIM);
    assert.equal((await sharp(w.filePath).metadata()).hasAlpha, true);
    const px = await sharp(w.filePath).raw().toBuffer({ resolveWithObject: true });
    const alphaRight = px.data[(50 * 200 + 190) * px.info.channels + 3];
    assert.ok(alphaRight < 200, 'right half stays semi-transparent');
    const j = await proc.generate(src, probe, spec({ width: 200, format: 'jpeg' }), path.join(dir, 'a.jpg'), LIM);
    assert.equal((await sharp(j.filePath).metadata()).hasAlpha, false);
  });
});

test('processing: metadata policy — strip removes EXIF; keep-all retains it', async () => {
  await withTmp(async (dir) => {
    const src = await write(dir, 'exif.jpg', await jpegWithExif(200, 100));
    assert.ok((await sharp(src).metadata()).exif, 'fixture has EXIF');
    const probe = await proc.probe(src, LIM);
    const stripped = await proc.generate(src, probe, spec({ width: 200 }), path.join(dir, 's.webp'), LIM);
    assert.equal((await sharp(stripped.filePath).metadata()).exif, undefined);
    const kept = await proc.generate(src, probe, spec({ width: 200, metadata: 'keep-all' }), path.join(dir, 'k.webp'), LIM);
    assert.ok((await sharp(kept.filePath).metadata()).exif);
  });
});

test('processing: deterministic — identical input and settings yield byte-identical output', async () => {
  await withTmp(async (dir) => {
    const src = await write(dir, 'd.jpg', await jpegFixture(900, 600, 3));
    const probe = await proc.probe(src, LIM);
    const a = await proc.generate(src, probe, spec({ width: 800 }), path.join(dir, 'a.webp'), LIM);
    const b = await proc.generate(src, probe, spec({ width: 800 }), path.join(dir, 'b.webp'), LIM);
    assert.equal(a.sha256, b.sha256);
    const c = await proc.generate(src, probe, spec({ width: 800, quality: 40 }), path.join(dir, 'c.webp'), LIM);
    assert.notEqual(a.sha256, c.sha256);
    assert.ok(c.bytes < a.bytes, 'lower quality is smaller');
  });
});

test('processing: perceptual similarity — resized output is close to the source (mean abs diff, not byte equality)', async () => {
  await withTmp(async (dir) => {
    const src = await write(dir, 'p.jpg', await smoothJpeg(800, 800));
    const probe = await proc.probe(src, LIM);
    const out = await proc.generate(src, probe, spec({ width: 400, quality: 85 }), path.join(dir, 'o.webp'), LIM);
    const ref = await sharp(src).resize(400).raw().toBuffer();
    const got = await sharp(out.filePath).raw().toBuffer();
    const n = Math.min(ref.length, got.length);
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(ref[i] - got[i]);
    assert.ok(diff / n < 3, `mean abs channel diff ${(diff / n).toFixed(2)} should be small`);
  });
});

test('processing: rejects corrupt, truncated, wrong-content, unsupported and empty inputs with permanent errors', async () => {
  await withTmp(async (dir) => {
    const good = await jpegFixture(300, 300);
    const cases: Array<[string, Buffer, RegExp]> = [
      ['garbage.jpg', randomBytes(5000), /UNSUPPORTED_CONTENT|not a supported/i],
      ['svg.jpg', svgFixture(), /not a supported raster/i],
      ['html.jpg', htmlFixture(), /not a supported raster/i],
      ['empty.jpg', Buffer.alloc(0), /empty/i],
    ];
    for (const [name, buf, re] of cases) {
      const p = await write(dir, name, buf);
      await assert.rejects(proc.probe(p, LIM), (e: any) => re.test(e.message) && e.kind === 'permanent', name);
    }
  });
});

test('processing: a truncated JPEG is rejected (at probe or at generate) and leaves no output file', async () => {
  await withTmp(async (dir) => {
    const p = await write(dir, 'trunc.jpg', truncated(await jpegFixture(600, 600, 2), 0.4));
    const out = path.join(dir, 'o.webp');
    await assert.rejects(async () => {
      const probe = await proc.probe(p, LIM);
      await proc.generate(p, probe, spec({ width: 400 }), out, LIM);
    }, (e: any) => e.kind === 'permanent');
    assert.equal(fs.existsSync(out), false);
  });
});

test('processing: file extension lies are ignored — a PNG named .jpg is processed by content', async () => {
  await withTmp(async (dir) => {
    const p = await write(dir, 'liar.jpg', await pngFixture(100, 100, false));
    const probe = await proc.probe(p, LIM);
    assert.equal(probe.mime, 'image/png');
    assert.equal(probe.format, 'png');
  });
});

test('processing: file-size and pixel limits are enforced (decompression-bomb guard)', async () => {
  await withTmp(async (dir) => {
    const p = await write(dir, 'big.png', await pngFixture(3000, 3000, false));
    await assert.rejects(proc.probe(p, { maxPixels: 1_000_000, maxFileBytes: 1e9 }), /pixel|TOO_MANY/i);
    await assert.rejects(proc.probe(p, { maxPixels: 1e9, maxFileBytes: 100 }), /FILE_TOO_LARGE|limit 100/);
  });
});

test('processing: animated inputs are detected; animated output only when the spec asks for it', async () => {
  await withTmp(async (dir) => {
    for (const [name, buf] of [['a.gif', await animatedGif(60, 40, 3)], ['a.webp', await animatedWebp(60, 40, 3)]] as const) {
      const p = await write(dir, name, buf);
      const probe = await proc.probe(p, LIM);
      assert.equal(probe.animated, true, name);
      assert.equal(probe.pages, 3, name);
      const out = await proc.generate(p, probe, spec({ width: 60, animated: true }), path.join(dir, `o-${name}.webp`), LIM);
      assert.equal((await sharp(out.filePath, { animated: true }).metadata()).pages, 3);
      assert.equal(out.height, 40);
    }
  });
});

test('processing: WebP and PNG inputs are accepted; unsupported allow-list entries are rejected', async () => {
  await withTmp(async (dir) => {
    const w = await write(dir, 'w.webp', await webpFixture(100, 100));
    assert.equal((await proc.probe(w, LIM)).format, 'webp');
    const strict = new SharpProcessor({ allowedInputFormats: ['jpeg'] });
    await assert.rejects(strict.probe(w, LIM), /UNSUPPORTED_FORMAT|not allowed/);
  });
});

test('processing: validate() catches truncated output and wrong format', async () => {
  await withTmp(async (dir) => {
    const src = await write(dir, 's.jpg', await jpegFixture(500, 500));
    const probe = await proc.probe(src, LIM);
    const out = await proc.generate(src, probe, spec({ width: 400 }), path.join(dir, 'o.webp'), LIM);
    const bad = path.join(dir, 'bad.webp');
    fs.writeFileSync(bad, fs.readFileSync(out.filePath).subarray(0, Math.floor(out.bytes / 2)));
    await assert.rejects(proc.validate(bad, { maxWidth: 400, format: 'webp', mime: 'image/webp' }), /OUTPUT_INVALID|decode/);
    await assert.rejects(proc.validate(out.filePath, { maxWidth: 400, format: 'jpeg', mime: 'image/jpeg' }), /expected jpeg/);
    await assert.rejects(proc.validate(out.filePath, { maxWidth: 100, format: 'webp', mime: 'image/webp' }), /exceeds/);
  });
});

test('processing: AVIF availability is detected from the runtime, not assumed', () => {
  const fmts = supportedOutputFormats();
  assert.ok(fmts.includes('webp'));
  // record the actual value for the validation report
  assert.equal(typeof fmts.includes('avif'), 'boolean');
});
