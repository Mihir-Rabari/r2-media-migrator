import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { makeWorld, seedCatalogue } from '../../src/testing/harness';
import { checkInvariants } from '../../src/testing/invariants';
import { Barrier, ConcurrencyProbe, interceptStorage } from '../../src/testing/faults';
import { jpegFixture, randomBytes } from '../../src/testing/fixtures';
import { ByteBudget, RateLimiter, Semaphore } from '../../src/core/limits';
import { FsStorage } from '../../src/storage/fsStorage';
import { SimulatedCrash } from '../../src/domain/errors';
import { FAILPOINT_NAMES } from '../../src/core/failpoints';
import { prng } from '../helpers';

async function seedMany(w: ReturnType<typeof makeWorld>, n: number) {
  for (let i = 0; i < n; i++) {
    w.storage.seed(`bulk/i${i}.jpg`, await jpegFixture(300 + i, 200, i), 'image/jpeg');
    w.db.insert('products', `b${i}`, { photo: w.url(`bulk/i${i}.jpg`), updatedAt: '2026-01-01T00:00:00Z' });
  }
}

test('concurrency: never more simultaneous downloads than configured, and work really overlaps (barrier, no timing)', async () => {
  // bound
  const w = makeWorld({ processing: { concurrency: 3 } });
  try {
    await seedMany(w, 9);
    const probe = new ConcurrencyProbe();
    const src = interceptStorage(w.storage, { get: () => undefined });
    const wrapped = { ...src, get: (k: string, o?: any) => probe.around(async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); return src.get(k, o); }) };
    const res = await w.engine({ source: wrapped as never }).run('migrate');
    assert.equal(res.status, 'COMPLETE');
    assert.ok(probe.max <= 3, `max parallel gets was ${probe.max}`);
    assert.equal(probe.total, 9);
  } finally {
    w.cleanup();
  }
  // parallelism proof: 3 workers must all be inside get() at once or this test deadlocks (-> fails by timeout)
  const w2 = makeWorld({ processing: { concurrency: 3 } });
  try {
    await seedMany(w2, 3);
    const barrier = new Barrier(3);
    const src = interceptStorage(w2.storage, { get: () => barrier.wait() });
    const res = await w2.engine({ source: src }).run('migrate');
    assert.equal(res.status, 'COMPLETE');
  } finally {
    w2.cleanup();
  }
});

test('concurrency: temp-byte budget bounds in-flight source bytes (I11) even with many workers', async () => {
  const w = makeWorld({ processing: { concurrency: 8, maxSourceBytes: 200_000, tempBudgetBytes: 200_000 } });
  try {
    await seedMany(w, 12);
    const eng = w.engine();
    const res = await eng.run('migrate');
    assert.equal(res.status, 'COMPLETE');
    assert.ok(eng.tempBudget.peak <= 200_000, `peak ${eng.tempBudget.peak}`);
    assert.equal(eng.tempBudget.inUse, 0, 'all budget released');
    assert.deepEqual(await checkInvariants(w), []);
  } finally {
    w.cleanup();
  }
});

test('limits: ByteBudget serves FIFO, never exceeds capacity, and refuses oversize requests instead of deadlocking', async () => {
  const b = new ByteBudget(100);
  const r1 = await b.acquire(60);
  let got2 = false;
  const p2 = b.acquire(60).then((r) => { got2 = true; return r; });
  await new Promise((r) => setImmediate(r));
  assert.equal(got2, false);
  assert.equal(b.waiting, 1);
  r1();
  const r2 = await p2;
  assert.equal(b.inUse, 60);
  r2();
  assert.equal(b.inUse, 0);
  await assert.rejects(b.acquire(101), /exceeds temp budget/);
  assert.ok(b.peak <= 100);
});

