import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import type { JournalStore } from '../core/interfaces';
import type { MappingEntry } from '../compatibility/resolver';
import { computeProgress, ProgressSnapshot } from '../observability/progress';
import { globalRedactor } from '../security/redact';
import { fmtBytes } from '../observability/logger';

export interface RunReport {
  generatedAt: string;
  run: Record<string, unknown>;
  progress: ProgressSnapshot;
  skippedReasons: Record<string, number>;
  failed: Array<{ assetId: string; sourceKey: string; state: string; attempts: number; error: string | null }>;
  conflicts: Array<{ collection: string; docId: string; path: string; status: string; assetId: string }>;
  orphans: Array<{ key: string; bytes: number; reason: string }>;
  duplicateGroups: Array<{ sha256: string; assetIds: string[] }>;
  cacheOps: { total: number; byStatus: Record<string, number>; failed: Array<{ url: string; detail: string | null }> };
  timings: Record<string, { count: number; avgMs: number; maxMs: number; totalMs: number }>;
  counters: Record<string, number>;
  inventory: unknown;
  plan: unknown;
  dryRun: unknown;
  summary: unknown;
  journalIntegrity: { ok: boolean; messages: string[] };
  honesty: string[];
}

export function buildReport(journal: JournalStore, runId: string): RunReport {
  const run = journal.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const progress = computeProgress(journal, run);
  const assets = journal.listAssets();
  const skippedReasons: Record<string, number> = {};
  for (const a of assets) if (a.state === 'SKIPPED') skippedReasons[a.skipReason ?? 'unknown'] = (skippedReasons[a.skipReason ?? 'unknown'] ?? 0) + 1;
  const ops = journal.listCacheOps(runId);
  const byStatus: Record<string, number> = {};
  for (const o of ops) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  const timings: RunReport['timings'] = {};
  for (const [k, v] of Object.entries(journal.timings(runId))) timings[k] = { count: v.count, avgMs: v.totalMs / Math.max(1, v.count), maxMs: v.maxMs, totalMs: v.totalMs };
  const c = journal.counters(runId);
  const honesty: string[] = [];
  if (run.dryRun) honesty.push('DRY RUN: nothing was uploaded, no database record was changed, no cache was purged.');
  if (run.status !== 'COMPLETE' && run.status !== 'DRY_RUN_COMPLETE') honesty.push(`Run status is ${run.status}: this is NOT a successful completed migration.`);
  if ((run.params as { limit?: number }).limit) honesty.push('PARTIAL SCOPE (--limit): only a sample of assets was processed.');
  honesty.push('"purge confirmed" means the CDN API accepted the request; it does not prove edge/browser caches were cleared.');
  honesty.push('Video files are not optimised by this release; they are skipped and their references are never rewritten.');
  const report: RunReport = {
    generatedAt: new Date().toISOString(),
    run: run as unknown as Record<string, unknown>,
    progress,
    skippedReasons,
    failed: assets.filter((a) => ['FAILED', 'SOURCE_MISSING', 'CONFLICT', 'RECONCILE_REQUIRED'].includes(a.state)).slice(0, 500).map((a) => ({ assetId: a.assetId, sourceKey: a.sourceKey, state: a.state, attempts: a.attempts, error: a.lastError })),
    conflicts: journal.listRefs({ statuses: ['CONFLICT', 'ROLLBACK_CONFLICT'], limit: 500 }).map((r) => ({ collection: r.collection, docId: r.docId, path: r.path, status: r.status, assetId: r.assetId })),
    orphans: journal.listOrphans().slice(0, 500).map((o) => ({ key: o.key, bytes: o.bytes, reason: o.reason })),
    duplicateGroups: journal.duplicateGroups().slice(0, 200),
    cacheOps: { total: ops.length, byStatus, failed: ops.filter((o) => o.status === 'FAILED').slice(0, 100).map((o) => ({ url: o.url, detail: o.detail })) },
    timings,
    counters: { bytesRead: c.bytesRead, bytesWritten: c.bytesWritten, dbUpdates: c.dbUpdates, retries: c.retries, purgesRequested: c.purgesRequested },
    inventory: journal.latest(runId, 'inventory:stats')?.data ?? null,
    plan: journal.latest(runId, 'plan:summary')?.data ?? null,
    dryRun: journal.latest(runId, 'dryrun:summary')?.data ?? null,
    summary: journal.latest(runId, 'summary')?.data ?? null,
    journalIntegrity: journal.integrityCheck(),
    honesty,
  };
  return globalRedactor.deep(report);
}

