// Repository hygiene checks used by `npm run lint` (no eslint dependency is installed; see known-limitations.md).
//  - the engine / domain / core layers must not import adapters, frameworks or SDKs (architecture boundary)
//  - no shell execution APIs outside tests
//  - no console.log of anything in src (output goes through Out/Logger so it can be redacted)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'src');
const problems = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));

const FORBIDDEN_FOR_CORE = /from ['"](mongodb|mongoose|express|sharp|@aws-sdk\/[^'"]+|undici)['"]/;
const CORE_DIRS = ['domain', 'core', 'migration', 'inventory'];

for (const file of walk(root)) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8');
  const top = rel.split('/')[0];
  if (CORE_DIRS.includes(top) && FORBIDDEN_FOR_CORE.test(src)) problems.push(`${rel}: core layer imports an adapter/framework/SDK directly`);
  if (top !== 'testing' && /\bchild_process\b/.test(src) && !['processing/video.ts', 'cli/background.ts'].includes(rel)) problems.push(`${rel}: child_process outside the allow-listed modules`);
  if (/\bexecSync\b|(^|[^.\w])exec\(|shell:\s*true/.test(src)) problems.push(`${rel}: shell execution API`);
  if (/\bconsole\.(log|info|debug)\(/.test(src)) problems.push(`${rel}: console.* in src (use Out/Logger so output is redacted)`);
  if (/eval\(|new Function\(/.test(src) && rel !== 'config/load.ts') problems.push(`${rel}: dynamic code evaluation`);
}
if (problems.length) {
  console.error(problems.map((p) => `lint: ${p}`).join('\n'));
  process.exit(1);
}
console.log(`repo checks passed (${walk(root).length} source files)`);
