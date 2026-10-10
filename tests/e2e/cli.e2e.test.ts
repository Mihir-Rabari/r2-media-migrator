import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SqliteDocDatabase } from '../../src/database/sqliteDocDb';
import { jpegFixture, htmlFixture } from '../../src/testing/fixtures';
import { rmrf, tmpDir } from '../helpers';

const MAIN = path.resolve(__dirname, '..', '..', '..', 'dist', 'cli', 'main.js');

interface Res { code: number | null; stdout: string; stderr: string }

function cli(args: string[], env: Record<string, string> = {}, cwd?: string): Promise<Res> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env }, cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function done(e: Env): Promise<void> {
  await e.db.close();
  rmrf(e.dir);
}
const json = (r: Res) => r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lastResult = (r: Res) => json(r).filter((x) => x.type === 'result').pop();

interface Env { dir: string; config: string; cfgObj: any; store: string; dbFile: string; db: SqliteDocDatabase }

async function makeEnv(over: (c: any) => void = () => undefined, n = 4): Promise<Env> {
  const dir = tmpDir('mme2e-');
  const store = path.join(dir, 'store');
  const dbFile = path.join(dir, 'db.sqlite');
  const objDir = path.join(store, 'objects', 'products');
  fs.mkdirSync(objDir, { recursive: true });
  const db = new SqliteDocDatabase(dbFile);
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(objDir, `p${i}.jpg`), await jpegFixture(500 + i, 300, i));
    db.insert('products', `p${i}`, { name: `P${i}`, photo: `https://cdn.legacy.test/products/p${i}.jpg`, photos: [`https://cdn.legacy.test/products/p${i}.jpg`, `https://other.example/x${i}.jpg`] });
  }
  const cfgObj: any = {
    version: 1, environment: 'staging',
    source: { storage: { provider: 'fs', bucket: 'local', root: './store' }, legacyHosts: ['cdn.legacy.test'] },
    database: { provider: 'sqlite-docs', file: './db.sqlite', collections: [{ name: 'products', fields: ['photo', 'photos[]'] }] },
    destination: { storage: { provider: 'fs', bucket: 'local', root: './store' }, publicBaseUrl: 'https://cdn.new.test', referenceVariantWidth: 400 },
    processing: { widths: [100, 200, 400], quality: 70, effort: 1, concurrency: 2 },
    migration: { journalDir: './journal', retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 }, lockStaleSec: 60 },
    observability: { logLevel: 'info', reportDir: './journal/reports' },
  };
  over(cfgObj);
  const config = path.join(dir, 'media.config.json');
  fs.writeFileSync(config, JSON.stringify(cfgObj, null, 2));
  return { dir, config, cfgObj, store, dbFile, db };
}
const dirHash = (root: string): string => {
  const h = createHash('sha256');
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(p).update(fs.readFileSync(p));
    }
  };
  walk(root);
  return h.digest('hex');
};
const docs = (e: Env) => JSON.stringify(e.db.allDocs('products'));