export function reportMarkdown(r: RunReport): string {
  const p = r.progress;
  const L: string[] = [];
  L.push(`# Run report ${p.runId}`, '', `Generated ${r.generatedAt}`, '');
  for (const h of r.honesty) L.push(`> ${h}`);
  L.push('', '## Status', '', `| | |`, `|---|---|`, `| Kind | ${p.kind}${p.dryRun ? ' (dry run)' : ''} |`, `| Status | **${p.status}** |`, `| Phase | ${p.phase} |`,
    `| Assets (total) | ${p.total}${p.totalKnown ? '' : ' (inventory not complete)'} |`, `| Completed | ${p.completed} |`, `| Skipped (policy) | ${p.skipped} |`, `| Failed | ${p.failed} |`,
    `| Conflicts | ${p.conflicts} |`, `| Verified destinations | ${p.verifiedDestinations} |`, `| Database updates | ${p.dbUpdates} |`, `| Orphaned destinations | ${p.orphans} |`,
    `| Bytes read / written | ${fmtBytes(p.bytesRead)} / ${fmtBytes(p.bytesWritten)} |`, `| Elapsed | ${p.elapsedSec.toFixed(1)} s |`,
    `| Throughput | ${p.throughputBytesPerSec ? fmtBytes(p.throughputBytesPerSec) + '/s' : 'n/a'} |`, `| Percent | ${p.percent === null ? 'unknown (denominator not final)' : p.percent.toFixed(1) + '%'} |`,
    `| ETA | ${p.etaSec === null ? 'n/a' : Math.round(p.etaSec) + ' s'} |`, `| Blocking error | ${p.blockingError ?? 'none'} |`, '');
  L.push('## Assets by state', '', '| State | Count |', '|---|---|', ...Object.entries(p.byState).map(([k, v]) => `| ${k} | ${v} |`), '');
  if (Object.keys(r.skippedReasons).length) L.push('## Skipped (policy)', '', ...Object.entries(r.skippedReasons).map(([k, v]) => `- ${k}: ${v}`), '');
  if (r.failed.length) L.push('## Failed / blocked assets', '', '| Asset | Source | State | Attempts | Error |', '|---|---|---|---|---|', ...r.failed.slice(0, 50).map((f) => `| ${f.assetId} | ${f.sourceKey} | ${f.state} | ${f.attempts} | ${(f.error ?? '').replace(/\|/g, '\\|').slice(0, 160)} |`), '');
  if (r.conflicts.length) L.push('## Reference conflicts', '', ...r.conflicts.slice(0, 50).map((c) => `- ${c.collection}/${c.docId}/${c.path} (${c.status})`), '');
  L.push('## Cache operations', '', `Total ${r.cacheOps.total}: ${JSON.stringify(r.cacheOps.byStatus)}`, '');
  L.push('## Timings (per phase)', '', '| Phase | Count | Avg ms | Max ms |', '|---|---|---|---|', ...Object.entries(r.timings).map(([k, t]) => `| ${k} | ${t.count} | ${t.avgMs.toFixed(1)} | ${t.maxMs.toFixed(1)} |`), '');
  L.push('## Journal integrity', '', r.journalIntegrity.ok ? 'OK' : `PROBLEMS:\n${r.journalIntegrity.messages.map((m) => `- ${m}`).join('\n')}`, '');
  return L.join('\n');
}

/** Verified assets only: this file is what the legacy-URL resolver loads. */
export function exportMapping(journal: JournalStore): MappingEntry[] {
  const out: MappingEntry[] = [];
  for (const a of journal.listAssets({ states: ['DESTINATION_VERIFIED', 'REFERENCES_UPDATED', 'CACHE_HANDLED', 'COMPLETE'] })) {
    const vs = journal.listVariants(a.assetId);
    if (vs.length === 0 || vs.some((v) => !v.verified)) continue;
    out.push({ assetId: a.assetId, sourceKey: a.sourceKey, state: a.state, variants: vs.map((v) => ({ width: v.width, effectiveWidth: v.effectiveWidth, format: v.format, key: v.key })) });
  }
  return out;
}

export function writeMappingFile(file: string, entries: MappingEntry[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  fs.renameSync(tmp, file); // atomic replace: readers never see a partial mapping
}

export function readMappingFile(file: string): MappingEntry[] {
  if (!fs.existsSync(file)) return [];
  const out: MappingEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as MappingEntry;
      if (e.assetId && e.sourceKey && Array.isArray(e.variants)) out.push(e);
    } catch {
      /* skip corrupt line: an unresolved mapping is safe, a guessed one is not */
    }
  }
  return out;
}

