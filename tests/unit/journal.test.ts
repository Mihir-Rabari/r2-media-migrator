import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SqliteJournal } from '../../src/journal/sqliteJournal';
import type { RunRecord } from '../../src/domain/types';
import { MediaMigrateError } from '../../src/domain/errors';
import { withTmp } from '../helpers';

const run = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  runId: id, kind: 'migrate', status: 'RUNNING', configFingerprint: 'fp', dryRun: false, pid: 1, host: 'h', startedAt: new Date().toISOString(),
  finishedAt: null, lastHeartbeatAt: null, stopRequested: false, blockingError: null, params: {}, ...over,
});
const asset = (id: string) => ({
  assetId: id, sourceProvider: 's3', sourceBucket: 'b', sourceKey: `k/${id}.jpg`, sourceUrl: null, sourceSha256: null, sourceBytes: null,
  sourceMime: null, sourceWidth: null, sourceHeight: null, mediaType: 'image' as const,
});

test('journal: legal transitions persist and illegal ones throw (state-machine enforcement)', () => {
  const j = new SqliteJournal(':memory:');
  j.createRun(run('r1'));
  j.upsertDiscovered(asset('a1'), 'r1');
  assert.throws(() => j.transition('a1', 'COMPLETE', { runId: 'r1' }), /illegal asset transition DISCOVERED -> COMPLETE/);
  j.transition('a1', 'PLANNED', { runId: 'r1' });
  j.transition('a1', 'PROCESSING', { runId: 'r1' });
  assert.equal(j.getAsset('a1')!.state, 'PROCESSING');
  assert.ok(j.events('r1').some((e) => e.type === 'asset.transition' && e.detail.to === 'PROCESSING'));
  j.close();
});

test('journal: upsertDiscovered is idempotent and refs keep the immutable original value', () => {
  const j = new SqliteJournal(':memory:');
  j.createRun(run('r1'));
  j.upsertDiscovered(asset('a1'), 'r1');
  j.upsertDiscovered(asset('a1'), 'r1');
  assert.equal(j.listAssets().length, 1);
  const loc = { collection: 'c', docId: 'd', path: 'p' };
  j.upsertRef({ ...loc, assetId: 'a1', originalValue: 'orig', newValue: null, status: 'PENDING', runId: 'r1' });
  const second = j.upsertRef({ ...loc, assetId: 'a1', originalValue: 'CHANGED', newValue: null, status: 'PENDING', runId: 'r1' });
  assert.equal(second.originalValue, 'orig');
  j.close();
});

test('journal: claimNext never hands the same asset to two connections', async () => {
  await withTmp((dir) => {
    const file = path.join(dir, 'j.sqlite');
    const a = new SqliteJournal(file);
    const b = new SqliteJournal(file);
    a.createRun(run('r1'));
    for (let i = 0; i < 20; i++) {
      a.upsertDiscovered(asset(`a${String(i).padStart(2, '0')}`), 'r1');
      a.transition(`a${String(i).padStart(2, '0')}`, 'PLANNED', { runId: 'r1' });
    }
    const got: string[] = [];
    for (let i = 0; i < 20; i++) {
      const x = (i % 2 ? a : b).claimNext('r1', i % 2 ? 'wa' : 'wb', ['PLANNED'], 60_000);
      if (x) got.push(x.assetId);
    }
    assert.equal(got.length, 20);
    assert.equal(new Set(got).size, 20, 'no duplicates');
    assert.equal(a.claimNext('r1', 'wa', ['PLANNED'], 60_000), null);
    a.close();
    b.close();
  });
});

test('journal: lock is exclusive, stale (dead pid / expired heartbeat) locks are taken over atomically', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const j = new SqliteJournal(':memory:', { clock: () => new Date(now) });
  j.createRun(run('r1'));
  j.createRun(run('r2'));
  const alive = () => true;
  const h1 = j.acquireLock('r1', { staleAfterMs: 60_000, pid: 100, host: 'h', isPidAlive: alive });
  assert.throws(() => j.acquireLock('r2', { staleAfterMs: 60_000, pid: 200, host: 'h', isPidAlive: alive }), (e: any) => e instanceof MediaMigrateError && e.kind === 'locked');
  // dead pid on same host => takeover, previous run marked INTERRUPTED, never COMPLETE
  const h2 = j.acquireLock('r2', { staleAfterMs: 60_000, pid: 200, host: 'h', isPidAlive: () => false });
  assert.equal(j.getRun('r1')!.status, 'INTERRUPTED');
  assert.throws(() => j.refreshLock(h1), /lost the migration lock/);
  // heartbeat expiry on a different host
  now += 120_000;
  j.createRun(run('r3'));
  j.acquireLock('r3', { staleAfterMs: 60_000, pid: 300, host: 'other', isPidAlive: alive });
  assert.throws(() => j.refreshLock(h2));
  j.close();
});

test('journal: corrupt file is reported as JOURNAL_UNREADABLE, never silently recreated', async () => {
  await withTmp((dir) => {
    const file = path.join(dir, 'j.sqlite');
    fs.writeFileSync(file, Buffer.from('this is not a sqlite database at all'.repeat(50)));
    assert.throws(() => new SqliteJournal(file), (e: any) => e.code === 'JOURNAL_UNREADABLE');
  });
});

test('journal: integrityCheck flags I1 violations (reference updated without verified variants)', () => {
  const j = new SqliteJournal(':memory:');
  j.createRun(run('r1'));
  j.upsertDiscovered(asset('a1'), 'r1');
  j.upsertRef({ collection: 'c', docId: 'd', path: 'p', assetId: 'a1', originalValue: 'o', newValue: 'n', status: 'PENDING', runId: 'r1' });
  j.setRefStatus({ collection: 'c', docId: 'd', path: 'p' }, 'UPDATING', {});
  const r = j.integrityCheck();
  assert.equal(r.ok, false);
  assert.match(r.messages.join('\n'), /I1 violation/);
  j.close();
});

test('journal: backupTo produces an openable consistent copy', async () => {
  await withTmp((dir) => {
    const j = new SqliteJournal(path.join(dir, 'j.sqlite'));
    j.createRun(run('r1'));
    j.upsertDiscovered(asset('a1'), 'r1');
    j.backupTo(path.join(dir, 'bak', 'j.sqlite'));
    j.close();
    const b = new SqliteJournal(path.join(dir, 'bak', 'j.sqlite'));
    assert.equal(b.listAssets().length, 1);
    b.close();
  });
});
