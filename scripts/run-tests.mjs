// Runs every compiled test file. Node 20's test runner does not expand globs, so list the files ourselves.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.test.js') ? [p] : [];
  });
}

const files = walk('dist-test/test').sort();
if (files.length === 0) {
  console.error('No compiled tests found in dist-test/test. Run `npm run build:test` first.');
  process.exit(2);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
