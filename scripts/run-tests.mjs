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

// 한 테스트가 멈춰도 CI 가 몇 시간씩 붙잡히지 않게: 테스트마다 2분, 전체 8분 상한.
// (--test-timeout 은 Node 20.11 / 21.2 부터 있다. engines 는 >=20 이지만 CI 는 최신 20.x 를 쓴다.)
const PER_TEST_MS = 120_000;
const TOTAL_MS = 8 * 60_000;
const [major, minor] = process.versions.node.split('.').map(Number);
const hasTestTimeout = major > 21 || (major === 21 && minor >= 2) || (major === 20 && minor >= 11);
const args = ['--test', ...(hasTestTimeout ? [`--test-timeout=${PER_TEST_MS}`] : []), ...files];
console.log(`node ${process.version} (${process.platform}-${process.arch}), ${files.length} test files`);
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
