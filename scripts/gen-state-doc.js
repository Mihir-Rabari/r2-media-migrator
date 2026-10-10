// Generates the transition tables in reports/media-migration/state-machine.md from the code (single source of truth).
// Usage: npm run build && node scripts/gen-state-doc.js
const fs = require('node:fs');
const path = require('node:path');
const { ASSET_TRANSITIONS, REF_TRANSITIONS } = require('../dist/domain/stateMachine');

const rows = (t) => Object.entries(t).map(([from, tos]) => `| \`${from}\` | ${tos.length ? tos.map((x) => `\`${x}\``).join(', ') : '(terminal)'} |`).join('\n');
const out = path.join(__dirname, '..', 'reports', 'media-migration', 'state-machine.md');
let doc = fs.readFileSync(out, 'utf8');
const gen = `<!-- BEGIN GENERATED -->\n### Asset transitions (generated from \`src/domain/stateMachine.ts\`)\n\n| From | Legal next states |\n|---|---|\n${rows(ASSET_TRANSITIONS)}\n\n### Reference transitions (generated)\n\n| From | Legal next states |\n|---|---|\n${rows(REF_TRANSITIONS)}\n<!-- END GENERATED -->`;
doc = doc.replace(/<!-- BEGIN GENERATED -->[\s\S]*<!-- END GENERATED -->/, gen);
fs.writeFileSync(out, doc);
console.log('state-machine.md updated');
