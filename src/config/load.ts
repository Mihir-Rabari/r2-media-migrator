import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';
import { CONFIG_VERSION, configSchema, MediaMigrateConfig, StorageConfig } from './schema';
import { validationError } from '../domain/errors';
import { fingerprint } from '../domain/ids';
import { globalRedactor } from '../security/redact';
import { validateFieldPattern } from '../database/paths';
import { parseBaseUrl } from '../security/urlPolicy';
import { supportedOutputFormats } from '../processing/imageProcessor';

// ───────── versioned config migrations ─────────

type Raw = Record<string, any>;
/** Each entry upgrades a config FROM version N TO N+1. Unknown future versions are rejected, never guessed. */
export const CONFIG_MIGRATIONS: Record<number, (raw: Raw) => Raw> = {
  // v0 (pre-release drafts): `destination.baseUrl` and `processing.format` as array ["webp"].
  0: (raw) => {
    const out = structuredClone(raw);
    if (out.destination?.baseUrl && !out.destination.publicBaseUrl) {
      out.destination.publicBaseUrl = out.destination.baseUrl;
      delete out.destination.baseUrl;
    }
    if (Array.isArray(out.processing?.formats)) {
      out.processing.format = out.processing.formats[0];
      delete out.processing.formats;
    }
    out.version = 1;
    return out;
  },
};

export function migrateConfig(raw: Raw): { config: Raw; applied: number[] } {
  let cur = raw;
  const applied: number[] = [];
  let v = typeof cur.version === 'number' ? cur.version : 0;
  if (v > CONFIG_VERSION) throw validationError('CONFIG_TOO_NEW', `config version ${v} is newer than this tool supports (${CONFIG_VERSION}); upgrade media-migrate`);
  while (v < CONFIG_VERSION) {
    const step = CONFIG_MIGRATIONS[v];
    if (!step) throw validationError('CONFIG_VERSION', `no migration path from config version ${v}`);
    cur = step(cur);
    applied.push(v);
    v = cur.version;
  }
  return { config: cur, applied };
}

// ───────── overrides ─────────

function setDeep(obj: Raw, dotted: string[], value: unknown): void {
  let cur = obj;
  dotted.forEach((k, i) => {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw validationError('BAD_OVERRIDE', `forbidden key "${k}" in override`);
    if (i === dotted.length - 1) cur[k] = value;
    else {
      if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) cur[k] = {};
      cur = cur[k];
    }
  });
}

function parseOverrideValue(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** `MEDIA_MIGRATE__processing__concurrency=8` -> processing.concurrency = 8. Plus a few friendly aliases. */
export function envOverrides(env: NodeJS.ProcessEnv): Raw {
  const out: Raw = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k.startsWith('MEDIA_MIGRATE__')) setDeep(out, k.slice('MEDIA_MIGRATE__'.length).split('__').filter(Boolean), parseOverrideValue(v));
  }
  const alias: Record<string, string[]> = {
    MEDIA_MIGRATE_ENV: ['environment'],
    MEDIA_MIGRATE_JOURNAL_DIR: ['migration', 'journalDir'],
    MEDIA_MIGRATE_REPORT_DIR: ['observability', 'reportDir'],
    MEDIA_MIGRATE_LOG_LEVEL: ['observability', 'logLevel'],
    MEDIA_MIGRATE_CONCURRENCY: ['processing', 'concurrency'],
  };
  for (const [k, p] of Object.entries(alias)) if (env[k] !== undefined) setDeep(out, p, parseOverrideValue(env[k]!));
  return out;
}

/** `--set a.b.c=value` pairs. */
export function cliOverrides(pairs: readonly string[]): Raw {
  const out: Raw = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i < 1) throw validationError('BAD_OVERRIDE', `--set expects path=value, got "${p}"`);
    setDeep(out, p.slice(0, i).split('.'), parseOverrideValue(p.slice(i + 1)));
  }
  return out;
}