test('limits: Semaphore tracks the high-water mark and RateLimiter spaces starts (fake clock)', async () => {
  const s = new Semaphore(2);
  let active = 0;
  let max = 0;
  await Promise.all(Array.from({ length: 10 }, () => s.run(async () => { active++; max = Math.max(max, active); await new Promise((r) => setImmediate(r)); active--; })));
  assert.equal(max, 2);
  assert.equal(s.high, 2);

  let now = 0;
  const sleeps: number[] = [];
  const rl = new RateLimiter(10, () => now, async (ms) => { sleeps.push(ms); now += ms; });
  for (let i = 0; i < 5; i++) await rl.take();
  assert.deepEqual(sleeps, [100, 100, 100, 100], 'each start is 100ms after the previous');
});

test('lock: a second engine cannot start while the first holds the exclusive migration lock', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedMany(w, 2);
    let second: unknown = null;
    w.failpoints.on('download:before', async (n) => {
      if (n !== 1) return;
      // a second process (own pid, can see the first pid is alive) attempts to start mid-run
      const other = w.engine({ pid: 99999, isPidAlive: () => true });
      second = await other.run('migrate').catch((e) => e);
    });
    const res = await w.engine({ isPidAlive: () => true }).run('migrate');
    assert.equal(res.status, 'COMPLETE');
    assert.equal((second as any).kind, 'locked');
    assert.equal((second as any).exitCode, 7);
    assert.deepEqual(await checkInvariants(w), []);
  } finally {
    w.cleanup();
  }
});

test('shutdown: graceful stop between stages -> INTERRUPTED (exit 3), state saved, lock released, resume completes', async () => {
  const w = makeWorld({ processing: { concurrency: 2 } });
  try {
    await seedMany(w, 6);
    w.failpoints.on('upload:after', (n) => { if (n === 2) w.shutdown.request('SIGTERM'); });
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'INTERRUPTED');
    assert.equal(res.exitCode, 3);
    assert.match(res.message, /SIGTERM/);
    assert.equal(w.journal.inspectLock(), null, 'lock released');
    assert.equal(w.journal.getRun(res.runId)!.status, 'INTERRUPTED');
    assert.ok(w.journal.listAssets({ states: ['COMPLETE'] }).length < 6, 'not everything finished');
    assert.deepEqual(await checkInvariants(w, { expectNoTemp: true }), []);
    w.restart();
    const r2 = await w.engine().run('migrate', { runId: res.runId, resume: true });
    assert.equal(r2.status, 'COMPLETE', r2.message);
    assert.equal(w.journal.listAssets({ states: ['COMPLETE'] }).length, 6);
  } finally {
    w.cleanup();
  }
});

test('shutdown: `stop` request written to the journal is honoured by a running worker (cross-process stop)', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedMany(w, 4);
    w.failpoints.on('transition:after:COMPLETE', (n) => {
      if (n === 1) w.journal.requestStop(w.journal.listRuns(1)[0].runId);
    });
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'INTERRUPTED');
    assert.match(res.message, /stop-requested/);
    assert.equal(w.journal.listAssets({ states: ['COMPLETE'] }).length, 1);
  } finally {
    w.cleanup();
  }
});

