// One-off helper used while integrating V2 Enterprise: applies the small frontend edits while preserving the
// repository's CRLF line endings. Usage: node scripts/patch-v2-frontend.js <path-to-V2-enterprise>
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
if (!root) throw new Error('usage: node patch-v2-frontend.js <V2-enterprise root>');

function edit(rel, fn) {
  const p = path.join(root, rel);
  const raw = fs.readFileSync(p, 'utf8');
  const crlf = raw.includes('\r\n');
  const out = fn(raw.replace(/\r\n/g, '\n'));
  fs.writeFileSync(p, crlf ? out.replace(/\n/g, '\r\n') : out);
}

edit('frontend/components/ProductCard.tsx', (s) => {
  if (s.includes('getImageSrcSet(image')) return s;
  s = s.replace("import { getOptimizedImageUrl } from '../src/utils/mediaUtils';", "import { getOptimizedImageUrl, getImageSrcSet } from '../src/utils/mediaUtils';");
  s = s.replace(
    "                            src={getOptimizedImageUrl(image, { width: 400, quality: 70 })}\n",
    "                            src={getOptimizedImageUrl(image, { width: 400, quality: 70 })}\n                            srcSet={getImageSrcSet(image, [400, 800])}\n                            sizes=\"(min-width: 1024px) 25vw, 50vw\"\n",
  );
  s = s.replace(
    "                                src={getOptimizedImageUrl(hoverImage, { width: 400, quality: 70 })}\n",
    "                                src={getOptimizedImageUrl(hoverImage, { width: 400, quality: 70 })}\n                                srcSet={getImageSrcSet(hoverImage, [400, 800])}\n                                sizes=\"(min-width: 1024px) 25vw, 50vw\"\n",
  );
  return s;
});

edit('frontend/components/admin/MediaManagerModal.tsx', (s) => {
  // videos keep the raw URL; only <img> thumbnails go through the helper (admin grid must not download originals)
  s = s.replace(/(<img\s+src=)\{m\.thumbnailUrl \|\| m\.url\}/, '$1{getOptimizedImageUrl(m.thumbnailUrl || m.url, { width: 400 })}');
  if (!s.includes("from '../../src/utils/mediaUtils'")) {
    s = s.replace("import { adminAPI } from '../../lib/apiClient';\n", "import { adminAPI } from '../../lib/apiClient';\nimport { getOptimizedImageUrl } from '../../src/utils/mediaUtils';\n");
  }
  return s;
});
console.log('patched');
