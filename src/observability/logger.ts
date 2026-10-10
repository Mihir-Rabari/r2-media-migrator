import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EventRecord, RunStatus } from '../domain/types';
import type { MigrationJournal, ProgressEvent, ProgressReporter } from '../core/interfaces';
import { globalRedactor } from '../security/redact';

type Level = EventRecord['level'];
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  runId?: string | null;
  assetId?: string | null;
}

/**
 * Structured logger. The journal `events` table is the durable record (survives terminal closure);
 * an optional NDJSON file and an optional human stderr stream are additional sinks. Everything is redacted.
 */
export class Logger {
  private fileFd: number | null = null;
  constructor(
    private readonly opts: { level: Level; journal?: MigrationJournal; file?: string; stderr?: boolean; quiet?: boolean; verbose?: boolean },
  ) {
    if (opts.file) {
      fs.mkdirSync(path.dirname(opts.file), { recursive: true });
      this.fileFd = fs.openSync(opts.file, 'a');
    }
  }

  private enabled(l: Level): boolean {
    return ORDER[l] >= ORDER[this.opts.level];
  }

  log(level: Level, type: string, detail: Record<string, unknown> = {}, ctx: LogContext = {}): void {
    // The durable journal always keeps everything >= info (audit trail); the level only filters file/stderr sinks.
    const toJournal = ORDER[level] >= ORDER.info || this.enabled(level);
    if (!this.enabled(level) && !(toJournal && this.opts.journal)) return;
    const safe = globalRedactor.deep(detail);
    const ts = new Date().toISOString();
    if (toJournal && this.opts.journal && ctx.runId !== undefined) {
      try {
        this.opts.journal.appendEvent({ runId: ctx.runId ?? null, assetId: ctx.assetId ?? null, level, type, detail: safe, ts });
      } catch {
        /* the journal being unavailable must not mask the original problem */
      }
    }
    if (!this.enabled(level)) return;
    const line = JSON.stringify({ ts, level, type, runId: ctx.runId ?? null, assetId: ctx.assetId ?? null, ...safe });
    if (this.fileFd !== null) fs.writeSync(this.fileFd, line + '\n');
    if (this.opts.stderr && !this.opts.quiet && (ORDER[level] >= ORDER.warn || this.opts.verbose)) {
      process.stderr.write(`${ts} ${level.toUpperCase().padEnd(5)} ${type} ${Object.keys(safe).length ? JSON.stringify(safe) : ''}\n`);
    }
  }
  debug(type: string, detail?: Record<string, unknown>, ctx?: LogContext) { this.log('debug', type, detail, ctx); }
  info(type: string, detail?: Record<string, unknown>, ctx?: LogContext) { this.log('info', type, detail, ctx); }
  warn(type: string, detail?: Record<string, unknown>, ctx?: LogContext) { this.log('warn', type, detail, ctx); }
  error(type: string, detail?: Record<string, unknown>, ctx?: LogContext) { this.log('error', type, detail, ctx); }

  close(): void {
    if (this.fileFd !== null) {
      try { fs.closeSync(this.fileFd); } catch { /* closed */ }
      this.fileFd = null;
    }
  }
}

export const silentLogger = (): Logger => new Logger({ level: 'error', stderr: false });

// ───────── progress reporters ─────────

export class NullReporter implements ProgressReporter {
  emit(): void { /* nothing */ }
}

export class CollectingReporter implements ProgressReporter {
  readonly events: ProgressEvent[] = [];
  emit(e: ProgressEvent): void { this.events.push(e); }
}

/** One JSON object per line on stdout (machine-readable). */
export class JsonReporter implements ProgressReporter {
  constructor(private readonly out: NodeJS.WritableStream = process.stdout) {}
  emit(e: ProgressEvent): void {
    this.out.write(JSON.stringify(globalRedactor.deep(e)) + '\n');
  }
}

/** Human-readable throttled progress lines on stderr (stdout stays clean for data). */
export class HumanReporter implements ProgressReporter {
  private last = 0;
  constructor(private readonly out: NodeJS.WritableStream = process.stderr, private readonly minIntervalMs = 1000) {}
  emit(e: ProgressEvent): void {
    const now = Date.now();
    if (e.type === 'progress' && now - this.last < this.minIntervalMs) return;
    this.last = now;
    if (e.type === 'progress') {
      const p = e as Record<string, any>;
      const pct = p.percent === null || p.percent === undefined ? '' : ` ${p.percent.toFixed(1)}%`;
      this.out.write(`[${p.phase}] ${p.completed}/${p.total} done${pct} | failed ${p.failed} | conflicts ${p.conflicts} | ${fmtBytes(p.bytesRead)} read, ${fmtBytes(p.bytesWritten)} written${p.etaSec != null ? ` | ETA ${Math.round(p.etaSec)}s` : ''}\n`);
    } else if (e.type === 'run.finished') {
      this.out.write(`run ${e.runId} finished: ${(e as any).status}\n`);
    } else {
      this.out.write(`${e.type} ${e.runId}\n`);
    }
  }
}

export const fmtBytes = (n: number): string => {
  if (!Number.isFinite(n)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

export type { RunStatus };