function deepMerge(base: Raw, over: Raw): Raw {
  const out: Raw = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

// ───────── loading ─────────

export async function readConfigFile(file: string): Promise<Raw> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw validationError('CONFIG_NOT_FOUND', `config file not found: ${file}`);
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.json') {
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      throw validationError('CONFIG_PARSE', `config is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts'].includes(ext)) {
    // TS compiles `import()` to require() under module=commonjs; go through Function to keep a native dynamic import
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const mod = await (new Function('u', 'return import(u)') as (u: string) => Promise<{ default?: unknown }>)(pathToFileURL(abs).href);
    return structuredClone(mod.default ?? mod);
  }
  throw validationError('CONFIG_FORMAT', `unsupported config extension "${ext}" (use .json, .js, .cjs, .mjs or .ts)`);
}

export interface ResolvedSecrets {
  sourceAccessKeyId?: string;
  sourceSecretAccessKey?: string;
  destAccessKeyId?: string;
  destSecretAccessKey?: string;
  mongoUri?: string;
  cloudflareZoneId?: string;
  cloudflareToken?: string;
}

export interface LoadedConfig {
  config: MediaMigrateConfig;
  /** Absolute directory the config file lives in; relative paths resolve against it. */
  baseDir: string;
  secrets: ResolvedSecrets;
  warnings: string[];
  migratedFrom: number[];
  /** Hash of everything that influences generated output; used as `processingVersion` suffix. */
  processingFingerprint: string;
  /** Hash of the whole effective (secret-free) config. */
  configFingerprint: string;
}

export interface LoadOptions {
  file?: string;
  rawConfig?: Raw;
  env?: NodeJS.ProcessEnv;
  set?: readonly string[];
  /** Secrets are only required for commands that touch the corresponding systems. */
  requireSecrets?: boolean;
  baseDir?: string;
}

function formatZod(err: ZodError): string {
  return err.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

export async function loadConfig(opts: LoadOptions): Promise<LoadedConfig> {
  const env = opts.env ?? process.env;
  let raw: Raw;
  let baseDir = opts.baseDir ?? process.cwd();
  if (opts.rawConfig) raw = opts.rawConfig;
  else if (opts.file) {
    raw = await readConfigFile(opts.file);
    baseDir = path.dirname(path.resolve(opts.file));
  } else throw validationError('CONFIG_REQUIRED', 'no configuration given (use --config <file>)');

  const { config: migrated, applied } = migrateConfig(raw);
  const merged = deepMerge(deepMerge(migrated, envOverrides(env)), cliOverrides(opts.set ?? []));
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) throw validationError('CONFIG_INVALID', `configuration is invalid:\n${formatZod(parsed.error)}`, { issues: parsed.error.issues.length });
  const cfg = parsed.data;

  const warnings: string[] = [];
  semanticValidation(cfg, warnings);

  const secrets = resolveSecrets(cfg, env, opts.requireSecrets ?? true);
  for (const v of Object.values(secrets)) globalRedactor.addSecret(v);

  const processingFingerprint = fingerprint({
    widths: cfg.processing.widths, format: cfg.processing.format, quality: cfg.processing.quality, effort: cfg.processing.effort,
    metadata: cfg.processing.metadata, animated: cfg.processing.animated,
  });
  return {
    config: cfg, baseDir, secrets, warnings, migratedFrom: applied, processingFingerprint,
    configFingerprint: semanticFingerprint(cfg),
  };
}

/**
 * Fingerprint of everything that changes WHAT a run produces. Operational knobs (concurrency, batch size, temp dir,
 * timeouts, logging, journal location) are excluded, so a run can be resumed with different tuning but never with a
 * different field map, destination layout or transformation profile.
 */
export function semanticFingerprint(cfg: MediaMigrateConfig): string {
  const { processing: pr, migration: mg, safety, ...rest } = cfg;
  const { concurrency: _c, threadsPerJob: _t, tempDir: _d, tempBudgetBytes: _b, ...proc } = pr;
  void _c; void _t; void _d; void _b;
  return fingerprint({
    ...rest, observability: undefined, processing: proc,
    // allowProductionMutations is an AUTHORISATION switch, not a description of what a run produces: flipping it must not
    // invalidate dry-run evidence or attestations. Only the never-rewrite list changes behaviour.
    safety: { neverRewriteHosts: safety.neverRewriteHosts },
    migration: { originals: mg.originals, verification: mg.verification },
    database: { ...rest.database, writePolicy: { referenceUpdates: rest.database.writePolicy.referenceUpdates } },
  });
}

// ───────── semantic validation ─────────

export function semanticValidation(cfg: MediaMigrateConfig, warnings: string[]): void {
  const errors: string[] = [];
  const err = (m: string) => errors.push(m);

  // processing profiles
  const w = cfg.processing.widths;
  if (new Set(w).size !== w.length) err('processing.widths contains duplicates');
  if (w.some((x, i) => i > 0 && x <= w[i - 1])) err('processing.widths must be strictly ascending');
  if (!w.includes(cfg.destination.referenceVariantWidth)) err(`destination.referenceVariantWidth (${cfg.destination.referenceVariantWidth}) must be one of processing.widths`);
  if (!supportedOutputFormats().includes(cfg.processing.format)) {
    err(`processing.format "${cfg.processing.format}" is not supported by the installed sharp/libvips build (supported: ${supportedOutputFormats().join(', ')})`);
  }
  if (cfg.processing.format === 'avif') warnings.push('processing.format=avif: encoding is much slower than webp; measure latency with a representative sample first');
  if (cfg.processing.tempBudgetBytes < cfg.processing.maxSourceBytes) err('processing.tempBudgetBytes must be >= processing.maxSourceBytes (one worst-case source must fit)');
  else if (cfg.processing.tempBudgetBytes < cfg.processing.maxSourceBytes * cfg.processing.concurrency) {
    warnings.push('processing.tempBudgetBytes < maxSourceBytes x concurrency: large sources will be serialised by the byte budget (safe, but slower)');
  }

  // URLs
  try {
    const u = parseBaseUrl(cfg.destination.publicBaseUrl, { allowHttp: cfg.environment === 'development' });
    if (u.pathname !== '/' && u.pathname !== '') warnings.push(`destination.publicBaseUrl has a path (${u.pathname}); object keys are appended after it`);
  } catch (e) {
    err(`destination.publicBaseUrl: ${(e as Error).message}`);
  }

  // field maps
  const seen = new Set<string>();
  for (const c of cfg.database.collections) {
    if (seen.has(c.name)) err(`database.collections has duplicate "${c.name}"`);
    seen.add(c.name);
    for (const f of c.fields) {
      try {
        validateFieldPattern(f);
      } catch (e) {
        err(`collection "${c.name}": ${(e as Error).message}`);
      }
      if (f === '_id' || f.startsWith('_id.')) err(`collection "${c.name}": _id can never be a media field`);
    }
  }
  if (cfg.database.provider === 'mongodb' && !cfg.database.uriEnv) err('database.provider=mongodb requires database.uriEnv (the NAME of the env var holding the connection string; database.database is optional when the URI names a database)');
  if (cfg.database.provider === 'sqlite-docs' && !cfg.database.file) err('database.provider=sqlite-docs requires database.file');
  if (cfg.database.writePolicy.mode === 'transaction') warnings.push('database.writePolicy.mode=transaction requires a replica set / mongos; this is verified at run time and the run is refused otherwise');

  // namespace conflicts: destination namespace must not be inside any source scope
  const sameBucket = cfg.source.storage.bucket === cfg.destination.storage.bucket && (cfg.source.storage as any).endpoint === (cfg.destination.storage as any).endpoint;
  const nsPrefix = `${cfg.destination.namespace}/`;
  if (sameBucket) {
    for (const p of cfg.source.includePrefixes) {
      if (p.startsWith(nsPrefix) || nsPrefix.startsWith(p)) err(`source.includePrefixes entry "${p}" overlaps the destination namespace "${cfg.destination.namespace}/" in the same bucket`);
    }
    if (cfg.source.includePrefixes.length === 0) warnings.push(`source and destination share bucket "${cfg.source.storage.bucket}"; objects under "${nsPrefix}" are excluded from the source inventory automatically`);
  }
  const PUBLIC_SUFFIXES = ['r2.dev', 'amazonaws.com', 's3.amazonaws.com', 'cloudfront.net', 'github.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'azurewebsites.net', 'blob.core.windows.net', 'googleusercontent.com'];
  for (const h of cfg.source.legacyHosts) {
    if (h.startsWith('*.') && PUBLIC_SUFFIXES.includes(h.slice(2).toLowerCase())) {
      warnings.push(`source.legacyHosts "${h}" matches EVERY host under a shared public suffix (including other people's buckets): pin the exact host (e.g. pub-xxxx.r2.dev) instead`);
    }
  }
  for (const h of cfg.safety.neverRewriteHosts) if (cfg.source.legacyHosts.includes(h)) err(`host "${h}" is both a legacy host and in safety.neverRewriteHosts`);
  if (cfg.source.legacyHosts.some((h) => h === '*' || h.startsWith('*.') && h.split('.').length < 3)) err('source.legacyHosts must not contain overly broad wildcards');

  // cache
  if (cfg.cache.provider === 'cloudflare' && (!cfg.cache.zoneIdEnv || !cfg.cache.apiTokenEnv)) err('cache.provider=cloudflare requires cache.zoneIdEnv and cache.apiTokenEnv');
  if (cfg.cache.provider === 'none' && cfg.cache.purgeLegacyUrls) err('cache.purgeLegacyUrls=true requires a cache provider');

  // production hardening
  if (cfg.environment === 'production') {
    if (cfg.source.storage.provider === 'memory' || cfg.destination.storage.provider === 'memory') err('memory storage provider is not allowed in production');
    if (cfg.migration.verification.mode === 'head') warnings.push('production with migration.verification.mode=head: destination bytes are not re-hashed; use "full" unless justified');
    if (cfg.source.allowHttp) err('source.allowHttp must be false in production');
    if (cfg.processing.concurrency > 16) warnings.push('production concurrency > 16: watch R2 rate limits');
  }
  if (cfg.migration.retry.maxDelayMs < cfg.migration.retry.baseDelayMs) err('migration.retry.maxDelayMs must be >= baseDelayMs');
  if (cfg.destination.storage.provider === 's3' && !cfg.destination.storage.publicBaseUrl) { /* publicBaseUrl at destination level is authoritative */ }

  if (errors.length) throw validationError('CONFIG_INVALID', `configuration is invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`, { count: errors.length });
}

