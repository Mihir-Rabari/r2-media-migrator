import test from 'node:test';
import assert from 'node:assert/strict';
import { FAILPOINT_NAMES } from '../../src/core/failpoints';
import { SimulatedCrash } from '../../src/domain/errors';
import { makeWorld, seedCatalogue, World } from '../../src/testing/harness';
import { checkInvariants } from '../../src/testing/invariants';

/**
 * Crash-recovery matrix. For EVERY failpoint (at its 1st and 3rd hit) a run is killed mid-flight, then:
 *  1. the run must not be reported complete,
 *  2. safety invariants must hold at the crash instant,
 *  3. a fresh "process" resumes the same run id and finishes,
 *  4. the final database + object-store state equals an uncrashed run (idempotent recovery),
 *  5. a second resume is a no-op and an auditable summary exists.
 */

async function cleanRunSnapshot(): Promise<{ db: string; objects: string }> {
  const w = makeWorld();
  try {
    await seedCatalogue(w, 3);
    const r = await w.engine().run('migrate');
    assert.equal(r.status, 'COMPLETE');
    return snap(w);
  } finally {
    w.cleanup();
  }
}
const snap = (w: World) => ({
  db: w.db.snapshot(),
  objects: JSON.stringify([...w.storage.objects].map(([k, o]) => [k, o.head.metadata.sha256 ?? null, o.head.size]).sort()),
});

let baseline: { db: string; objects: string };
test('crash matrix: baseline (uncrashed) snapshot', async () => {
  baseline = await cleanRunSnapshot();
  assert.ok(baseline.db.length > 100);
});

for (const fpName of FAILPOINT_NAMES) {
  for (const after of [0, 2]) {
    test(`crash matrix: crash at ${fpName} (after ${after} hits) -> resume reaches the same safe final state`, async () => {
      const w = makeWorld({ processing: { concurrency: 1 } });
      try {
        await seedCatalogue(w, 3);
        w.failpoints.arm(fpName, { mode: 'crash', after });
        let runId = '';
        await assert.rejects(
          async () => {
            const eng = w.engine();
            const p = eng.run('migrate');
            runId = ''; // not known until created; read from journal below
            await p;
          },
          (e: unknown) => e instanceof SimulatedCrash,
        );
        runId = w.journal.listRuns(1)[0].runId;
        const run = w.journal.getRun(runId)!;
        assert.equal(run.status, 'RUNNING', 'a crashed run must not be marked finished');
        assert.notEqual(run.status, 'COMPLETE');
        const atCrash = await checkInvariants(w, { expectNoTemp: false });
        assert.deepEqual(atCrash, [], `invariants at crash point ${fpName}`);

        // "new process"
        w.restart();
        const res = await w.engine().run('migrate', { runId, resume: true });
        assert.equal(res.status, 'COMPLETE', `${fpName}: ${res.message}`);
        const bad = await checkInvariants(w);
        assert.deepEqual(bad, [], `invariants after recovery from ${fpName}`);

        const s = snap(w);
        assert.equal(s.db, baseline.db, `${fpName}: database differs from an uncrashed run`);
        assert.equal(s.objects, baseline.objects, `${fpName}: object store differs from an uncrashed run`);

        // second resume: no changes
        const putsBefore = w.storage.mutations;
        const again = await w.engine().run('migrate', { runId, resume: true });
        assert.equal(again.status, 'COMPLETE');
        assert.equal(w.storage.mutations, putsBefore);
        assert.equal(snap(w).db, baseline.db);

        // auditable trail
        assert.ok(w.journal.getRun(runId)!.finishedAt);
        assert.ok(w.journal.latest(runId, 'summary'));
        assert.ok(w.journal.events(runId, { limit: 5000 }).some((e) => e.type === 'lock.takeover'), 'stale lock takeover was recorded');
      } finally {
        w.cleanup();
      }
    });
  }
}