test('e2e: --help and --version work; unknown command / bad numbers fail with exit 2 before touching anything', async () => {
  const h = await cli(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /EXIT CODES/);
  const v = await cli(['--version']);
  assert.equal(v.code, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const dir = tmpDir();
  try {
    for (const args of [['frobnicate'], ['migrate', '--concurrency', '0', '--config', 'x'], ['migrate', '--limit', 'ten'], ['migrate', '--unknown-flag'], ['migrate', '--resume'], ['status', '--since', '2026-13-45'], ['migrate', '--quiet', '--verbose']]) {
      const r = await cli(args, {}, dir);
      assert.equal(r.code, 2, args.join(' ') + ' -> ' + r.stderr);
      assert.match(r.stderr, /error \[/);
    }
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing created in cwd');
  } finally {
    rmrf(dir);
  }
});

test('e2e: invalid configuration fails validation (exit 2) with actionable messages and creates no journal', async () => {
  const e = await makeEnv((c) => { c.processing.widths = [800, 400]; c.destination.referenceVariantWidth = 999; c.database.collections[0].fields = ['photo', '$where']; c.nonsense = true; });
  try {
    const r = await cli(['config', 'validate', '--config', e.config]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /CONFIG_INVALID/);
    const r2 = await cli(['migrate', '--config', e.config, '--yes']);
    assert.equal(r2.code, 2);
    assert.equal(fs.existsSync(path.join(e.dir, 'journal')), false, 'validation failure happens before any state is created');
  } finally {
    await done(e);
  }
});

test('e2e: semantic validation — namespace overlap, missing secrets, production hardening', async () => {
  const e = await makeEnv((c) => {
    c.source.storage = { provider: 's3', bucket: 'b', endpoint: 'https://acct.r2.cloudflarestorage.com', accessKeyIdEnv: 'MM_TEST_KEY', secretAccessKeyEnv: 'MM_TEST_SECRET' };
    c.destination.storage = { ...c.source.storage };
    c.source.includePrefixes = ['media/'];
  });
  try {
    const r = await cli(['config', 'validate', '--config', e.config, '--skip-secrets']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /overlaps the destination namespace/);
    const cfg = JSON.parse(fs.readFileSync(e.config, 'utf8'));
    cfg.source.includePrefixes = ['products/'];
    fs.writeFileSync(e.config, JSON.stringify(cfg));
    const r2 = await cli(['config', 'validate', '--config', e.config]);
    assert.equal(r2.code, 2);
    assert.match(r2.stderr, /MM_TEST_KEY is not set/);
  } finally {
    await done(e);
  }
});

test('e2e: secrets never appear in output, errors or reports (I12)', async () => {
  const SECRET = 'SuperSecretValue-9f8e7d6c5b4a';
  const KEY = 'AKIAABCDEFGHIJKLMNOP';
  const e = await makeEnv((c) => {
    c.source.storage = { provider: 's3', bucket: 'b', endpoint: 'https://acct.r2.cloudflarestorage.com', accessKeyIdEnv: 'MM_TEST_KEY', secretAccessKeyEnv: 'MM_TEST_SECRET' };
    c.destination.storage = { ...c.source.storage };
    c.database = { provider: 'mongodb', uriEnv: 'MM_TEST_URI', database: 'x', collections: [{ name: 'products', fields: ['photo'] }] };
    c.destination.namespace = 'media';
  });
  const env = { MM_TEST_KEY: KEY, MM_TEST_SECRET: SECRET, MM_TEST_URI: `mongodb://admin:${SECRET}@db.example.invalid:27017/x` };
  try {
    for (const args of [['config', 'validate', '--config', e.config, '--json', '--verbose'], ['config', 'validate', '--config', e.config, '--verbose'], ['config', 'validate', '--config', e.config, '--set', 'processing.widths=oops', '--json']]) {
      const r = await cli(args, env);
      const all = r.stdout + r.stderr;
      assert.ok(!all.includes(SECRET), `leaked secret in: ${args.join(' ')}`);
      assert.ok(!all.includes(KEY), 'leaked access key id');
    }
    const ok = await cli(['config', 'validate', '--config', e.config, '--json'], env);
    assert.equal(ok.code, 0, ok.stderr);
    const cfgOut = JSON.stringify(lastResult(ok));
    assert.match(cfgOut, /MM_TEST_SECRET/, 'env var NAMES are shown');
    assert.ok(!cfgOut.includes(SECRET));
  } finally {
    await done(e);
  }
});

test('e2e: dry-run performs zero mutations (storage tree and database are byte-identical afterwards) and emits review artifacts', async () => {
  const e = await makeEnv();
  try {
    const storeBefore = dirHash(e.store);
    const docsBefore = docs(e);
    const r = await cli(['dry-run', '--config', e.config, '--limit', '3']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /DRY_RUN_COMPLETE/);
    assert.equal(dirHash(e.store), storeBefore, 'storage untouched');
    assert.equal(docs(e), docsBefore, 'database untouched');
    const runs = fs.readdirSync(path.join(e.dir, 'journal', 'reports'));
    assert.equal(runs.length, 1);
    const rd = path.join(e.dir, 'journal', 'reports', runs[0]);
    assert.ok(fs.existsSync(path.join(rd, 'review.html')));
    assert.ok(fs.existsSync(path.join(rd, 'contact-sheet.png')));
    // `migrate --dry-run` is the same guarantee
    const r2 = await cli(['migrate', '--dry-run', '--config', e.config, '--limit', '2']);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(dirHash(e.store), storeBefore);
    assert.equal(docs(e), docsBefore);
  } finally {
    await done(e);
  }
});

test('e2e: mutating commands are blocked without --yes (exit 8) and in production without opt-in; readiness gate blocks production migrate', async () => {
  const e = await makeEnv();
  try {
    const before = docs(e);
    const r = await cli(['migrate', '--config', e.config]);
    assert.equal(r.code, 8, r.stderr);
    assert.match(r.stderr, /--yes/);
    const rp = await cli(['migrate', '--config', e.config, '--yes', '--env', 'production']);
    assert.equal(rp.code, 8);
    assert.match(rp.stderr, /allowProductionMutations/);
    const rr = await cli(['migrate', '--config', e.config, '--yes', '--env', 'production', '--set', 'safety.allowProductionMutations=true']);
    assert.equal(rr.code, 8);
    assert.match(rr.stderr, /readiness checklist/);
    assert.equal(docs(e), before);
    const rd = await cli(['readiness', '--config', e.config, '--env', 'production', '--set', 'safety.allowProductionMutations=true', '--json']);
    assert.equal(rd.code, 8);
    assert.ok(lastResult(rd).gates.some((g: any) => g.status === 'BLOCKED'));
  } finally {
    await done(e);
  }
});

test('e2e: full migrate (--yes, --json) completes, is idempotent, verifies, and reports honestly', async () => {
  const e = await makeEnv();
  try {
    const r = await cli(['migrate', '--config', e.config, '--yes', '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const evs = json(r);
    assert.ok(evs.some((x) => x.type === 'progress'), 'NDJSON progress events');
    const res = lastResult(r);
    assert.equal(res.status, 'COMPLETE');
    const doc = e.db.getDoc('products', 'p0');
    assert.match(doc.photo, /^https:\/\/cdn\.new\.test\/media\/v1\/a[a-z2-7]{24}\/400\.webp$/);
    assert.equal(doc.photos[1], 'https://other.example/x0.jpg', 'third-party URL untouched');

    const snapDb = docs(e);
    const snapStore = dirHash(e.store);
    const again = await cli(['migrate', '--config', e.config, '--yes', '--json']);
    assert.equal(again.code, 0);
    assert.equal(docs(e), snapDb);
    assert.equal(dirHash(e.store), snapStore);

    const v = await cli(['verify', '--config', e.config, '--json']);
    assert.equal(v.code, 0, v.stdout);
    assert.equal(lastResult(v).ok, true);

    const st = await cli(['status', '--config', e.config, '--json']);
    assert.equal(st.code, 0);
    assert.equal(lastResult(st).progress.completed, 4);

    const lg = await cli(['logs', '--config', e.config, '--tail', '5', '--json']);
    assert.equal(lg.code, 0);
    assert.ok(lastResult(lg).events.length > 0);

    const rep = await cli(['report', '--config', e.config, '--run-id', res.runId]);
    assert.equal(rep.code, 0);
    const rdir = path.join(e.dir, 'journal', 'reports', res.runId);
    for (const f of ['report.json', 'report.md', 'assets.jsonl', 'mapping.jsonl']) assert.ok(fs.existsSync(path.join(rdir, f)), f);
    const rj = JSON.parse(fs.readFileSync(path.join(rdir, 'report.json'), 'utf8'));
    assert.equal(rj.progress.completed, 4);
    assert.equal(rj.journalIntegrity.ok, true);
  } finally {
    await done(e);
  }
});

test('e2e: incomplete work exits 4 (never 0): a missing source and a non-image are surfaced; retry --yes completes after the fix', async () => {
  const e = await makeEnv();
  try {
    const objDir = path.join(e.store, 'objects', 'products');
    fs.writeFileSync(path.join(objDir, 'bad.jpg'), await htmlFixture());
    e.db.insert('products', 'bad', { photo: 'https://cdn.legacy.test/products/bad.jpg', photos: ['https://cdn.legacy.test/products/gone.jpg'] });
    const r = await cli(['migrate', '--config', e.config, '--yes', '--json']);
    assert.equal(r.code, 4, r.stdout);
    assert.equal(lastResult(r).status, 'INCOMPLETE');
    fs.writeFileSync(path.join(objDir, 'gone.jpg'), await jpegFixture(320, 200, 5));
    const rt = await cli(['retry', '--config', e.config, '--yes', '--json']);
    assert.equal(rt.code, 0, rt.stdout + rt.stderr);
    assert.equal(e.db.getDoc('products', 'bad').photo, 'https://cdn.legacy.test/products/bad.jpg', 'non-image left alone');
    assert.match(e.db.getDoc('products', 'bad').photos[0], /cdn\.new\.test/);
    const rn = await cli(['retry', '--config', e.config, '--json']);
    assert.equal(rn.code, 8, 'retry also needs --yes');
  } finally {
    await done(e);
  }
});

test('e2e: rollback safeguards — needs --yes, dry-run is read-only, restores originals, refuses to clobber later edits (exit 6)', async () => {
  const e = await makeEnv();
  try {
    const original = docs(e);
    assert.equal((await cli(['migrate', '--config', e.config, '--yes'])).code, 0);
    const migrated = docs(e);
    assert.notEqual(migrated, original);
    const no = await cli(['rollback', '--config', e.config]);
    assert.equal(no.code, 8);
    assert.equal(docs(e), migrated);
    const dry = await cli(['rollback', '--config', e.config, '--dry-run', '--json']);
    assert.equal(dry.code, 0);
    assert.equal(docs(e), migrated);
    e.db.edit('products', 'p1', (d) => { d.photo = 'https://cdn.legacy.test/products/user-set.jpg'; });
    const rb = await cli(['rollback', '--config', e.config, '--yes', '--json']);
    assert.equal(rb.code, 6, rb.stdout);
    assert.equal(e.db.getDoc('products', 'p1').photo, 'https://cdn.legacy.test/products/user-set.jpg');
    assert.match(e.db.getDoc('products', 'p0').photo, /^https:\/\/cdn\.legacy\.test\/products\/p0\.jpg$/);
  } finally {
    await done(e);
  }
});

test('e2e: process-kill crash (hard exit mid-run) leaves a STALE run that status reports honestly; resume finishes and verifies', async () => {
  const e = await makeEnv();
  try {
    const crash = await cli(['migrate', '--config', e.config, '--yes', '--run-id', 'run-crash-1', '--concurrency', '1'], { MEDIA_MIGRATE_ENABLE_FAILPOINTS: '1', MEDIA_MIGRATE_FAILPOINTS: 'upload:after=exit@3' });
    assert.equal(crash.code, 86, 'simulated hard kill');
    const st = await cli(['status', '--config', e.config, '--run-id', 'run-crash-1', '--json']);
    const s = lastResult(st);
    assert.equal(s.stale, true, 'a dead worker must not be reported as running');
    assert.match(s.status, /INTERRUPTED \(stale\)/);
    const v = await cli(['verify', '--config', e.config, '--json']);
    assert.equal(v.code, 5, 'incomplete migration is not verified');
    const res = await cli(['resume', '--config', e.config, '--run-id', 'run-crash-1', '--yes', '--json']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal((await cli(['verify', '--config', e.config])).code, 0);
    const lg = await cli(['logs', '--config', e.config, '--run-id', 'run-crash-1', '--tail', '500', '--json']);
    assert.ok(lastResult(lg).events.some((x: any) => x.type === 'lock.takeover'));
  } finally {
    await done(e);
  }
});

test('e2e: background run survives the launching process; status/logs/report work by run id; completion is never implied by launch', async () => {
  const e = await makeEnv((c) => { c.migration.lockStaleSec = 120; }, 6);
  try {
    const launch = await cli(['migrate', '--config', e.config, '--yes', '--background', '--run-id', 'bg-run-1', '--json'], { MEDIA_MIGRATE_ENABLE_FAILPOINTS: '1', MEDIA_MIGRATE_FAILPOINTS: 'download:before=sleep:1500' });
    assert.equal(launch.code, 0, launch.stderr + launch.stdout);
    const started = lastResult(launch);
    assert.equal(started.started, true);
    assert.match(started.note, /NOT completion/);
    // immediately after launch the migration is NOT complete
    const early = lastResult(await cli(['status', '--config', e.config, '--run-id', 'bg-run-1', '--json']));
    assert.notEqual(early.status, 'COMPLETE');
    // poll durable state until the worker finishes (waiting for state, not asserting on timing)
    let final: any;
    for (let i = 0; i < 300; i++) {
      final = lastResult(await cli(['status', '--config', e.config, '--run-id', 'bg-run-1', '--json']));
      if (final.status === 'COMPLETE') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(final.status, 'COMPLETE');
    assert.equal(final.progress.completed, 6);
    assert.ok(fs.existsSync(started.logFile), 'worker log file exists');
    const rep = await cli(['report', '--config', e.config, '--run-id', 'bg-run-1', '--json']);
    assert.equal(rep.code, 0);
  } finally {
    await done(e);
  }
});

test('e2e: lock contention (exit 7) while a worker holds the journal; `stop` interrupts gracefully (exit 3 state), resume completes', async () => {
  const e = await makeEnv((c) => { c.migration.lockStaleSec = 120; }, 5);
  try {
    const launch = await cli(['migrate', '--config', e.config, '--yes', '--background', '--run-id', 'bg-lock-1', '--concurrency', '1', '--json'], { MEDIA_MIGRATE_ENABLE_FAILPOINTS: '1', MEDIA_MIGRATE_FAILPOINTS: 'download:before=sleep:2500' });
    assert.equal(launch.code, 0, launch.stderr);
    const second = await cli(['migrate', '--config', e.config, '--yes', '--run-id', 'second-run', '--json']);
    assert.equal(second.code, 7, second.stdout + second.stderr);
    assert.match(second.stdout + second.stderr, /locked by run bg-lock-1/);
    const stop = await cli(['stop', '--config', e.config, '--run-id', 'bg-lock-1', '--json']);
    assert.equal(stop.code, 0);
    let st: any;
    for (let i = 0; i < 200; i++) {
      st = lastResult(await cli(['status', '--config', e.config, '--run-id', 'bg-lock-1', '--json']));
      if (st.status === 'INTERRUPTED') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(st.status, 'INTERRUPTED');
    assert.ok(st.progress.completed < 5);
    const res = await cli(['resume', '--config', e.config, '--run-id', 'bg-lock-1', '--yes', '--json']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(lastResult(await cli(['status', '--config', e.config, '--run-id', 'bg-lock-1', '--json'])).progress.completed, 5);
  } finally {
    await done(e);
  }
});

test('e2e: foreground run interrupted via `stop` exits 3 (INTERRUPTED) and says how to resume', async () => {
  const e = await makeEnv((c) => { c.migration.lockStaleSec = 120; }, 4);
  try {
    const fg = cli(['migrate', '--config', e.config, '--yes', '--run-id', 'fg-run-1', '--concurrency', '1', '--json'], { MEDIA_MIGRATE_ENABLE_FAILPOINTS: '1', MEDIA_MIGRATE_FAILPOINTS: 'download:before=sleep:2500@1' });
    let running = false;
    for (let i = 0; i < 100 && !running; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const s = await cli(['status', '--config', e.config, '--run-id', 'fg-run-1', '--json']);
      running = s.code === 0 && lastResult(s)?.status === 'RUNNING';
    }
    assert.ok(running, 'run became visible as RUNNING in the journal');
    await cli(['stop', '--config', e.config, '--run-id', 'fg-run-1']);
    const r = await fg;
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(lastResult(r).message, /resume with --resume --run-id fg-run-1/);
  } finally {
    await done(e);
  }
});

test('e2e: SIGINT / SIGTERM handling (POSIX only — Windows cannot deliver catchable signals to child processes)', { skip: process.platform === 'win32' ? 'Windows: process.kill(SIGINT/SIGTERM) terminates the child without running handlers; covered by the cross-platform `stop` tests above' : false }, async () => {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    const e = await makeEnv((c) => { c.migration.lockStaleSec = 120; }, 4);
    try {
      const child = spawn(process.execPath, [MAIN, 'migrate', '--config', e.config, '--yes', '--run-id', `sig-${sig}`, '--concurrency', '1', '--json'], {
        env: { ...process.env, MEDIA_MIGRATE_ENABLE_FAILPOINTS: '1', MEDIA_MIGRATE_FAILPOINTS: 'download:before=sleep:2000@1' },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      await new Promise((r) => setTimeout(r, 1200));
      child.kill(sig);
      const code: number = await new Promise((r) => child.on('close', (c) => r(c ?? -1)));
      assert.equal(code, 3, `${sig}: ${out}`);
    } finally {
      await done(e);
    }
  }
});

test('e2e: init writes a starter config that parses; refuses to overwrite without --yes', async () => {
  const dir = tmpDir();
  try {
    const out = path.join(dir, 'c.json');
    assert.equal((await cli(['init', '--out', out])).code, 0);
    assert.equal((await cli(['init', '--out', out])).code, 8);
    assert.equal((await cli(['config', 'validate', '--config', out, '--skip-secrets'])).code, 0);
  } finally {
    rmrf(dir);
  }
});
