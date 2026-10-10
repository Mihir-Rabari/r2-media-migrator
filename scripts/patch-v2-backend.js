// One-off helper used while integrating V2 Enterprise (preserves CRLF). Usage: node scripts/patch-v2-backend.js <V2 root>
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
if (!root) throw new Error('usage: node patch-v2-backend.js <V2-enterprise root>');

function edit(rel, fn) {
  const p = path.join(root, rel);
  const raw = fs.readFileSync(p, 'utf8');
  const crlf = raw.includes('\r\n');
  const out = fn(raw.replace(/\r\n/g, '\n'));
  fs.writeFileSync(p, crlf ? out.replace(/\n/g, '\r\n') : out);
}

edit('backend/src/config/env.ts', (s) => {
  if (s.includes('MEDIA_MAPPING_FILE')) return s;
  return s.replace(
    '    R2_PUBLIC_URL: z.string().optional(),\n',
    "    R2_PUBLIC_URL: z.string().optional(),\n    // Verified legacy->canonical media mapping exported by `media-migrate export-mapping` (JSONL). Optional.\n    MEDIA_MAPPING_FILE: z.string().optional(),\n",
  );
});

edit('backend/src/utils/r2.ts', (s) => {
  if (s.includes('thumbnailUrlFor')) return s;
  s = s.replace("import { env } from '../config/env';\n", "import { env } from '../config/env';\nimport { thumbnailUrlFor } from './mediaMapping';\n");
  s = s.replace(
    "        thumbnailUrl: `${env.R2_PUBLIC_URL}/${item.Key}`, // R2 doesn't do transformations natively",
    "        // Small verified WebP variant when the migration tool has produced one; otherwise the original (unchanged behaviour)\n        thumbnailUrl: (item.Key && thumbnailUrlFor(item.Key, env.R2_PUBLIC_URL as string, env.MEDIA_MAPPING_FILE)) || `${env.R2_PUBLIC_URL}/${item.Key}`,",
  );
  return s;
});
console.log('patched');