test('shutdown: aborting an in-flight (stalled) download interrupts the asset without counting a failure', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedMany(w, 1);
    const stalled = {
      ...w.storage,
      kind: w.storage.kind, bucket: w.storage.bucket,
      head: (k: string) => w.storage.head(k),
      list: (p: string, o?: any) => w.storage.list(p, o),
      put: (k: string, b: any, o: any) => w.storage.put(k, b, o),
      delete: (k: string) => w.storage.delete(k),
      publicUrl: (k: string) => w.storage.publicUrl(k),
      async get(k: string, opts?: { signal?: AbortSignal }) {
        const real = await w.storage.get(k);
        const body = new Readable({ read() { /* never produces data: a hung connection */ } });
        opts?.signal?.addEventListener('abort', () => body.destroy(new Error('aborted')), { once: true });
        return { head: real.head, body };
      },
    };
    const eng = w.engine({ source: stalled as never });
    w.failpoints.on('download:before', () => { setTimeout(() => { w.shutdown.request('SIGINT'); w.shutdown.abortInFlight(); }, 20); });
    const res = await eng.run('migrate');
    assert.equal(res.status, 'INTERRUPTED');
    const a = w.journal.listAssets()[0];
    assert.equal(a.state, 'PROCESSING');
    assert.equal(a.lastError, 'interrupted');
    assert.equal(a.attempts, 1, 'a graceful interruption does not burn the retry budget');
    assert.deepEqual(fs.existsSync(path.join(w.dir, 'tmp')) ? fs.readdirSync(path.join(w.dir, 'tmp')) : [], [], 'temp cleaned');
    w.restart();
    const r2 = await w.engine().run('migrate', { runId: res.runId, resume: true });
    assert.equal(r2.status, 'COMPLETE');
    assert.equal(w.journal.listAssets()[0].attempts, 1);
  } finally {
    w.cleanup();
  }
});

test('retry storm: a persistently failing provider causes a BOUNDED number of calls, then terminal FAILED (no infinite loop)', async () => {
  const w = makeWorld({ processing: { concurrency: 2 } });
  try {
    await seedMany(w, 4);
    let puts = 0;
    const flaky = interceptStorage(w.storage, { put: () => { puts++; const e: any = new Error('connection reset'); e.code = 'ECONNRESET'; throw e; } });
    const res = await w.engine({ dest: flaky, source: w.storage }).run('migrate');
    assert.equal(res.status, 'INCOMPLETE');
    // 4 assets x (maxAttempts=3) tries on the first variant only (stage aborts on first failing upload)
    assert.ok(puts <= 4 * 3, `puts=${puts}`);
    assert.ok(w.journal.listAssets().every((a) => a.state === 'FAILED'));
    // resume does not hammer failed assets again (terminal until `retry`)
    const before = puts;
    await w.engine({ dest: flaky }).run('migrate', { runId: res.runId, resume: true });
    assert.equal(puts, before);
  } finally {
    w.cleanup();
  }
});

test('failure threshold: a run whose failures exceed the budget aborts early with FAILED (exit 1) instead of grinding on', async () => {
  const w = makeWorld({ processing: { concurrency: 1 }, migration: { failureThreshold: { maxFailed: 2, maxFailedRatio: 1 }, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0, maxItemAttempts: 3 } } });
  try {
    await seedMany(w, 10);
    w.failpoints.arm('upload:before', { mode: 'error', times: 1000 });
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'FAILED');
    assert.equal(res.exitCode, 1);
    assert.match(res.message, /failure threshold/);
    assert.ok(w.journal.listAssets({ states: ['FAILED'] }).length <= 3);
    assert.ok(w.journal.listAssets({ states: ['PLANNED'] }).length >= 7, 'remaining work untouched');
  } finally {
    w.cleanup();
  }
});

test('poison pill: an asset that crashes the worker every time is eventually quarantined (FAILED), not retried forever', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedMany(w, 1);
    let runId: string | undefined;
    let finalStatus = '';
    for (let cycle = 0; cycle < 12 && finalStatus === ''; cycle++) {
      w.failpoints.arm('process:after', { mode: 'crash', times: 1 });
      try {
        const r = await w.engine().run('migrate', runId ? { runId, resume: true } : {});
        runId = r.runId;
        finalStatus = r.status;
      } catch (e) {
        assert.ok(e instanceof SimulatedCrash);
        runId = w.journal.listRuns(1)[0].runId;
        w.restart();
      }
    }
    assert.equal(finalStatus, 'INCOMPLETE');
    assert.equal(w.journal.listAssets()[0].state, 'FAILED');
    assert.match(w.journal.listAssets()[0].lastError!, /retry budget exhausted/);
  } finally {
    w.cleanup();
  }
});

