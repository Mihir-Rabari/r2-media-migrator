/** Journal scalability micro-benchmark (not a test). Usage: node dist-test/tests/perf/journal-bench.js [--n 20000] [--out file] */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteJournal } from '../../src/journal/sqliteJournal';
import { computeProgress } from '../../src/observability/progress';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('n', '20000'));
const OUT = arg('out', '');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-jb-'));
const j = new SqliteJournal(path.join(dir, 'j.sqlite'));
const t = <T>(f: () => T): [T, number] => { const s = performance.now(); const r = f(); return [r, performance.now() - s]; };
j.createRun({ runId: 'r', kind: 'migrate', status: 'RUNNING', configFingerprint: 'x', dryRun: false, pid: 1, host: 'h', startedAt: new Date().toISOString(), finishedAt: null, lastHeartbeatAt: null, stopRequested: false, blockingError: null, params: {} });
const res: Record<string, unknown> = { n: N, node: process.version, platform: process.platform };

res.insertAssetsAndRefsMs = t(() => j.tx(() => {
  for (let i = 0; i < N; i++) {
    const id = `a${String(i).padStart(24, '0')}`;
    j.upsertDiscovered({ assetId: id, sourceProvider: 's3', sourceBucket: 'b', sourceKey: `products/${i}.jpg`, sourceUrl: null, sourceSha256: null, sourceBytes: 100, sourceMime: null, sourceWidth: null, sourceHeight: null, mediaType: 'image' }, 'r');
    j.upsertRef({ collection: 'products', docId: `str:${i}`, path: 'photo', assetId: id, originalValue: `https://cdn/products/${i}.jpg`, newValue: null, status: 'PENDING', runId: 'r' });
  }
}))[1];
res.planAllMs = t(() => j.tx(() => { for (const a of j.listAssets()) j.transition(a.assetId, 'PLANNED', { runId: 'r' }); }))[1];
let claimed = 0;
const [, claimMs] = t(() => { for (;;) { const a = j.claimNext('r', 'w', ['PLANNED'], 1e9); if (!a) break; claimed++; if (claimed >= 2000) break; } });
res.claimNext2000Ms = claimMs;
res.claimNextPerCallMsAtN = claimMs / claimed;
res.transitionOneByOne2000Ms = t(() => { let k = 0; for (const a of j.listAssets({ states: ['PLANNED'], limit: 2000 })) { j.transition(a.assetId, 'PROCESSING', { runId: 'r' }); k++; } return k; })[1];
res.computeProgressMs = t(() => computeProgress(j, j.getRun('r')!))[1];
res.fileSizeMB = +(fs.statSync(path.join(dir, 'j.sqlite')).size / 1048576).toFixed(1);
console.log(JSON.stringify(res, null, 2));
if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(res, null, 2)); }
j.close();
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
