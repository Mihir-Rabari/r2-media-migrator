import { parseArgs } from 'node:util';
import { validationError } from '../domain/errors';

export const COMMANDS = [
  'init', 'config', 'inventory', 'plan', 'dry-run', 'process', 'migrate', 'verify', 'reconcile', 'status', 'logs', 'retry', 'resume',
  'rollback', 'report', 'stop', 'readiness', 'export-mapping', 'help', 'version',
] as const;
export type Command = (typeof COMMANDS)[number];

export interface Parsed {
  command: Command;
  sub?: string;
  config?: string;
  env?: 'development' | 'staging' | 'production';
  dryRun: boolean;
  resume: boolean;
  runId?: string;
  concurrency?: number;
  batchSize?: number;
  limit?: number;
  since?: Date;
  until?: Date;
  json: boolean;
  verbose: boolean;
  quiet: boolean;
  yes: boolean;
  failOnWarning: boolean;
  background: boolean;
  worker: boolean;
  set: string[];
  fix: boolean;
  deep: boolean;
  fromRun?: string;
  assets: string[];
  acceptSourceChange: boolean;
  tail?: number;
  level?: 'debug' | 'info' | 'warn' | 'error';
  out?: string;
  attest: string[];
  authorizedBy?: string;
  testedCommit?: string;
  skipSecrets: boolean;
  states: string[];
  help: boolean;
  version: boolean;
}

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  env: { type: 'string' },
  'dry-run': { type: 'boolean' },
  resume: { type: 'boolean' },
  'run-id': { type: 'string' },
  concurrency: { type: 'string' },
  'batch-size': { type: 'string' },
  limit: { type: 'string' },
  since: { type: 'string' },
  until: { type: 'string' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  quiet: { type: 'boolean', short: 'q' },
  yes: { type: 'boolean', short: 'y' },
  'fail-on-warning': { type: 'boolean' },
  background: { type: 'boolean' },
  worker: { type: 'boolean' },
  set: { type: 'string', multiple: true },
  fix: { type: 'boolean' },
  deep: { type: 'boolean' },
  'from-run': { type: 'string' },
  asset: { type: 'string', multiple: true },
  'accept-source-change': { type: 'boolean' },
  tail: { type: 'string' },
  level: { type: 'string' },
  out: { type: 'string' },
  attest: { type: 'string', multiple: true },
  'authorized-by': { type: 'string' },
  'tested-commit': { type: 'string' },
  'skip-secrets': { type: 'boolean' },
  state: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const;

function int(name: string, v: string | undefined, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw validationError('BAD_ARGUMENT', `--${name} must be an integer, got "${v}"`);
  const n = Number(v);
  if (n < min || n > max) throw validationError('BAD_ARGUMENT', `--${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

function date(name: string, v: string | undefined): Date | undefined {
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(v)) throw validationError('BAD_ARGUMENT', `--${name} must be an ISO date (YYYY-MM-DD or full timestamp), got "${v}"`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw validationError('BAD_ARGUMENT', `--${name} is not a valid date: "${v}"`);
  return d;
}

/** Strict parsing: unknown flags, malformed numbers and conflicting flags all fail BEFORE anything is touched. */
export function parseCli(argv: readonly string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS as never, allowPositionals: true, strict: true });
  } catch (e) {
    throw validationError('BAD_ARGUMENT', (e as Error).message);
  }
  const v = parsed.values as Record<string, any>;
  const [cmdRaw, sub, ...rest] = parsed.positionals;
  if (rest.length) throw validationError('BAD_ARGUMENT', `unexpected extra argument(s): ${rest.join(' ')}`);
  const wantsHelp = !!v.help || (cmdRaw === undefined && !v.version);
  const wantsVersion = !!v.version;
  const command = (wantsHelp || wantsVersion ? (cmdRaw as Command | undefined) ?? 'help' : cmdRaw) as Command;
  if (!COMMANDS.includes(command)) throw validationError('UNKNOWN_COMMAND', `unknown command "${cmdRaw}" (see --help)`);
  if (sub !== undefined && !(command === 'config' || command === 'readiness')) throw validationError('BAD_ARGUMENT', `unexpected argument "${sub}" for "${command}"`);

  if (v.env !== undefined && !['development', 'staging', 'production'].includes(v.env)) throw validationError('BAD_ARGUMENT', `--env must be development, staging or production`);
  if (v.level !== undefined && !['debug', 'info', 'warn', 'error'].includes(v.level)) throw validationError('BAD_ARGUMENT', '--level must be debug, info, warn or error');
  if (v['run-id'] !== undefined && !/^[A-Za-z0-9_-]{3,64}$/.test(v['run-id'])) throw validationError('BAD_ARGUMENT', '--run-id may contain only letters, digits, "_" and "-" (3-64 chars)');
  if (v['from-run'] !== undefined && !/^[A-Za-z0-9_-]{3,64}$/.test(v['from-run'])) throw validationError('BAD_ARGUMENT', '--from-run is not a valid run id');
  if (v.quiet && v.verbose) throw validationError('BAD_ARGUMENT', '--quiet and --verbose are mutually exclusive');
  if (v.resume && !v['run-id']) throw validationError('BAD_ARGUMENT', '--resume requires --run-id');
  if (v.background && v['dry-run']) throw validationError('BAD_ARGUMENT', '--background cannot be combined with --dry-run (a dry run is short and interactive)');
  const since = date('since', v.since);
  const until = date('until', v.until);
  if (since && until && since >= until) throw validationError('BAD_ARGUMENT', '--since must be earlier than --until');
  for (const a of v.attest ?? []) {
    if (!['tests', 'rollback', 'compat', 'mapping', 'samples', 'authorize'].includes(a)) throw validationError('BAD_ARGUMENT', `unknown --attest "${a}"`);
  }

  return {
    command, sub, config: v.config, env: v.env, dryRun: !!v['dry-run'], resume: !!v.resume, runId: v['run-id'],
    concurrency: int('concurrency', v.concurrency, 1, 64), batchSize: int('batch-size', v['batch-size'], 1, 5000), limit: int('limit', v.limit, 1, 100_000_000),
    since, until, json: !!v.json, verbose: !!v.verbose, quiet: !!v.quiet, yes: !!v.yes, failOnWarning: !!v['fail-on-warning'], background: !!v.background,
    worker: !!v.worker, set: v.set ?? [], fix: !!v.fix, deep: !!v.deep, fromRun: v['from-run'], assets: v.asset ?? [], acceptSourceChange: !!v['accept-source-change'],
    tail: int('tail', v.tail, 1, 100000), level: v.level, out: v.out, attest: v.attest ?? [], authorizedBy: v['authorized-by'], testedCommit: v['tested-commit'],
    skipSecrets: !!v['skip-secrets'], states: v.state ?? [], help: wantsHelp, version: wantsVersion,
  };
}

export const HELP = `media-migrate — resumable, verifiable media optimisation and reference migration

USAGE
  media-migrate <command> [options]

COMMANDS
  init                     Write a starter configuration file (--out, refuses to overwrite without --yes)
  config validate          Validate the effective configuration (secrets are checked, never printed)
  inventory                Scan the database for media references and HEAD the sources (journal only)
  plan                     Inventory + a read-only plan summary (what would be processed / changed)
  dry-run                  Process a sample into a local review folder; performs NO production mutation
  process                  Generate + upload + verify variants; does NOT touch database references
  migrate                  process + update database references + cache stage (the full migration)
  verify                   Re-check destination objects, references and invariants against real state
  reconcile                Find incomplete updates, missing objects, orphans (--fix for safe repairs)
  status                   Show durable progress for a run (default: latest)
  logs                     Show the durable event log for a run
  retry                    Re-arm FAILED / SOURCE_MISSING / CONFLICT assets and run them again (needs --yes)
  resume                   Continue an interrupted run (--run-id)
  stop                     Ask a running worker to stop gracefully (works across processes and on Windows)
  rollback                 Restore original reference values (compare-and-set; never overwrites newer edits)
  report                   Write report.json / report.md / assets.jsonl / mapping.jsonl (+ review artifacts)
  readiness                Show the production-readiness checklist (attest with --attest ...)
  export-mapping           Write the verified legacy->canonical mapping used by the URL resolver

OPTIONS
  -c, --config <file>      Configuration file (.json/.js/.cjs/.mjs/.ts)
      --env <name>         Override environment (development|staging|production)
      --set <path=value>   Override any config value (repeatable), e.g. --set processing.quality=70
      --dry-run            Never mutate: enforced by read-only provider wrappers inside the engine
      --resume             Continue the run given by --run-id
      --run-id <id>        Run identifier (letters, digits, _ and -)
      --concurrency <n>    Parallel assets (1-64)          --batch-size <n>  Database scan batch (1-5000)
      --limit <n>          Process at most n assets (PARTIAL SCOPE; reports say so)
      --since/--until <d>  Restrict by each collection's configured timestamp field
      --background         Detach a durable worker; returns once it is running (NOT when it is done)
      --json               Machine-readable output (NDJSON events + a final result object)
  -v, --verbose / -q, --quiet
  -y, --yes                Explicit non-interactive confirmation for mutating commands
      --fail-on-warning    Treat configuration warnings as errors (exit 2)

EXIT CODES
  0 success            1 operational failure       2 validation failure (config / arguments)
  3 interrupted        4 incomplete (run finished but assets remain unfinished / conflicts)
  5 verification incomplete or failed   6 rollback failed / conflicts   7 journal locked by another run
  8 blocked by a safety gate (missing --yes, production not authorised, readiness not met)

Exit code 0 is returned ONLY when the requested work is actually complete and its postconditions passed.
`;
