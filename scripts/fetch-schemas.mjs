// Re-downloads the two bundled JSON Schemas from their pinned URLs and prints SHA-256 checksums.
// Update src/schemas/SOURCES.md (and the pinned commit below) after reviewing the diff.
//   node scripts/fetch-schemas.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'schemas');
const SOURCES = {
  'a2a-v0.3.json': 'https://raw.githubusercontent.com/a2aproject/A2A/v0.3.0/specification/json/a2a.json',
  'a2a-v1.0.json':
    'https://raw.githubusercontent.com/a2aproject/a2a-inspector/275f52360168f49d359eaf390cc8ffe848cc291f/internal/validate/schemas/a2a-v1.0.json',
};

for (const [file, url] of Object.entries(SOURCES)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  JSON.parse(text); // must be JSON
  writeFileSync(join(dir, file), text);
  console.log(`${file}  sha256=${createHash('sha256').update(text).digest('hex')}  <- ${url}`);
}