test('stress: 30 assets, 6 workers, randomized crash/resume cycles converge to a fully migrated, invariant-clean state', async () => {
  const rnd = prng(42);
  const w = makeWorld({ processing: { concurrency: 6 } });
  try {
    await seedMany(w, 30);
    let runId: string | undefined;
    let done = false;
    for (let cycle = 0; cycle < 25 && !done; cycle++) {
      w.failpoints.arm(FAILPOINT_NAMES[Math.floor(rnd() * FAILPOINT_NAMES.length)], { mode: 'crash', after: Math.floor(rnd() * 8) });
      try {
        const r = await w.engine().run('migrate', runId ? { runId, resume: true } : {});
        runId = r.runId;
        done = r.status === 'COMPLETE';
      } catch (e) {
        assert.ok(e instanceof SimulatedCrash, String(e));
        runId = w.journal.listRuns(1)[0].runId;
        assert.deepEqual(await checkInvariants(w, { expectNoTemp: false }), []);
        w.restart();
      }
    }
    if (!done) {
      w.restart();
      const r = await w.engine().run('migrate', { runId: runId!, resume: true });
      assert.equal(r.status, 'COMPLETE', r.message);
    }
    assert.equal(w.journal.listAssets({ states: ['COMPLETE'] }).length, 30);
    assert.deepEqual(await checkInvariants(w), []);
  } finally {
    w.cleanup();
  }
});

test('memory: a 64 MB source is streamed to disk, not buffered (peak RSS growth stays far below file size)', async () => {
  const w = makeWorld({ processing: { concurrency: 1, maxSourceBytes: 100 * 1024 * 1024, tempBudgetBytes: 128 * 1024 * 1024 } });
  const fsRoot = path.join(w.dir, 'fsrc');
  try {
    const src = new FsStorage('bkt', fsRoot);
    const big = path.join(fsRoot, 'objects', 'huge');
    fs.mkdirSync(big, { recursive: true });
    // 64 MB of non-image bytes under a .jpg key: downloaded, hashed and then classified as not-an-image
    const chunk = randomBytes(1024 * 1024, 7);
    const fd = fs.openSync(path.join(big, 'x.jpg'), 'w');
    for (let i = 0; i < 64; i++) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
    w.db.insert('products', 'huge', { photo: w.url('huge/x.jpg') });
    global.gc?.();
    const base = process.memoryUsage().rss;
    let peak = base;
    const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
    const res = await w.engine({ source: src }).run('migrate');
    clearInterval(t);
    assert.equal(res.status, 'COMPLETE');
    assert.equal(w.journal.listAssets()[0].state, 'SKIPPED');
    const growthMb = (peak - base) / 1024 / 1024;
    assert.ok(growthMb < 48, `RSS grew by ${growthMb.toFixed(1)} MB while streaming a 64 MB file`);
    assert.ok(w.journal.counters(res.runId).bytesRead >= 64 * 1024 * 1024);
  } finally {
    w.cleanup();
  }
});

test('processor crash: a processor that throws on one asset fails only that asset; others complete; temp files are cleaned', async () => {
  const { faultyProcessor } = await import('../../src/testing/faults');
  const { SharpProcessor } = await import('../../src/processing/imageProcessor');
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedCatalogue(w, 2);
    let n = 0;
    const proc = faultyProcessor(new SharpProcessor(), () => (++n === 4 ? new Error('libvips segfault (simulated)') : null));
    const res = await w.engine({ processor: proc }).run('migrate');
    assert.equal(res.status, 'INCOMPLETE');
    assert.equal(w.journal.listAssets({ states: ['FAILED'] }).length, 1);
    assert.equal(w.journal.listAssets({ states: ['COMPLETE'] }).length, 2);
    assert.deepEqual(await checkInvariants(w), []);
  } finally {
    w.cleanup();
  }
});
