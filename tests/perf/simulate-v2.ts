/**
 * Full-workflow simulation modelled on the V2 Enterprise data profile described in its media investigation
 * (≈262 products, photo + gallery + hover image, 12% of product URLs on a pub-*.r2.dev host, shared images, hero MP4s,
 * third-party seed URLs, a few broken/missing files). Runs the REAL CLI code path (runCli) against filesystem
 * storage + a SQLite document database, and records measurements.
 *
 * This is a SIMULATION on synthetic images: it validates behaviour and gives order-of-magnitude performance on this
 * machine. It says nothing about real R2 latency, real MongoDB behaviour or real photo compressibility.
 *
 *   node dist-test/tests/perf/simulate-v2.js [--products 262] [--out reports/media-migration/data/simulation-results.json]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { runCli } from '../../src/cli/main';
import { SqliteDocDatabase } from '../../src/database/sqliteDocDb';
import { SqliteJournal } from '../../src/journal/sqliteJournal';
import { prng } from '../helpers';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const PRODUCTS = Number(arg('products', '262'));
const OUT = path.resolve(arg('out', 'reports/media-migration/data/simulation-results.json'));

class Capture {
  chunks: string[] = [];
  write(c: string | Uint8Array): boolean { this.chunks.push(String(c)); return true; }
  get text() { return this.chunks.join(''); }
}

/** Photographic-ish image: smooth gradients + multi-scale noise, so JPEG sizes are in a realistic range. */
async function photo(w: number, h: number, seed: number, quality: number): Promise<Buffer> {
  const rnd = prng(seed);
  const gw = Math.ceil(w / 8), gh = Math.ceil(h / 8);
  const noise = Buffer.alloc(gw * gh * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(rnd() * 255);
  const base = await sharp(noise, { raw: { width: gw, height: gh, channels: 3 } }).resize(w, h, { kernel: 'cubic' }).blur(2).raw().toBuffer();
  for (let i = 0; i < base.length; i++) base[i] = Math.min(255, base[i] + Math.floor(rnd() * 14));
  return sharp(base, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality }).toBuffer();
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sim-'));
  const store = path.join(dir, 'store');
  const objDir = path.join(store, 'objects');
  const dbFile = path.join(dir, 'db.sqlite');
  const rnd = prng(2026);
  const results: Record<string, unknown> = { generatedAt: new Date().toISOString(), host: { platform: process.platform, node: process.version, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemGB: +(os.totalmem() / 1e9).toFixed(1) }, products: PRODUCTS, steps: {} };

  // ───── dataset
  const t0 = Date.now();
  const db = new SqliteDocDatabase(dbFile);
  const imgCount = Math.round(PRODUCTS * 3.6);
  let srcBytes = 0;
  const widths = [1200, 1600, 2000, 2400, 3024];
  const put = async (key: string, buf: Buffer) => { const p = path.join(objDir, key); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); srcBytes += buf.length; };
  const imageKeys: string[] = [];
  for (let i = 0; i < imgCount; i++) {
    const w = widths[Math.floor(rnd() * widths.length)];
    const h = Math.round(w * 1.33);
    const key = `products/${1786273628083 + i * 977}-${100000 + i}-${i}.jpg`;
    imageKeys.push(key);
    await put(key, await photo(w, h, i + 1, 80 + Math.floor(rnd() * 12)));
  }
  // a few special files
  const dup = fs.readFileSync(path.join(objDir, imageKeys[0]));
  await put('products/dup-of-first.jpg', dup);
  await put('products/broken.jpg', dup.subarray(0, Math.floor(dup.length / 3)));
  await put('products/soft404.jpg', Buffer.from('<!DOCTYPE html><html>not an image</html>'));
  fs.mkdirSync(path.join(objDir, 'videos'), { recursive: true });
  fs.writeFileSync(path.join(objDir, 'videos/hero1.mp4'), Buffer.concat([Buffer.from('....ftypisom'), Buffer.alloc(200_000, 3)]));
  const legacy = (k: string, r2dev = false) => (r2dev ? `https://pub-8848replaceme.r2.dev/${k}` : `https://cdn.v2enterprise.in/${k}`);
  for (let p = 0; p < PRODUCTS; p++) {
    const own = imageKeys[(p * 3) % imageKeys.length];
    const g1 = imageKeys[(p * 3 + 1) % imageKeys.length];
    const g2 = imageKeys[(p * 3 + 2) % imageKeys.length];
    const r2dev = rnd() < 0.12;
    db.insert('products', `prod${p}`, {
      name: `Product ${p}`, price: 999 + p, status: 'ACTIVE', updatedAt: '2026-05-01T00:00:00.000Z', mainCategory: 'Shirts', videoUrls: ['https://youtu.be/abc123'],
      photo: legacy(own, r2dev), photos: [legacy(own, r2dev), legacy(g1, r2dev), legacy(g2, r2dev)], hoverImage: legacy(g1, r2dev), tags: ['a'],
    });
  }
  db.insert('products', 'edge', { name: 'edge', photo: legacy('products/broken.jpg'), photos: [legacy('products/soft404.jpg'), legacy('products/missing.jpg'), legacy('products/dup-of-first.jpg')], hoverImage: 'https://images.pexels.com/photos/1/x.jpeg' });
  for (let c = 0; c < 8; c++) db.insert('categories', `cat${c}`, { name: `Cat ${c}`, slug: `cat-${c}`, image: legacy(imageKeys[c]), updatedAt: '2026-05-01T00:00:00.000Z' });
  db.insert('categories', 'ik', { name: 'ImageKit', slug: 'ik', image: 'https://ik.imagekit.io/ma42aehxw/old.jpg' });
  for (let s = 0; s < 5; s++) db.insert('sliders', `sl${s}`, { type: 'PROMOTIONAL', image: legacy(imageKeys[10 + s]), laptopUrl: legacy(imageKeys[10 + s]), mobileUrl: legacy(imageKeys[20 + s]) });
  db.insert('heroslides', 'h1', { type: 'video', url: legacy('videos/hero1.mp4'), poster: legacy(imageKeys[30]) });
  db.insert('heroslides', 'h2', { type: 'image', url: legacy(imageKeys[31]), laptopUrl: legacy(imageKeys[31]), mobileUrl: legacy(imageKeys[32]) });
  db.insert('sitesettings', 'site', {
    logoImage: 'https://v2enterprise.in/v2_logo.webp', aboutContent: { heroImage: 'https://images.pexels.com/photos/1884581/pexels-photo-1884581.jpeg?auto=compress', visionImage: legacy(imageKeys[40]), footerImage: 'https://images.unsplash.com/x' },
    homeSections: { categories: [{ title: 'a', image: legacy(imageKeys[41]) }, { title: 'b', image: legacy(imageKeys[42]) }], promotionalSliders: [{ image: legacy('videos/hero1.mp4') }], promotionalBanner: { image: legacy(imageKeys[43]) }, newStandard: { image: legacy(imageKeys[44]) } },
  });
  await db.close();
  results.dataset = { distinctImages: imgCount, totalSourceBytes: srcBytes, avgSourceKB: Math.round(srcBytes / imgCount / 1024), generationMs: Date.now() - t0 };

  // ───── config derived from the V2 example
  const cfg = JSON.parse(fs.readFileSync(path.resolve('examples/v2-enterprise.config.json'), 'utf8'));
  cfg.source.storage = { provider: 'fs', bucket: 'v2-enterprise', root: './store' };
  cfg.destination.storage = { provider: 'fs', bucket: 'v2-enterprise', root: './store' };
  cfg.source.legacyHosts = ['cdn.v2enterprise.in', 'pub-8848replaceme.r2.dev'];
  cfg.database = { provider: 'sqlite-docs', file: './db.sqlite', collections: cfg.database.collections, writePolicy: cfg.database.writePolicy };
  cfg.migration.journalDir = './journal';
  cfg.observability.reportDir = './journal/reports';
  cfg.compatibility.mappingFile = './journal/mapping.jsonl';
  const config = path.join(dir, 'v2.sim.config.json');
  fs.writeFileSync(config, JSON.stringify(cfg, null, 2));

  // ───── step runner with RSS sampling
  async function step(name: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    const out = new Capture(), err = new Capture();
    let peak = process.memoryUsage().rss;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
    const start = performance.now();
    const code = await runCli(args, { out: out as never, err: err as never, env: { ...process.env, ...env }, stdinIsTTY: false });
    const ms = performance.now() - start;
    clearInterval(timer);
    const lines = out.text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const result = lines.filter((l: any) => l.type === 'result' || l.type === 'error').pop();
    (results.steps as Record<string, unknown>)[name] = { exitCode: code, wallMs: Math.round(ms), peakRssMB: Math.round(peak / 1024 / 1024), result: result && { ...result, summary: undefined, report: undefined, config: undefined, events: undefined }, summary: result?.summary };
    console.error(`${name}: exit ${code} in ${(ms / 1000).toFixed(1)}s`);
    return { code, result, out: out.text };
  }

  const snapStore = () => { let n = 0, b = 0; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { n++; b += fs.statSync(p).size; } } }; walk(objDir); return { objects: n, bytes: b }; };
  const dbSnap = () => { const d = new SqliteDocDatabase(dbFile); const s = d.snapshot(); void d.close(); return s; };

  const c = ['--config', config, '--json'];
  await step('config-validate', ['config', 'validate', ...c]);
  await step('inventory', ['inventory', ...c, '--concurrency', '4']);
  await step('plan', ['plan', ...c]);
  const beforeDb = dbSnap(); const beforeStore = snapStore();
  await step('dry-run-sample-20', ['dry-run', ...c, '--limit', '20']);
  const afterDryDb = dbSnap(); const afterDryStore = snapStore();
  (results as any).dryRunNoMutation = { databaseUnchanged: beforeDb === afterDryDb, storageUnchanged: JSON.stringify(beforeStore) === JSON.stringify(afterDryStore) };
  await step('process-sample-20', ['process', ...c, '--limit', '20', '--yes']);
  await step('migrate-full', ['migrate', ...c, '--yes', '--concurrency', '4']);
  const afterMigrate = snapStore();
  await step('verify', ['verify', ...c]);
  const midDb = dbSnap();
  await step('migrate-rerun-idempotent', ['migrate', ...c, '--yes']);
  (results as any).rerunNoChange = { databaseUnchanged: midDb === dbSnap(), storageUnchanged: JSON.stringify(afterMigrate) === JSON.stringify(snapStore()) };
  await step('export-mapping', ['export-mapping', ...c]);
  await step('reconcile', ['reconcile', ...c]);
  await step('report', ['report', ...c]);
  await step('rollback', ['rollback', ...c, '--yes']);
  (results as any).rollbackExact = { databaseEqualsOriginal: dbSnap() === beforeDb };
  await step('migrate-after-rollback', ['migrate', ...c, '--yes']);
  await step('verify-after-remigrate', ['verify', ...c]);

  // ───── derived metrics from the journal
  const j = new SqliteJournal(path.join(dir, 'journal', 'journal.sqlite'));
  const runs = j.listRuns(50);
  const mig = runs.filter((r) => r.kind === 'migrate').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const main1 = mig.find((r) => j.timings(r.runId)['stage:process']);
  if (main1) {
    const t = j.timings(main1.runId);
    const ctr = j.counters(main1.runId);
    const per: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t)) per[k] = { count: v.count, avgMs: +(v.totalMs / v.count).toFixed(1), maxMs: +v.maxMs.toFixed(1), totalSec: +(v.totalMs / 1000).toFixed(2) };
    results.migrateRun = { runId: main1.runId, timings: per, counters: ctr };
  }
  const assets = j.listAssets();
  const byState: Record<string, number> = {};
  for (const a of assets) byState[a.state] = (byState[a.state] ?? 0) + 1;
  results.finalAssetStates = byState;
  let vb = 0; const perWidth: Record<number, { n: number; bytes: number }> = {};
  let srcOfComplete = 0;
  for (const a of assets.filter((x) => x.state === 'COMPLETE' || x.state === 'ROLLED_BACK')) {
    srcOfComplete += a.sourceBytes ?? 0;
    for (const v of j.listVariants(a.assetId)) { vb += v.bytes; (perWidth[v.width] ??= { n: 0, bytes: 0 }); perWidth[v.width].n++; perWidth[v.width].bytes += v.bytes; }
  }
  results.sizes = { sourceBytesOfMigratedAssets: srcOfComplete, allVariantBytes: vb, perWidthAvgKB: Object.fromEntries(Object.entries(perWidth).map(([w, v]) => [w, +(v.bytes / v.n / 1024).toFixed(1)])), perWidthPctOfSourceAvg: Object.fromEntries(Object.entries(perWidth).map(([w, v]) => [w, +((v.bytes / v.n) / (srcOfComplete / Math.max(1, Object.values(perWidth)[0]?.n ?? 1)) * 100).toFixed(1)])), totalStoreAfter: afterMigrate };
  results.duplicateGroups = j.duplicateGroups().length;
  results.journalIntegrity = j.integrityCheck();
  j.close();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.error(`wrote ${OUT}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

main().catch((e) => { console.error(e); process.exit(1); });
