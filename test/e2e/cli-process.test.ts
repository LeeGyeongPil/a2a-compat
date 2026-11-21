// e2e (로컬 전용): 자식 프로세스 수명·시간 상한에 기대는 CLI 검사. 실행: npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CLI, ROOT, runCli } from '../helpers/common.js';

test('closing stdout early does not print an EPIPE stack trace', async () => {
  const child = spawn(process.execPath, [CLI, 'check', '--mock', 'v1-compat', '--json'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, A2A_COMPAT_LANG: 'en' } });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += String(d)));
  await new Promise((resolve) => child.on('close', resolve));
  assert.doesNotMatch(stderr, /EPIPE|at Object\.out/);
});

test('demo finishes in under 10 s with exit 0 (AC-8)', async () => {
  const started = Date.now();
  const r = await runCli(['demo'], { A2A_COMPAT_LANG: 'en' });
  const seconds = (Date.now() - started) / 1000;
  assert.equal(r.code, 0, r.stderr);
  assert.ok(seconds < 10, `took ${seconds}s`);
});
