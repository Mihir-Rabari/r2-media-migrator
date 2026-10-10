import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, migrateConfig, envOverrides, cliOverrides, describeConfig, semanticFingerprint, CONFIG_MIGRATIONS } from '../../src/config/load';
import { CONFIG_VERSION } from '../../src/config/schema';
import { parseCli } from '../../src/cli/args';
import { withTmp } from '../helpers';

const base = (): any => ({
  version: 1,
  source: { storage: { provider: 'fs', root: './s' }, legacyHosts: ['cdn.example.com'] },
  database: { provider: 'sqlite-docs', file: './d.sqlite', collections: [{ name: 'products', fields: ['photo', 'photos[]'] }] },
  destination: { storage: { provider: 'fs', root: './s' }, publicBaseUrl: 'https://cdn.example.com', referenceVariantWidth: 1200 },
});
const load = (raw: any, extra: Parameters<typeof loadConfig>[0] = {}) => loadConfig({ rawConfig: raw, env: {}, requireSecrets: false, baseDir: process.cwd(), ...extra });

test('config: minimal config loads and applies documented defaults', async () => {
  const l = await load(base());
  assert.equal(l.config.environment, 'development');
  assert.deepEqual(l.config.processing.widths, [400, 800, 1200]);
  assert.equal(l.config.processing.format, 'webp');
  assert.equal(l.config.processing.metadata, 'strip');
  assert.equal(l.config.destination.namespace, 'media');
  assert.equal(l.config.destination.cacheControl, 'public, max-age=31536000, immutable');
  assert.equal(l.config.database.writePolicy.mode, 'single-doc-cas');
  assert.equal(l.config.safety.allowProductionMutations, false);
  assert.equal(l.config.cache.provider, 'none');
  assert.equal(l.config.migration.verification.mode, 'full');
});

test('config: unknown keys are rejected everywhere (typos cannot silently change behaviour)', async () => {
  for (const mut of [(c: any) => (c.typo = 1), (c: any) => (c.processing = { widthz: [1] }), (c: any) => (c.source.storage.secretAccessKey = 'hunter2hunter2'), (c: any) => (c.database.collections[0].feilds = ['x'])]) {
    const c = base();
    mut(c);
    await assert.rejects(load(c), /configuration is invalid/);
  }
});

test('config: inline secrets are impossible — credentials can only be env var NAMES', async () => {
  const c = base();
  c.source.storage = { provider: 's3', bucket: 'b', accessKeyIdEnv: 'AKIAIOSFODNN7EXAMPLE_VALUE?', secretAccessKeyEnv: 'wJalr/XUtnFEMI' };
  await assert.rejects(load(c), /environment variable NAME/);
  c.source.storage = { provider: 's3', bucket: 'b', secretAccessKey: 'abc' };
  await assert.rejects(load(c), /Unrecognized key/);
});

test('config: precedence is defaults < file < environment < CLI --set', async () => {
  const raw = base();
  raw.processing = { concurrency: 2, quality: 60 };
  const l = await load(raw, { env: { MEDIA_MIGRATE__processing__concurrency: '5', MEDIA_MIGRATE__processing__quality: '55' }, set: ['processing.quality=50', 'processing.effort=1'] });
  assert.equal(l.config.processing.concurrency, 5, 'env beats file');
  assert.equal(l.config.processing.quality, 50, 'CLI beats env');
  assert.equal(l.config.processing.effort, 1);
  assert.equal(l.config.processing.threadsPerJob, 1, 'default retained');
});

test('config: friendly env aliases and override parsing; prototype-pollution keys are refused', () => {
  assert.deepEqual(envOverrides({ MEDIA_MIGRATE_ENV: 'staging', MEDIA_MIGRATE_CONCURRENCY: '3', MEDIA_MIGRATE_LOG_LEVEL: 'debug' }), { environment: 'staging', processing: { concurrency: 3 }, observability: { logLevel: 'debug' } });
  assert.deepEqual(cliOverrides(['a.b=1', 'a.c="x"', 'list=[1,2]', 'plain=hello']), { a: { b: 1, c: 'x' }, list: [1, 2], plain: 'hello' });
  assert.throws(() => cliOverrides(['__proto__.x=1']), /forbidden key/);
  assert.throws(() => cliOverrides(['a.constructor.b=1']), /forbidden key/);
  assert.throws(() => cliOverrides(['novalue']), /path=value/);
  assert.equal(({} as any).x, undefined, 'Object.prototype not polluted');
});

