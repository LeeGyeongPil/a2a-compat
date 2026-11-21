// Runs the same steps, in the same order and with the same names, as .github/workflows/ci.yml.
// `npm run ci:local` reproduces what CI does. It starts with `npm ci`, which deletes and reinstalls node_modules.
// test/ci-parity.test.ts checks that this list and the workflow stay identical.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STEPS = [
  { name: 'Show versions', cmd: 'node -v && npm -v' },
  { name: 'Install (npm ci)', cmd: 'npm ci --no-audit --no-fund' },
  { name: 'Build', cmd: 'npm run build' },
  { name: 'Test (default suite)', cmd: 'npm test' },
];

function main() {
  STEPS.forEach((step, i) => {
    console.log(`\n== [${i + 1}/${STEPS.length}] ${step.name}: ${step.cmd}`);
    const r = spawnSync(step.cmd, { shell: true, stdio: 'inherit' });
    const code = r.status ?? 1;
    if (code !== 0) {
      console.error(`CI step failed: ${step.name} (exit ${code})`);
      process.exit(code);
    }
  });
  console.log('\nAll CI steps passed.');
}

// import 해도 실행되지 않게: 직접 실행했을 때만 돈다.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