export function writeReportFiles(journal: JournalStore, runId: string, dir: string): { dir: string; files: string[] } {
  const out = path.join(dir, runId);
  fs.mkdirSync(out, { recursive: true });
  const report = buildReport(journal, runId);
  const files: string[] = [];
  const w = (name: string, content: string) => {
    const f = path.join(out, name);
    fs.writeFileSync(f, content);
    files.push(f);
  };
  w('report.json', JSON.stringify(report, null, 2));
  w('report.md', reportMarkdown(report));
  w('assets.jsonl', journal.listAssets().map((a) => JSON.stringify(globalRedactor.deep(a))).join('\n') + '\n');
  w('errors.jsonl', journal.events(runId, { level: 'error', limit: 5000 }).map((e) => JSON.stringify(globalRedactor.deep(e))).join('\n') + '\n');
  writeMappingFile(path.join(out, 'mapping.jsonl'), exportMapping(journal));
  files.push(path.join(out, 'mapping.jsonl'));
  return { dir: out, files };
}

// ───────── human review artifacts ─────────

/** Contact sheet PNG (source vs smallest variant per sampled asset) + static HTML review page with sizes. */
export async function buildReviewArtifacts(samplesDir: string, outDir: string, journal: JournalStore, runId: string): Promise<{ png: string | null; html: string; count: number }> {
  fs.mkdirSync(outDir, { recursive: true });
  const rows: Array<{ id: string; files: string[]; detail: any }> = [];
  for (const e of journal.events(runId, { limit: 5000 }).filter((x) => x.type === 'dryrun.asset')) {
    const dir = path.join(samplesDir, e.assetId!);
    if (fs.existsSync(dir)) rows.push({ id: e.assetId!, files: fs.readdirSync(dir).sort(), detail: e.detail });
  }
  const TILE = 220;
  const tiles: Array<{ input: Buffer; left: number; top: number }> = [];
  const cols = 4;
  let n = 0;
  for (const r of rows.slice(0, 24)) {
    for (const [i, f] of [r.files.find((x) => x.startsWith('source')), r.files.filter((x) => /^\d+\./.test(x)).sort((a, b) => parseInt(a) - parseInt(b))[0]].entries()) {
      if (!f) continue;
      const buf = await sharp(path.join(samplesDir, r.id, f), { failOn: 'none' }).rotate().resize(TILE - 10, TILE - 10, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
      tiles.push({ input: buf, left: ((n % (cols / 2)) * 2 + i) * TILE + 5, top: Math.floor(n / (cols / 2)) * TILE + 5 });
    }
    n++;
  }
  let png: string | null = null;
  if (tiles.length) {
    const rowsN = Math.ceil(n / (cols / 2));
    png = path.join(outDir, 'contact-sheet.png');
    await sharp({ create: { width: cols * TILE, height: rowsN * TILE, channels: 3, background: '#e8e8e8' } }).composite(tiles).png().toFile(png);
  }
  const html = path.join(outDir, 'review.html');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  fs.writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><title>Review ${esc(runId)}</title><style>body{font:14px system-ui;margin:20px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px;vertical-align:top}img{max-width:260px;max-height:200px;display:block}</style>
<h1>Visual review — run ${esc(runId)}</h1><p>Compare each source with its variants. Look for: banding, colour shifts, wrong orientation, cropping, lost transparency, over-compression. Record approval in <code>review-approvals.json</code> (see docs/operations.md, "Sample review").</p>
${png ? '<p><img src="contact-sheet.png" style="max-width:100%;max-height:none"></p>' : ''}
<table><tr><th>Asset / source</th><th>Source</th><th>Variants</th></tr>
${rows
  .map((r) => {
    const src = r.files.find((x) => x.startsWith('source'));
    const vs = (r.detail.variants as Array<{ width: number; effectiveWidth: number; bytes: number }>) ?? [];
    return `<tr><td>${esc(r.id)}<br>${esc(String(r.detail.sourceKey))}<br>${r.detail.sourceWidth}x${r.detail.sourceHeight} ${fmtBytes(Number(r.detail.sourceBytes))}</td><td>${src ? `<img src="${esc(path.relative(outDir, path.join(samplesDir, r.id, src)).replace(/\\/g, '/'))}">` : ''}</td><td>${vs
      .map((v) => `<div>${v.width}px (actual ${v.effectiveWidth}) — ${fmtBytes(v.bytes)} — ${((v.bytes / Number(r.detail.sourceBytes)) * 100).toFixed(0)}% of source<img src="${esc(path.relative(outDir, path.join(samplesDir, r.id, `${v.width}.webp`)).replace(/\\/g, '/'))}"></div>`)
      .join('')}</td></tr>`;
  })
  .join('\n')}</table>`,
  );
  return { png, html, count: rows.length };
}
