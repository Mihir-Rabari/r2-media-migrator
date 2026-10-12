import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { Parsed } from './args';
import { buildRuntime, journalFile, Runtime } from './factory';
import { describeConfig, loadConfig, LoadedConfig, resolvePath } from '../config/load';
import { ExitCode, MediaMigrateError, errorMessage, safetyError, validationError } from '../domain/errors';
import { newRunId } from '../domain/ids';
import { installSignalHandlers, ShutdownController } from '../core/shutdown';
import { MigrationEngine } from '../migration/engine';
import { verify } from '../migration/verify';
import { reconcile } from '../migration/reconcile';
import { rollback } from '../migration/rollback';
import { evaluateReadiness, readAttestations, writeAttestations, Attestations } from '../migration/readiness';
import { computeProgress } from '../observability/progress';
import { HumanReporter, JsonReporter, NullReporter, fmtBytes } from '../observability/logger';
import { buildReport, buildReviewArtifacts, exportMapping, reportMarkdown, writeMappingFile, writeReportFiles } from '../reporting/report';
import { defaultPidAlive } from '../migration/engine';
import { launchBackground } from './background';
import { MINIMAL_CONFIG } from './templates';
import { SqliteJournal } from '../journal/sqliteJournal';
import { globalRedactor } from '../security/redact';
import type { RunKindForEngine } from '../migration/context';
import { os_hostname } from '../migration/util';
import { discoverMediaFields } from '../inventory/discover';

export interface Io {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  mainJs: string;
  stdinIsTTY: boolean;
}

class Out {
  constructor(private readonly p: Parsed, private readonly io: Io) {}
  /** Final result: JSON object in --json mode, human text otherwise. */
  result(obj: Record<string, unknown>, human: string): void {
    const safe = globalRedactor.deep(obj);
    if (this.p.json) this.io.out.write(JSON.stringify({ type: 'result', ...safe }) + '\n');
    else this.io.out.write(globalRedactor.string(human).replace(/\n?$/, '\n'));
  }
  info(msg: string): void {
    if (!this.p.quiet && !this.p.json) this.io.err.write(globalRedactor.string(msg) + '\n');
  }
}

async function load(p: Parsed, io: Io, requireSecrets: boolean): Promise<LoadedConfig> {
  if (!p.config) throw validationError('CONFIG_REQUIRED', 'this command needs --config <file>');
  const set = [...p.set];
  if (p.env) set.push(`environment=${JSON.stringify(p.env)}`);
  if (p.concurrency) set.push(`processing.concurrency=${p.concurrency}`);
  if (p.batchSize) set.push(`migration.batchSize=${p.batchSize}`);
  return loadConfig({ file: p.config, env: io.env, set, requireSecrets });
}

function reporterFor(p: Parsed, io: Io) {
  if (p.json) return new JsonReporter(io.out);
  if (p.quiet) return new NullReporter();
  return new HumanReporter(io.err);
}

