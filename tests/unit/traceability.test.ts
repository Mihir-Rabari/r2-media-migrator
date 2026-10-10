import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repo = path.resolve(__dirname, '..', '..', '..');

test('traceability matrix: every referenced test file exists and contains the referenced fragment', () => {
  const md = fs.readFileSync(path.join(repo, 'reports', 'media-migration', 'test-traceability-matrix.md'), 'utf8');
  const refs = [...md.matchAll(/`((?:tests|src)\/[A-Za-z0-9_./-]+\.ts) :: ([^`]+)`/g)].map((m) => ({ file: m[1], fragment: m[2] }));
  assert.ok(refs.length > 60, `expected a substantial matrix, found ${refs.length} references`);
  const stale: string[] = [];
  for (const r of refs) {
    const p = path.join(repo, r.file);
    if (!fs.existsSync(p)) { stale.push(`${r.file}: file missing`); continue; }
    if (!fs.readFileSync(p, 'utf8').includes(r.fragment)) stale.push(`${r.file} :: ${r.fragment}`);
  }
  assert.deepEqual(stale, [], `stale traceability references:\n${stale.join('\n')}`);
});

test('traceability matrix: every invariant I1..I15 appears', () => {
  const md = fs.readFileSync(path.join(repo, 'reports', 'media-migration', 'test-traceability-matrix.md'), 'utf8');
  for (let i = 1; i <= 15; i++) assert.match(md, new RegExp(`\\| I${i} \\|`), `I${i}`);
});

test('state-machine.md documents every transition in the code', async () => {
  const full = fs.readFileSync(path.join(repo, 'reports', 'media-migration', 'state-machine.md'), 'utf8');
  const md = full.slice(full.indexOf('BEGIN GENERATED'), full.indexOf('END GENERATED'));
  const { ASSET_TRANSITIONS } = await import('../../src/domain/stateMachine');
  for (const [from, tos] of Object.entries(ASSET_TRANSITIONS)) {
    const row = md.split('\n').find((l) => l.startsWith(`| \`${from}\` |`) && l.includes('`'));
    assert.ok(row, `missing row for ${from}`);
    for (const t of tos) assert.ok(row!.includes(`\`${t}\``), `${from} -> ${t} missing from docs (run npm run docs:state)`);
  }
});

test('every failpoint is documented in the recovery matrix', async () => {
  const md = fs.readFileSync(path.join(repo, 'reports', 'media-migration', 'recovery-matrix.md'), 'utf8');
  const { FAILPOINT_NAMES } = await import('../../src/core/failpoints');
  for (const n of FAILPOINT_NAMES) {
    const base = n.replace(/^transition:(before|after):/, '');
    const key = n.startsWith('transition:') ? base : n.replace(/:(before|after)$/, '');
    assert.ok(md.includes(key), `failpoint ${n} not covered in recovery-matrix.md (looked for "${key}")`);
  }
});

test('configuration-reference.md lists every top-level config section', async () => {
  const md = fs.readFileSync(path.join(repo, 'reports', 'media-migration', 'configuration-reference.md'), 'utf8');
  const { configSchema } = await import('../../src/config/schema');
  for (const k of Object.keys(configSchema.shape)) assert.ok(md.includes(`| \`${k}\``), `section ${k} missing (run npm run docs:config)`);
});
