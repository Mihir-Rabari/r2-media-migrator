// Generates the key/type/default table in reports/media-migration/configuration-reference.md from the zod schema,
// so the documentation cannot drift from the code. Usage: npm run build && node scripts/gen-config-doc.js
const fs = require('node:fs');
const path = require('node:path');
const { configSchema } = require('../dist/config/schema');

const NOTES = {
  'version': 'Config schema version (currently 1). Older versions are migrated automatically; newer ones are refused.',
  'environment': '`production` enables extra gates: `safety.allowProductionMutations`, `--yes` and the readiness checklist.',
  'source.legacyHosts': 'Only URLs on these hosts are ever mapped to a bucket key. `*.suffix` wildcards allowed (pin exact hosts for shared suffixes like r2.dev).',
  'source.includePrefixes': 'If non-empty, only keys under these prefixes are in scope.',
  'source.excludePrefixes': 'Keys under these prefixes are never touched. The destination namespace is always excluded.',
  'database.collections': 'THE approved field map. Only these paths are read as references and written. `a[]` iterates arrays: `photos[]`, `home.cats[].image`.',
  'database.writePolicy.mode': '`single-doc-cas` (default) or `transaction` (needs replica set / mongos, verified at run time).',
  'database.writePolicy.referenceUpdates': '`disabled` allows `process` only; `migrate` refuses.',
  'destination.referenceVariantWidth': 'Width whose URL is written into database fields. Must be one of `processing.widths`.',
  'destination.namespaceVersion': 'Bump when processing settings change: variants are immutable and are never overwritten.',
  'processing.widths': 'Maximum widths (never upscaled). Strictly ascending.',
  'processing.format': '`avif` only if the installed sharp build supports it (checked at validation).',
  'processing.animated': '`skip` leaves animated images alone (SKIPPED); `preserve` re-encodes animations.',
  'processing.strictDecode': 'Fail on decoder warnings (catches truncated JPEGs).',
  'processing.tempBudgetBytes': 'Byte-weighted semaphore bounding concurrent temp files. Must be >= `maxSourceBytes`.',
  'migration.verification.mode': '`full` re-reads and re-hashes every destination object; `head` trusts size + stored sha256 metadata.',
  'migration.failureThreshold': 'Abort scheduling when failures exceed `maxFailed` or `maxFailedRatio` (after 20 attempts).',
  'migration.retry.maxItemAttempts': 'Total passes (including crash recoveries) an item may consume before terminal FAILED.',
  'cache.provider': '`none` or `cloudflare` (per-URL purge only).',
  'cache.purgeLegacyUrls': 'Purge the OLD per-URL entries after references are rewritten. Never zone-wide.',
  'safety.allowProductionMutations': 'Must be true for any non-dry-run mutation when `environment=production`.',
  'safety.neverRewriteHosts': 'Defence in depth: hosts that are never treated as legacy even if matched.',
  'compatibility.routePrefixes': 'Path prefixes owned by the legacy-URL HTTP handler (only matters for requests that reach your app).',
};

function unwrap(s) {
  let d = s, def, optional = false;
  for (;;) {
    const t = d._def.typeName;
    if (t === 'ZodDefault') { def = d._def.defaultValue(); d = d._def.innerType; }
    else if (t === 'ZodOptional') { optional = true; d = d._def.innerType; }
    else if (t === 'ZodEffects') d = d._def.schema;
    else break;
  }
  return { schema: d, def, optional };
}

function typeOf(s) {
  const t = s._def.typeName;
  switch (t) {
    case 'ZodString': return 'string';
    case 'ZodNumber': return 'number';
    case 'ZodBoolean': return 'boolean';
    case 'ZodLiteral': return JSON.stringify(s._def.value);
    case 'ZodEnum': return s._def.values.map((v) => `"${v}"`).join(' \\| ');
    case 'ZodArray': return `${typeOf(unwrap(s._def.type).schema)}[]`;
    case 'ZodUnion': return s._def.options.map((o) => typeOf(unwrap(o).schema)).join(' \\| ');
    case 'ZodDiscriminatedUnion': return 'object (by `provider`)';
    case 'ZodObject': return 'object';
    default: return t.replace('Zod', '').toLowerCase();
  }
}

const rows = [];
function walk(schema, prefix) {
  const { schema: s, def, optional } = unwrap(schema);
  if (s._def.typeName === 'ZodObject') {
    if (prefix) rows.push([prefix, 'object', '', '']);
    for (const [k, v] of Object.entries(s.shape)) walk(v, prefix ? `${prefix}.${k}` : k);
    return;
  }
  if (s._def.typeName === 'ZodDiscriminatedUnion') {
    rows.push([prefix, 'object (provider: s3 \\| fs \\| memory)', '', 'see Storage providers below']);
    return;
  }
  let d = def === undefined ? (optional ? '(optional)' : '**required**') : '`' + JSON.stringify(def).replace(/\|/g, '\\|') + '`';
  rows.push([prefix, typeOf(s), d, NOTES[prefix] ?? '']);
}
walk(configSchema, '');

const table = '| Key | Type | Default | Notes |\n|---|---|---|---|\n' + rows.map((r) => `| \`${r[0]}\` | ${r[1]} | ${r[2]} | ${r[3]} |`).join('\n');
const out = path.join(__dirname, '..', 'reports', 'media-migration', 'configuration-reference.md');
let doc = fs.readFileSync(out, 'utf8');
doc = doc.replace(/<!-- BEGIN GENERATED -->[\s\S]*<!-- END GENERATED -->/, `<!-- BEGIN GENERATED -->\n${table}\n<!-- END GENERATED -->`);
fs.writeFileSync(out, doc);
console.log(`configuration-reference.md updated (${rows.length} keys)`);