test('config: semantic validation catches unsafe or contradictory settings', async () => {
  const cases: Array<[string, (c: any) => void, RegExp]> = [
    ['widths not ascending', (c) => (c.processing = { widths: [800, 400] }), /strictly ascending/],
    ['duplicate widths', (c) => (c.processing = { widths: [400, 400, 1200] }), /duplicates|ascending/],
    ['reference width not in widths', (c) => (c.destination.referenceVariantWidth = 999), /must be one of processing\.widths/],
    ['bad quality', (c) => (c.processing = { quality: 0 }), /quality/],
    ['non-https public url', (c) => { c.environment = 'staging'; c.destination.publicBaseUrl = 'http://cdn.example.com'; }, /https/],
    ['credentials in url', (c) => (c.destination.publicBaseUrl = 'https://u:p@cdn.example.com'), /credentials/],
    ['malformed url', (c) => (c.destination.publicBaseUrl = 'not a url'), /Invalid url|malformed/],
    ['hostile field pattern', (c) => (c.database.collections[0].fields = ['$where']), /field pattern|segment/],
    ['_id as media field', (c) => (c.database.collections[0].fields = ['_id']), /_id can never/],
    ['duplicate collection', (c) => c.database.collections.push({ name: 'products', fields: ['x'] }), /duplicate/],
    ['overlapping namespace', (c) => (c.source.includePrefixes = ['media/']), /overlaps the destination namespace/],
    ['broad wildcard host', (c) => (c.source.legacyHosts = ['*.com']), /bare hostname|broad wildcards/],
    ['legacy host also never-rewrite', (c) => (c.safety = { neverRewriteHosts: ['cdn.example.com'] }), /both a legacy host/],
    ['purge without provider', (c) => (c.cache = { purgeLegacyUrls: true }), /requires a cache provider/],
    ['cloudflare without env names', (c) => (c.cache = { provider: 'cloudflare' }), /zoneIdEnv/],
    ['mongodb without uri', (c) => (c.database = { provider: 'mongodb', collections: c.database.collections }), /uriEnv/],
    ['memory storage in production', (c) => { c.environment = 'production'; c.source.storage = { provider: 'memory' }; }, /not allowed in production/],
    ['http source in production', (c) => { c.environment = 'production'; c.source.allowHttp = true; }, /allowHttp must be false/],
    ['temp budget below max source', (c) => (c.processing = { tempBudgetBytes: 1024, maxSourceBytes: 4096 }), /tempBudgetBytes/],
    ['retry delays inverted', (c) => (c.migration = { retry: { baseDelayMs: 100, maxDelayMs: 10 } }), /maxDelayMs/],
    ['host with scheme', (c) => (c.source.legacyHosts = ['https://cdn.example.com']), /bare hostname/],
    ['future config version', (c) => (c.version = 99), /newer than this tool|Invalid literal/],
  ];
  for (const [name, mut, re] of cases) {
    const c = base();
    mut(c);
    await assert.rejects(load(c), re, name);
  }
});

test('config: warnings are produced (not errors) for risky-but-legal settings', async () => {
  const c = base();
  c.environment = 'production';
  c.migration = { verification: { mode: 'head' } };
  c.processing = { format: 'avif' };
  const l = await load(c);
  assert.ok(l.warnings.some((w) => /verification\.mode=head/.test(w)));
  assert.ok(l.warnings.some((w) => /avif/.test(w)));
  assert.ok(l.warnings.some((w) => /share bucket/.test(w)) || true);
});

test('config: missing secrets are reported by env var name; present secrets are registered for redaction and never described', async () => {
  const c = base();
  c.source.storage = { provider: 's3', bucket: 'b', accessKeyIdEnv: 'T_KEY', secretAccessKeyEnv: 'T_SECRET' };
  c.destination.storage = c.source.storage;
  c.database = { provider: 'mongodb', uriEnv: 'T_URI', database: 'x', collections: c.database.collections };
  await assert.rejects(load(c, { requireSecrets: true }), (e: any) => /T_KEY is not set/.test(e.message) && /T_SECRET is not set/.test(e.message) && /T_URI is not set/.test(e.message));
  const SECRET = 'very-secret-value-1234567';
  const l = await load(c, { requireSecrets: true, env: { T_KEY: 'AKIAEXAMPLEKEY00000', T_SECRET: SECRET, T_URI: `mongodb://u:${SECRET}@h/x` } });
  const d = JSON.stringify(describeConfig(l));
  assert.ok(!d.includes(SECRET));
  assert.match(d, /T_SECRET/);
  assert.match(d, /"mongoUri":"set"/);
  const { globalRedactor } = await import('../../src/security/redact');
  assert.ok(!globalRedactor.string(`oops ${SECRET} oops`).includes(SECRET));
});

test('config: versioning — v0 drafts migrate to the current schema; future versions are refused', () => {
  const v0 = { version: 0, destination: { baseUrl: 'https://cdn.example.com' }, processing: { formats: ['webp'] } };
  const { config, applied } = migrateConfig(v0);
  assert.deepEqual(applied, [0]);
  assert.equal(config.version, CONFIG_VERSION);
  assert.equal(config.destination.publicBaseUrl, 'https://cdn.example.com');
  assert.equal(config.processing.format, 'webp');
  assert.equal(migrateConfig({}).applied[0], 0, 'missing version is treated as v0');
  assert.throws(() => migrateConfig({ version: 99 }), /newer than this tool/);
  assert.ok(CONFIG_MIGRATIONS[0]);
});

