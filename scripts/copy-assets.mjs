// Copies the non-TypeScript assets (bundled JSON Schemas, message catalogs)
// next to the compiled JavaScript. `--test` also copies them into dist-test/.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [join(root, 'dist')];
if (process.argv.includes('--test')) targets.push(join(root, 'dist-test', 'src'));

for (const out of targets) {
  for (const dir of ['schemas', 'i18n']) {
    mkdirSync(join(out, dir), { recursive: true });
    cpSync(join(root, 'src', dir), join(out, dir), {
      recursive: true,
      filter: (src) => !src.endsWith('.ts'),
    });
  }
}
