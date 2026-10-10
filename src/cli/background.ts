import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { SqliteJournal } from '../journal/sqliteJournal';
import { MediaMigrateError } from '../domain/errors';

export interface BackgroundResult {
  runId: string;
  pid: number;
  logFile: string;
}

/**
 * Launch a detached worker (same CLI, `--worker`) that outlives this terminal.
 * State lives in the journal; stdout/stderr go to a log file. We return as soon as the worker has registered
 * itself as RUNNING in the journal — that means "started", never "done".
 */
export async function launchBackground(opts: {
  mainJs: string;
  argv: readonly string[];
  runId: string;
  journalFile: string;
  logDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<BackgroundResult> {
  fs.mkdirSync(opts.logDir, { recursive: true });
  const logFile = path.join(opts.logDir, `${opts.runId}.worker.log`);
  const fd = fs.openSync(logFile, 'a');
  const args = opts.argv.filter((a) => a !== '--background');
  if (!args.includes('--worker')) args.push('--worker');
  if (!args.includes('--yes') && !args.includes('-y')) args.push('--yes');
  if (!args.includes('--run-id')) args.push('--run-id', opts.runId);
  const child = spawn(process.execPath, [opts.mainJs, ...args], {
    detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: opts.env,
  });
  let exited: number | null = null;
  child.on('exit', (code) => { exited = code ?? -1; });
  child.on('error', () => { exited = -1; });
  child.unref();
  fs.closeSync(fd);

  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (fs.existsSync(opts.journalFile)) {
      const j = new SqliteJournal(opts.journalFile);
      try {
        const run = j.getRun(opts.runId);
        if (run && (run.status === 'RUNNING' || run.finishedAt)) return { runId: opts.runId, pid: run.pid ?? child.pid ?? 0, logFile };
      } finally {
        j.close();
      }
    }
    if (exited !== null) {
      const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-8).join('\n') : '';
      throw new MediaMigrateError('permanent', 'WORKER_EXITED', `background worker exited (code ${exited}) before registering the run:\n${tail}`);
    }
  }
  throw new MediaMigrateError('transient', 'WORKER_TIMEOUT', `background worker did not register run ${opts.runId} within the timeout; see ${logFile}`);
}