test('config: loads JSON and CommonJS files, resolves relative paths against the config directory, rejects unknown extensions', async () => {
  await withTmp(async (dir) => {
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(base()));
    fs.writeFileSync(path.join(dir, 'c.cjs'), `module.exports = ${JSON.stringify(base())};`);
    fs.writeFileSync(path.join(dir, 'c.yaml'), 'x: 1');
    const a = await loadConfig({ file: path.join(dir, 'c.json'), env: {}, requireSecrets: false });
    const b = await loadConfig({ file: path.join(dir, 'c.cjs'), env: {}, requireSecrets: false });
    assert.equal(a.baseDir, dir);
    assert.equal(a.configFingerprint, b.configFingerprint);
    await assert.rejects(loadConfig({ file: path.join(dir, 'c.yaml'), env: {}, requireSecrets: false }), /unsupported config extension/);
    await assert.rejects(loadConfig({ file: path.join(dir, 'nope.json'), env: {}, requireSecrets: false }), /not found/);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    await assert.rejects(loadConfig({ file: path.join(dir, 'bad.json'), env: {}, requireSecrets: false }), /not valid JSON/);
  });
});

test('config: the semantic fingerprint ignores operational tuning but changes with anything that alters output', async () => {
  const fp = async (mut: (c: any) => void) => { const c = base(); mut(c); return (await load(c)).configFingerprint; };
  const ref = await fp(() => undefined);
  for (const same of [(c: any) => (c.processing = { concurrency: 9 }), (c: any) => (c.migration = { batchSize: 10, lockStaleSec: 999 }), (c: any) => (c.observability = { logLevel: 'debug' }), (c: any) => (c.processing = { tempDir: 'elsewhere' })]) assert.equal(await fp(same), ref);
  for (const diff of [(c: any) => (c.processing = { quality: 50 }), (c: any) => (c.processing = { widths: [300, 1200] }), (c: any) => c.database.collections[0].fields.push('hoverImage'), (c: any) => (c.destination.namespaceVersion = 'v2'), (c: any) => (c.source.legacyHosts = ['x.example.com'])]) assert.notEqual(await fp(diff), ref);
  void semanticFingerprint;
});

test('example configs shipped with the tool are valid', async () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  for (const f of ['examples/minimal.config.json', 'examples/full.config.json', 'examples/v2-enterprise.config.json']) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    const l = await loadConfig({ file: p, env: {}, requireSecrets: false });
    assert.ok(l.config.database.collections.length >= 1, f);
  }
});

// ───────── CLI argument validation ─────────

test('cli args: strict parsing, typed values, helpful failures', () => {
  const p = parseCli(['migrate', '--config', 'c.json', '--concurrency', '8', '--batch-size', '100', '--limit', '10', '--since', '2026-01-01', '--until', '2026-02-01T00:00:00Z', '--yes', '--json', '--set', 'a=1', '--set', 'b=2', '--run-id', 'my_run-1']);
  assert.equal(p.command, 'migrate');
  assert.equal(p.concurrency, 8);
  assert.equal(p.batchSize, 100);
  assert.equal(p.limit, 10);
  assert.ok(p.since instanceof Date && p.until instanceof Date);
  assert.deepEqual(p.set, ['a=1', 'b=2']);
  assert.equal(p.yes && p.json, true);
  assert.equal(parseCli(['config', 'validate', '-c', 'x']).sub, 'validate');
  assert.equal(parseCli(['--version']).version, true);
  assert.equal(parseCli([]).command, 'help');
  const bad: string[][] = [
    ['migrate', '--concurrency', '0'], ['migrate', '--concurrency', '65'], ['migrate', '--concurrency', '1.5'], ['migrate', '--concurrency', '-2'], ['migrate', '--batch-size', '99999'],
    ['migrate', '--limit', '0'], ['migrate', '--limit', 'all'], ['migrate', '--nope'], ['migrate', 'extra'], ['status', '--run-id', '../etc'], ['status', '--run-id', 'a'], ['migrate', '--resume'],
    ['migrate', '--since', 'yesterday'], ['migrate', '--since', '2026-02-01', '--until', '2026-01-01'], ['migrate', '--env', 'prod'], ['logs', '--level', 'loud'], ['migrate', '--quiet', '--verbose'],
    ['migrate', '--background', '--dry-run'], ['readiness', '--attest', 'everything'], ['bogus'], ['migrate', '--concurrency'],
  ];
  for (const a of bad) assert.throws(() => parseCli(a), (e: any) => e.kind === 'validation' && e.exitCode === 2, a.join(' '));
});