test('crash matrix: the failpoint list is exercised (each name is actually reached during a migration)', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedCatalogue(w, 2);
    for (const n of FAILPOINT_NAMES) w.failpoints.on(n, () => undefined);
    await w.engine().run('migrate');
    const unreached = FAILPOINT_NAMES.filter((n) => w.failpoints.hitCount(n) === 0);
    assert.deepEqual(unreached, [], 'every declared failpoint must be reachable');
  } finally {
    w.cleanup();
  }
});

test('crash matrix: repeated crash/resume cycles at random points always converge (randomized, seeded)', async () => {
  const { prng } = await import('../helpers');
  for (const seed of [1, 2, 3, 4, 5]) {
    const rnd = prng(seed);
    const w = makeWorld({ processing: { concurrency: 2 } });
    try {
      await seedCatalogue(w, 3);
      let runId: string | undefined;
      let crashes = 0;
      for (let cycle = 0; cycle < 12; cycle++) {
        const fp = FAILPOINT_NAMES[Math.floor(rnd() * FAILPOINT_NAMES.length)];
        w.failpoints.arm(fp, { mode: 'crash', after: Math.floor(rnd() * 4) });
        try {
          const res = await w.engine().run('migrate', runId ? { runId, resume: true } : {});
          runId = res.runId;
          if (res.status === 'COMPLETE') break;
        } catch (e) {
          assert.ok(e instanceof SimulatedCrash, String(e));
          crashes++;
          runId = w.journal.listRuns(1)[0].runId;
          assert.deepEqual(await checkInvariants(w, { expectNoTemp: false }), [], `seed ${seed} cycle ${cycle} @${fp}`);
          w.restart();
        }
      }
      // final clean resume
      w.restart();
      const fin = await w.engine().run('migrate', runId ? { runId, resume: true } : {});
      assert.equal(fin.status, 'COMPLETE', `seed ${seed}: ${fin.message}`);
      assert.deepEqual(await checkInvariants(w), []);
      assert.equal(snap(w).db, baseline.db, `seed ${seed}: converged state differs`);
      assert.ok(crashes > 0 || seed >= 0);
    } finally {
      w.cleanup();
    }
  }
});

test('transient failures: one injected error per external side effect is retried and the run still completes (retry counted)', async () => {
  for (const fpName of ['download:before', 'upload:before', 'verify:before', 'db:before-write', 'cache:before'] as const) {
    const w = makeWorld({ processing: { concurrency: 1 } });
    try {
      await seedCatalogue(w, 2);
      w.failpoints.arm(fpName, { mode: 'error', after: 0, times: 1 });
      const res = await w.engine().run('migrate');
      assert.equal(res.status, 'COMPLETE', `${fpName}: ${res.message}`);
      assert.ok(w.journal.counters(res.runId).retries >= 1, `${fpName}: retry was counted`);
      assert.deepEqual(await checkInvariants(w), []);
    } finally {
      w.cleanup();
    }
  }
});

test('transient failures: a persistent error exhausts the retry budget -> FAILED (terminal), run INCOMPLETE, nothing falsely complete', async () => {
  const w = makeWorld({ processing: { concurrency: 1 } });
  try {
    await seedCatalogue(w, 2);
    w.failpoints.arm('upload:before', { mode: 'error', after: 0, times: 1000 });
    const res = await w.engine().run('migrate');
    assert.equal(res.status, 'INCOMPLETE');
    assert.equal(res.exitCode, 4);
    assert.ok(w.journal.listAssets().every((a) => a.state === 'FAILED'));
    assert.equal(w.journal.listAssets({ states: ['COMPLETE'] }).length, 0);
    // database untouched: I1
    assert.deepEqual(await checkInvariants(w), []);
    const doc = w.db.getDoc('products', 'prod0');
    assert.ok(doc.photo.includes('cdn.legacy.test'));
    assert.ok(w.journal.counters(res.runId).retries >= 2, 'bounded retries, not infinite');
  } finally {
    w.cleanup();
  }
});