async function confirm(question: string, io: Io): Promise<boolean> {
  if (!io.stdinIsTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer: string = await new Promise((res) => rl.question(question, res));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

/** All mutation gates live here AND are re-checked inside the engine. `--yes` never bypasses validation or readiness. */
async function authorize(p: Parsed, l: LoadedConfig, io: Io, action: string, runtimeProbe: () => Runtime, needsReadiness: boolean): Promise<void> {
  if (p.dryRun) return;
  const c = l.config;
  if (c.environment === 'production' && !c.safety.allowProductionMutations) {
    throw safetyError('PRODUCTION_BLOCKED', `environment is "production": set safety.allowProductionMutations=true in the config (a deliberate, reviewed change) to allow "${action}"`);
  }
  if (!p.yes) {
    const ok = await confirm(`About to run "${action}" against ${c.environment} (database ${c.database.provider}, destination bucket ${c.destination.storage.bucket}). Type "yes" to continue: `, io);
    if (!ok) throw safetyError('CONFIRMATION_REQUIRED', `"${action}" mutates storage/database: re-run with --yes (non-interactive) or confirm at the prompt`);
  }
  if (c.environment === 'production' && needsReadiness) {
    const rt = runtimeProbe();
    try {
      const rep = evaluateReadiness(rt.journal, l.configFingerprint, rt.deps.paths.journalDir);
      if (!rep.ready) {
        const open = rep.gates.filter((g) => g.status !== 'PASS').map((g) => `  - ${g.title}: ${g.detail}`).join('\n');
        throw safetyError('NOT_READY', `production migration is blocked until the readiness checklist passes (see \`readiness\`):\n${open}`);
      }
    } finally {
      await rt.close();
    }
  }
}

function summarizeRun(res: { status: string; message: string; runId: string }, extra: string[] = []): string {
  return [`run ${res.runId}: ${res.status}`, res.message, ...extra].join('\n');
}

async function runEngine(p: Parsed, io: Io, out: Out, kind: RunKindForEngine, l: LoadedConfig, opts: { assetIds?: string[]; skipInventory?: boolean; runKind?: RunKindForEngine } = {}): Promise<number> {
  const shutdown = new ShutdownController();
  const uninstall = installSignalHandlers(shutdown);
  shutdown.onRequest(() => {
    const t = setTimeout(() => shutdown.abortInFlight(), l.config.migration.shutdownGraceSec * 1000);
    t.unref();
  });
  const dry = p.dryRun || kind === 'dry-run' || kind === 'inventory';
  // inventory/plan read the database and sources but never write to them: enforce that with read-only wrappers.
  const rt = buildRuntime(l, { dryRun: dry, mutationAuthorized: true, reporter: reporterFor(p, io), shutdown, json: p.json, quiet: p.quiet, verbose: p.verbose, env: io.env });
  try {
    const engine = new MigrationEngine(rt.deps);
    const res = await engine.run(p.dryRun && (kind === 'process' || kind === 'migrate') ? 'dry-run' : kind, {
      runId: p.runId, resume: p.resume, limit: p.limit, since: p.since, until: p.until, concurrency: p.concurrency, batchSize: p.batchSize,
      assetIds: opts.assetIds, skipInventory: opts.skipInventory,
    });
    out.result({ runId: res.runId, status: res.status, exitCode: res.exitCode, message: res.message, summary: res.summary }, summarizeRun(res));
    if (res.status === 'DRY_RUN_COMPLETE') {
      const samples = path.join(rt.deps.paths.reportDir, res.runId, 'samples');
      const review = await buildReviewArtifacts(samples, path.join(rt.deps.paths.reportDir, res.runId), rt.journal, res.runId).catch(() => null);
      if (review) out.info(`review artifacts: ${review.html}${review.png ? ` and ${review.png}` : ''} (${review.count} sampled asset(s))`);
    }
    return res.exitCode;
  } finally {
    uninstall();
    await rt.close();
  }
}

export async function execute(p: Parsed, io: Io): Promise<number> {
  const out = new Out(p, io);
  switch (p.command) {
    case 'help':
      io.out.write((await import('./args')).HELP);
      return ExitCode.OK;
    case 'version':
      io.out.write(`${readVersion()}\n`);
      return ExitCode.OK;

    case 'init': {
      const target = path.resolve(p.out ?? 'media-migrate.config.json');
      if (fs.existsSync(target) && !p.yes) throw safetyError('EXISTS', `${target} already exists; pass --yes to overwrite`);
      fs.writeFileSync(target, MINIMAL_CONFIG);
      out.result({ written: target }, `wrote ${target}\nReplace ACCOUNT_ID and the other placeholders, export the referenced secrets as environment variables, then run: media-migrate config validate --config ${path.basename(target)}`);
      return ExitCode.OK;
    }

    case 'config': {
      if (p.sub !== 'validate') throw validationError('BAD_ARGUMENT', 'usage: media-migrate config validate --config <file>');
      const l = await load(p, io, !p.skipSecrets);
      const desc = describeConfig(l);
      if (p.failOnWarning && l.warnings.length) throw validationError('CONFIG_WARNINGS', `configuration has ${l.warnings.length} warning(s) and --fail-on-warning is set:\n${l.warnings.map((w) => `  - ${w}`).join('\n')}`);
      out.result({ valid: true, warnings: l.warnings, config: desc }, `configuration OK (${l.config.environment})${l.migratedFrom.length ? ` — migrated from config version ${l.migratedFrom[0]}` : ''}\n${l.warnings.map((w) => `warning: ${w}`).join('\n')}${p.verbose ? '\n' + JSON.stringify(desc, null, 2) : ''}`);
      return ExitCode.OK;
    }

    case 'inventory':
    case 'dry-run': {
      const l = await load(p, io, true);
      return runEngine(p, io, out, p.command === 'inventory' ? 'inventory' : 'dry-run', l);
    }

    case 'plan': {
      const l = await load(p, io, true);
      const code = await runEngine({ ...p, quiet: true } as Parsed, io, new Out({ ...p, json: false, quiet: true } as Parsed, io), 'inventory', l);
      const rt = buildRuntime(l, { dryRun: true, mutationAuthorized: false, reporter: new NullReporter(), shutdown: new ShutdownController(), json: p.json, quiet: true, verbose: false, env: io.env });
      try {
        const j = rt.journal;
        const assets = j.listAssets();
        const byState = j.countByState();
        const refs = j.listRefs({});
        const bytes = assets.reduce((a, x) => a + (x.sourceBytes ?? 0), 0);
        const skipped: Record<string, number> = {};
        for (const a of assets) if (a.state === 'SKIPPED') skipped[a.skipReason ?? '?'] = (skipped[a.skipReason ?? '?'] ?? 0) + 1;
        const run = j.listRuns(1)[0];
        const stats = run ? j.latest(run.runId, 'inventory:stats')?.data : null;
        const plan = {
          assets: assets.length, byState, referencesToUpdate: refs.filter((r) => r.status === 'PENDING').length, sourceBytes: bytes,
          variantsPerAsset: l.config.processing.widths.length, estimatedObjectsToWrite: (byState.PLANNED ?? 0) * l.config.processing.widths.length, skipped,
          missingSources: byState.SOURCE_MISSING ?? 0, duplicateGroups: j.duplicateGroups().length, inventory: stats,
        };
        out.result({ plan, exitCode: code }, [
          `plan (read-only; nothing was written to storage or the database):`,
          `  assets: ${plan.assets}  ${JSON.stringify(byState)}`,
          `  references to update: ${plan.referencesToUpdate}   source bytes: ${fmtBytes(bytes)}`,
          `  objects to write: ~${plan.estimatedObjectsToWrite} (${plan.variantsPerAsset} variants x ${byState.PLANNED ?? 0} planned assets)`,
          `  skipped: ${JSON.stringify(skipped)}   missing sources: ${plan.missingSources}   duplicate-content groups: ${plan.duplicateGroups}`,
          `  external/unrecognised references (never rewritten): ${JSON.stringify((stats as { external?: unknown } | null)?.external ?? {})}`,
        ].join('\n'));
      } finally {
        await rt.close();
      }
      return code;
    }

    case 'process':
    case 'migrate': {
      const l = await load(p, io, true);
      const runId = p.runId ?? newRunId();
      const needsReadiness = p.command === 'migrate';
      await authorize(p, l, io, p.command, () => buildRuntime(l, { dryRun: true, mutationAuthorized: false, reporter: new NullReporter(), shutdown: new ShutdownController(), json: false, quiet: true, verbose: false, env: io.env }), needsReadiness);
      if (p.background && !p.worker) {
        const jf = journalFile(l);
        const r = await launchBackground({
          mainJs: io.mainJs, argv: io.argv, runId, journalFile: jf, logDir: path.join(path.dirname(jf), 'logs'), env: io.env,
        });
        out.result({ started: true, runId: r.runId, pid: r.pid, logFile: r.logFile, note: 'worker started; this is NOT completion' },
          `background worker started: run ${r.runId} (pid ${r.pid})\nThis only means the worker is running — it has NOT finished.\n  status: media-migrate status --config ${p.config} --run-id ${r.runId}\n  logs:   media-migrate logs --config ${p.config} --run-id ${r.runId}\n  stop:   media-migrate stop --config ${p.config} --run-id ${r.runId}`);
        return ExitCode.OK;
      }
      return runEngine({ ...p, runId }, io, out, p.command, l);
    }

    case 'resume': {
      if (!p.runId) throw validationError('BAD_ARGUMENT', 'resume requires --run-id');
      const l = await load(p, io, true);
      const rt0 = buildRuntime(l, { dryRun: true, mutationAuthorized: false, reporter: new NullReporter(), shutdown: new ShutdownController(), json: false, quiet: true, verbose: false, env: io.env });
      let kind: RunKindForEngine;
      try {
        const run = rt0.journal.getRun(p.runId);
        if (!run) throw validationError('NO_SUCH_RUN', `run ${p.runId} not found in ${journalFile(l)}`);
        if (!['inventory', 'dry-run', 'process', 'migrate'].includes(run.kind)) throw validationError('NOT_RESUMABLE', `a ${run.kind} run cannot be resumed`);
        kind = run.kind as RunKindForEngine;
      } finally {
        await rt0.close();
      }
      await authorize({ ...p, dryRun: kind === 'dry-run' || kind === 'inventory' }, l, io, `resume ${kind}`, () => buildRuntime(l, { dryRun: true, mutationAuthorized: false, reporter: new NullReporter(), shutdown: new ShutdownController(), json: false, quiet: true, verbose: false, env: io.env }), kind === 'migrate');
      if (p.background && !p.worker) {
        const jf = journalFile(l);
        const r = await launchBackground({ mainJs: io.mainJs, argv: io.argv, runId: p.runId, journalFile: jf, logDir: path.join(path.dirname(jf), 'logs'), env: io.env });
        out.result({ started: true, runId: r.runId, pid: r.pid, logFile: r.logFile }, `background worker resumed run ${r.runId} (pid ${r.pid}); NOT finished yet`);
        return ExitCode.OK;
      }
      return runEngine({ ...p, resume: true, dryRun: kind === 'dry-run' }, io, out, kind === 'dry-run' ? 'dry-run' : kind, l);
    }

    case 'status':
    case 'logs':
    case 'stop':
    case 'report':
    case 'export-mapping':
    case 'discover':
    case 'readiness':
    case 'verify':
    case 'reconcile':
    case 'rollback':
    case 'retry':
      return journalCommands(p, io, out);
  }
}

async function journalCommands(p: Parsed, io: Io, out: Out): Promise<number> {
  const l = await load(p, io, p.command === 'verify' || p.command === 'reconcile' || p.command === 'rollback' || p.command === 'retry');
  const shutdown = new ShutdownController();
  const needsWrite = (p.command === 'reconcile' && p.fix) || (p.command === 'rollback' && !p.dryRun) || p.command === 'retry';
  const rt = buildRuntime(l, { dryRun: !needsWrite, mutationAuthorized: true, reporter: new NullReporter(), shutdown, json: p.json, quiet: p.quiet, verbose: p.verbose, env: io.env });
  const j = rt.journal;
  try {
    const pickRun = () => {
      const id = p.runId ?? j.listRuns(1)[0]?.runId;
      if (!id) throw validationError('NO_RUNS', 'the journal contains no runs yet');
      const run = j.getRun(id);
      if (!run) throw validationError('NO_SUCH_RUN', `run ${id} not found`);
      return run;
    };

    switch (p.command) {
      case 'status': {
        const run = pickRun();
        const snap = computeProgress(j, run);
        const lock = j.inspectLock();
        let health = 'n/a';
        let stale = false;
        if (run.status === 'RUNNING') {
          const sameHost = lock?.host === os_hostname();
          const alive = lock && sameHost ? defaultPidAlive(lock.pid) : null;
          const hbAge = snap.heartbeatAgeSec ?? Infinity;
          stale = alive === false || hbAge > l.config.migration.lockStaleSec;
          health = stale ? `STALE — recorded as RUNNING but the worker is not alive (pid ${run.pid}); resume with: media-migrate resume --run-id ${run.runId}` : `alive (pid ${run.pid}, heartbeat ${hbAge.toFixed(0)}s ago)`;
        }
        const effective = stale ? 'INTERRUPTED (stale)' : run.status;
        const human = [
          `run ${run.runId}  kind=${run.kind}${run.dryRun ? ' (dry run)' : ''}  status=${effective}`,
          `phase: ${snap.phase}   worker: ${health}`,
          `assets: ${snap.total}${snap.totalKnown ? '' : ' (so far; inventory not complete)'}  completed ${snap.completed}  skipped ${snap.skipped}  failed ${snap.failed}  conflicts ${snap.conflicts}  queued ${snap.queued}  in-flight ${snap.running}`,
          `verified destinations: ${snap.verifiedDestinations}   db updates: ${snap.dbUpdates}   retries: ${snap.retried}   orphans: ${snap.orphans}`,
          `bytes read ${fmtBytes(snap.bytesRead)}  written ${fmtBytes(snap.bytesWritten)}  throughput ${snap.throughputBytesPerSec ? fmtBytes(snap.throughputBytesPerSec) + '/s' : 'n/a'}  elapsed ${snap.elapsedSec.toFixed(0)}s`,
          `progress: ${snap.percent === null ? 'unknown (denominator not final)' : snap.percent.toFixed(1) + '%'}   ETA: ${snap.etaSec === null ? 'n/a' : Math.round(snap.etaSec) + 's'}`,
          `last checkpoint: ${snap.lastCheckpoint ? `${snap.lastCheckpoint.name} @ ${snap.lastCheckpoint.ts}` : 'none'}`,
          `blocking error: ${snap.blockingError ?? 'none'}`,
        ].join('\n');
        out.result({ status: effective, stale, progress: snap }, human);
        return ExitCode.OK;
      }

      case 'logs': {
        const run = pickRun();
        const evs = j.events(run.runId, { limit: p.tail ?? 50, level: p.level, assetId: p.assets[0] });
        out.result({ runId: run.runId, events: evs }, evs.map((e) => `${e.ts} ${e.level.toUpperCase().padEnd(5)} ${e.type}${e.assetId ? ` [${e.assetId}]` : ''} ${Object.keys(e.detail).length ? JSON.stringify(e.detail) : ''}`).join('\n') || '(no events)');
        return ExitCode.OK;
      }

      case 'stop': {
        const run = pickRun();
        if (run.status !== 'RUNNING') {
          out.result({ runId: run.runId, status: run.status, stopped: false }, `run ${run.runId} is ${run.status}; nothing to stop`);
          return ExitCode.OK;
        }
        j.requestStop(run.runId);
        out.result({ runId: run.runId, stopRequested: true }, `stop requested for run ${run.runId}; the worker will finish its current stage, save state and exit (status -> INTERRUPTED)`);
        return ExitCode.OK;
      }

      case 'report': {
        const run = pickRun();
        const { dir, files } = writeReportFiles(j, run.runId, rt.deps.paths.reportDir);
        let review = null;
        if (run.dryRun) review = await buildReviewArtifacts(path.join(dir, 'samples'), dir, j, run.runId).catch(() => null);
        const rep = buildReport(j, run.runId);
        out.result({ runId: run.runId, dir, files, review, report: rep }, `${reportMarkdown(rep)}\nreport written to ${dir}`);
        return ExitCode.OK;
      }

      case 'discover': {
        const found = await discoverMediaFields(rt.deps.db, rt.deps.resolver, l.config.database.collections, p.limit ?? 200);
        const missing = found.filter((f) => !f.alreadyConfigured);
        out.result({ fields: found, unmapped: missing.length }, [`media-like fields found by sampling (${found.length}); NOT in the field map: ${missing.length}`, ...found.map((f) => `  ${f.alreadyConfigured ? 'mapped  ' : 'UNMAPPED'} ${f.collection}.${f.pattern}  samples=${f.samples} legacy=${f.legacyHostHits} external=${f.externalHits}  e.g. ${f.example}`)].join(String.fromCharCode(10)));
        return ExitCode.OK;
      }

      case 'export-mapping': {
        const entries = exportMapping(j);
        const file = p.out ? path.resolve(p.out) : resolvePath(l, l.config.compatibility.mappingFile);
        writeMappingFile(file, entries);
        out.result({ file, entries: entries.length }, `wrote ${entries.length} verified mapping entr${entries.length === 1 ? 'y' : 'ies'} to ${file}`);
        return ExitCode.OK;
      }

      case 'readiness': {
        if (p.sub === 'attest' || p.attest.length) {
          const cur = readAttestations(rt.deps.paths.journalDir);
          const a: Attestations = cur && cur.configFingerprint === l.configFingerprint ? cur : { configFingerprint: l.configFingerprint };
          for (const k of p.attest) {
            if (k === 'tests') { a.automatedTestsPassed = true; a.testedCommit = p.testedCommit; }
            if (k === 'rollback') a.rollbackTested = true;
            if (k === 'compat') a.compatibilityTested = true;
            if (k === 'mapping') a.mappingReviewed = true;
            if (k === 'samples') a.sampleReviewApproved = true;
            if (k === 'authorize') {
              if (!p.authorizedBy) throw validationError('BAD_ARGUMENT', '--attest authorize requires --authorized-by <name>');
              a.authorizedBy = p.authorizedBy;
              a.authorizedAt = new Date().toISOString();
            }
          }
          writeAttestations(rt.deps.paths.journalDir, a);
        }
        const rep = evaluateReadiness(j, l.configFingerprint, rt.deps.paths.journalDir);
        out.result({ ready: rep.ready, gates: rep.gates }, [`production readiness: ${rep.ready ? 'READY' : 'BLOCKED'}`, ...rep.gates.map((g) => `  [${g.status === 'PASS' ? 'PASS   ' : 'BLOCKED'}] ${g.title}  (${g.kind}) — ${g.detail}`)].join('\n'));
        return rep.ready ? ExitCode.OK : ExitCode.BLOCKED;
      }

      case 'verify': {
        const rep = await verify(rt.deps, { concurrency: p.concurrency ?? 8 });
        out.result({ ...rep }, [`verification: ${rep.ok ? 'PASS' : 'FAIL / INCOMPLETE'}`, `assets checked: ${rep.assetsChecked}   not complete: ${rep.incomplete}   canonical refs checked: ${rep.canonicalReferencesChecked}`, ...rep.violations.slice(0, 50).map((v) => `  VIOLATION ${v}`), ...rep.warnings.slice(0, 20).map((v) => `  warning ${v}`)].join('\n'));
        return rep.exitCode;
      }

      case 'reconcile': {
        const rep = await reconcile(rt.deps, { fix: p.fix, deep: p.deep });
        out.result({ ...rep }, [`reconcile${p.fix ? ' (with --fix)' : ' (read-only)'}: ${rep.ok ? 'consistent' : 'ISSUES FOUND'}`, `assets ${rep.checkedAssets}  refs ${rep.checkedRefs}  orphans ${rep.orphans}`, ...rep.issues.slice(0, 100).map((i) => `  ${i.fixed ? 'fixed  ' : 'open   '} ${i.type}: ${i.detail}`)].join('\n'));
        return rep.exitCode;
      }

      case 'rollback': {
        if (!p.dryRun) {
          if (!p.yes && !(await confirm(`Roll back migrated references in ${l.config.environment}? Type "yes": `, io))) throw safetyError('CONFIRMATION_REQUIRED', 'rollback modifies the database: re-run with --yes');
          if (l.config.environment === 'production' && !l.config.safety.allowProductionMutations) throw safetyError('PRODUCTION_BLOCKED', 'safety.allowProductionMutations is false');
        }
        const res = await rollback(rt.deps, { fromRunId: p.fromRun, assetIds: p.assets.length ? p.assets : undefined, dryRun: p.dryRun, confirmed: true, limit: p.limit });
        out.result({ ...res }, [`rollback${p.dryRun ? ' (dry run — nothing changed)' : ''}: planned ${res.planned}, ${p.dryRun ? 'would restore' : 'restored'} ${res.rolledBack}, already original ${res.alreadyOriginal}, CONFLICTS ${res.conflicts.length}`, ...res.conflicts.slice(0, 50).map((c) => `  conflict ${c.collection}/${c.docId}/${c.path}: field was edited after migration; left untouched`)].join('\n'));
        return res.exitCode;
      }

      case 'retry': {
        if (!p.yes) throw safetyError('CONFIRMATION_REQUIRED', 'retry re-runs the migration for the selected assets: re-run with --yes');
        const states = (p.states.length ? p.states : ['FAILED', 'SOURCE_MISSING', 'CONFLICT']) as Array<'FAILED' | 'SOURCE_MISSING' | 'CONFLICT'>;
        let targets = j.listAssets({ states });
        if (p.assets.length) targets = targets.filter((a) => p.assets.includes(a.assetId));
        const rid = p.runId ?? newRunId();
        const ids: string[] = [];
        j.tx(() => {
          for (const a of targets) {
            for (const r of j.listRefs({ assetId: a.assetId, statuses: ['CONFLICT'] })) j.setRefStatus(r, 'PENDING', { runId: rid });
            if (p.acceptSourceChange) {
              j.patchAsset(a.assetId, { sourceSha256: null }, null);
              for (const v of j.listVariants(a.assetId)) j.upsertVariant({ ...v, verified: false });
            }
            const target = a.state === 'SOURCE_MISSING' ? 'PLANNED' : 'PLANNED';
            j.transition(a.assetId, target, { runId: null, resetAttempts: true, detail: { reason: 'operator retry' } });
            ids.push(a.assetId);
          }
        });
        if (ids.length === 0) {
          out.result({ retried: 0 }, 'nothing to retry');
          return ExitCode.OK;
        }
        out.info(`re-armed ${ids.length} asset(s); running them now`);
        await rt.close();
        return runEngine({ ...p, runId: rid, resume: false }, io, out, 'migrate', l, { assetIds: ids, skipInventory: true });
      }
    }
    return ExitCode.OK;
  } finally {
    await rt.close().catch(() => undefined);
  }
}

function readVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

export function toErrorResult(e: unknown): { code: string; message: string; exitCode: number } {
  if (e instanceof MediaMigrateError) return { code: e.code, message: globalRedactor.string(e.message), exitCode: e.exitCode };
  return { code: 'INTERNAL', message: globalRedactor.string(errorMessage(e)), exitCode: ExitCode.OPERATIONAL };
}

void SqliteJournal;
