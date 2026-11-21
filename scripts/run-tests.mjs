// Runs compiled test files. Node 20's test runner does not expand globs, so list the files ourselves.
//   --suite default  test/*.test.ts            what CI and `npm test` run (serial, no child processes, signals, timers or SDKs)
//   --suite e2e      test/e2e/*.test.ts        long-lived CLI child processes, signals, EPIPE, stream cut-offs, timers
//   --suite interop  test/interop/*.test.ts    official @a2a-js/sdk clients and servers + express
//   --suite all      all of the above (local only)
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SUITES = ['default', 'e2e', 'interop', 'all'];
const at = process.argv.indexOf('--suite');
const suite = at === -1 ? 'default' : process.argv[at + 1];
if (!SUITES.includes(suite)) {
  console.error(`Unknown suite "${suite}". Use one of: ${SUITES.join(', ')}.`);
  process.exit(2);
}

const BASE = 'dist-test/test';

function testFiles(dir, recursive) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return recursive ? testFiles(p, true) : [];
    return p.endsWith('.test.js') ? [p] : [];
  });
}

let files;
try {
  if (suite === 'default') files = testFiles(BASE, false);
  else if (suite === 'all') files = testFiles(BASE, true);
  else files = testFiles(join(BASE, suite), true);
} catch {
  files = [];
}
files.sort();
if (files.length === 0) {
  console.error(`No compiled tests found for suite "${suite}" in ${BASE}. Run \`npm run build:test\` first.`);
  process.exit(2);
}

// 한 테스트가 멈춰도 CI 가 몇 시간씩 붙잡히지 않게: 테스트마다 2분, 전체 8분 상한.
// (--test-timeout 은 Node 20.11 / 21.2 부터 있다. engines 는 >=20 이지만 CI 는 최신 20.x 를 쓴다.)
const PER_TEST_MS = 120_000;
const TOTAL_MS = 8 * 60_000;
const [major, minor] = process.versions.node.split('.').map(Number);
const hasTestTimeout = major > 21 || (major === 21 && minor >= 2) || (major === 20 && minor >= 11);
// 기본 스위트는 파일을 하나씩 직렬로 돌린다(러너 속도에 따른 포트·타이밍 경쟁을 없애기 위해).
const serial = suite === 'default' ? ['--test-concurrency=1'] : [];
const args = ['--test', ...serial, ...(hasTestTimeout ? [`--test-timeout=${PER_TEST_MS}`] : []), ...files];
console.log(`node ${process.version} (${process.platform}-${process.arch}), suite ${suite}, ${files.length} test files`);
const r = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  timeout: TOTAL_MS,
  killSignal: 'SIGKILL',
});
if (r.error) {
  // 시간 초과(ETIMEDOUT)나 실행 실패를 숨기지 않고 알린다.
  console.error(`test runner did not finish: ${r.error.code ?? r.error.message}`);
  process.exit(1);
}
if (r.signal) {
  console.error(`test runner was killed by ${r.signal}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
