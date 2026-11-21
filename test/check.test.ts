// AC-4: check 행렬이 목 3종에서 프로브와 같고, --require 종료 코드·무부작용·연결 불가를 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkEndpoint, startMockAgent, type MockKind } from '../src/index.js';
import { runCli } from './helpers/common.js';
import { EXPECTED, rows } from './helpers/expected.js';

for (const kind of ['v1-strict', 'v1-compat', 'v0.3'] as MockKind[]) {
  test(`check matrix for mock ${kind} matches the probe, and probes create no task`, async () => {
    const mock = await startMockAgent(kind);
    try {
      const report = await checkEndpoint(mock.url);
      assert.deepEqual(rows(report), EXPECTED[kind]);
      assert.equal(mock.taskCount(), 0); // 없는 작업 ID 로 GetTask 만 했다
      assert.equal(report.varyOnVersion, kind === 'v1-compat');
    } finally {
      await mock.close();
    }
  });
}

test('--probe-send is the only way to create tasks (opt-in)', async () => {
  const mock = await startMockAgent('v1-compat');
  try {
    const report = await checkEndpoint(mock.url, { probeSend: true });
    assert.equal(mock.taskCount(), 2); // message/send + SendMessage
    assert.equal(report.matrix[0]!.verdict, 'CAN_CONNECT');
  } finally {
    await mock.close();
  }
});

test('CLI --json --require 0.3,1.0: v1-compat exit 0, v1-strict and v0.3 exit 1', async () => {
  const compat = await runCli(['check', '--mock', 'v1-compat', '--json', '--require', '0.3,1.0']);
  assert.equal(compat.code, 0, compat.stderr);
  const report = JSON.parse(compat.stdout);
  assert.deepEqual(report.requirements, { required: ['0.3', '1.0'], failed: [] });
  assert.equal(report.matrix[2].cause, 'missing_version_header');

  const strict = await runCli(['check', '--mock', 'v1-strict', '--json', '--require', '0.3,1.0']);
  assert.equal(strict.code, 1);
  assert.deepEqual(JSON.parse(strict.stdout).requirements.failed, ['0.3']);

  const legacy = await runCli(['check', '--mock', 'v0.3', '--json', '--require', '0.3,1.0']);
  assert.equal(legacy.code, 1);
  assert.deepEqual(JSON.parse(legacy.stdout).requirements.failed, ['1.0']);
});

test('CLI text output explains the masked -32601', async () => {
  const r = await runCli(['check', '--mock', 'v1-compat'], { A2A_COMPAT_LANG: 'en' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /CAN CONNECT/);
  assert.match(r.stdout, /hidden behind a method error/);
});

test('an unreachable URL exits 2', async () => {
  // 빈 포트를 얻은 뒤 닫아서 "아무도 듣지 않는 주소" 를 만든다.
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  const r = await runCli(['check', `http://127.0.0.1:${port}`, '--timeout', '3'], { A2A_COMPAT_LANG: 'en' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Cannot reach/);
});

test('usage errors exit 2: missing URL, bad --require, bad --mock', async () => {
  assert.equal((await runCli(['check'])).code, 2);
  assert.equal((await runCli(['check', '--mock', 'v1-compat', '--require', '2.0'])).code, 2);
  assert.equal((await runCli(['check', '--mock', 'v9'])).code, 2);
});