// ───────── secrets ─────────

function need(env: NodeJS.ProcessEnv, name: string | undefined, what: string, required: boolean, missing: string[]): string | undefined {
  if (!name) return undefined;
  const v = env[name];
  if (!v) {
    if (required) missing.push(`${what}: environment variable ${name} is not set`);
    return undefined;
  }
  return v;
}

export function resolveSecrets(cfg: MediaMigrateConfig, env: NodeJS.ProcessEnv, required: boolean): ResolvedSecrets {
  const missing: string[] = [];
  const s: ResolvedSecrets = {};
  const src = cfg.source.storage as Extract<StorageConfig, { provider: 's3' }>;
  const dst = cfg.destination.storage as Extract<StorageConfig, { provider: 's3' }>;
  if (src.provider === 's3') {
    s.sourceAccessKeyId = need(env, src.accessKeyIdEnv, 'source storage access key', required, missing);
    s.sourceSecretAccessKey = need(env, src.secretAccessKeyEnv, 'source storage secret', required, missing);
    if (!!src.accessKeyIdEnv !== !!src.secretAccessKeyEnv) missing.push('source storage: accessKeyIdEnv and secretAccessKeyEnv must be given together');
  }
  if (dst.provider === 's3') {
    s.destAccessKeyId = need(env, dst.accessKeyIdEnv, 'destination storage access key', required, missing);
    s.destSecretAccessKey = need(env, dst.secretAccessKeyEnv, 'destination storage secret', required, missing);
    if (!!dst.accessKeyIdEnv !== !!dst.secretAccessKeyEnv) missing.push('destination storage: accessKeyIdEnv and secretAccessKeyEnv must be given together');
  }
  if (cfg.database.provider === 'mongodb') s.mongoUri = need(env, cfg.database.uriEnv, 'MongoDB URI', required, missing);
  if (cfg.cache.provider === 'cloudflare') {
    s.cloudflareZoneId = need(env, cfg.cache.zoneIdEnv, 'Cloudflare zone id', required, missing);
    s.cloudflareToken = need(env, cfg.cache.apiTokenEnv, 'Cloudflare API token', required, missing);
  }
  if (missing.length) throw validationError('MISSING_SECRETS', `missing required secrets:\n${missing.map((m) => `  - ${m}`).join('\n')}`);
  return s;
}

/** Secret-free, human-readable description of the effective config (env var NAMES are shown, values never). */
export function describeConfig(l: LoadedConfig): Record<string, unknown> {
  const c = structuredClone(l.config) as Record<string, any>;
  return globalRedactor.deep({
    ...c,
    _meta: {
      baseDir: l.baseDir, migratedFromVersions: l.migratedFrom, processingFingerprint: l.processingFingerprint, configFingerprint: l.configFingerprint,
      secretsPresent: Object.fromEntries(Object.entries(l.secrets).map(([k, v]) => [k, v ? 'set' : 'unset'])),
    },
  });
}

/** Resolve a config-relative path. */
export const resolvePath = (l: Pick<LoadedConfig, 'baseDir'>, p: string): string => path.resolve(l.baseDir, p);
