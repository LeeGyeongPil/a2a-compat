// e2e (로컬 전용): CLI 프록시를 자식 프로세스로 띄우고 SIGINT 로 정리되는지 본다. 실행: npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CLI, msgV1, rpc } from '../helpers/common.js';

test('CLI proxy logs each translation and shuts down cleanly on SIGINT (exit 0)', async () => {
  const child = spawn(process.execPath, [CLI, 'proxy', '--mock-upstream', 'v0.3', '--listen', '0', '--lang', 'en'], { env: { ...process.env, NO_COLOR: '1' } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  // 'exit' 는 stdout 의 마지막 데이터보다 먼저 올 수 있다(Linux 에서 "proxy stopped" 를 놓친다).
  // 'close' 는 프로세스가 끝나고 stdio 까지 모두 닫힌 뒤에 온다.
  const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  try {
    const deadline = Date.now() + 15_000;
    while (!out.includes('Ctrl+C') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const url = /listening on (\S+)/.exec(out)?.[1];
    assert.ok(url, out);
    const res = await rpc(`${url}/a2a/jsonrpc`, 'SendMessage', msgV1(), '1.0');
    assert.equal(res.result.task.status.state, 'TASK_STATE_COMPLETED');
    child.kill('SIGINT');
    assert.equal(await exited, 0);
    assert.match(out, /SendMessage \(1\.0\) => message\/send \(0\.3\)/);
    assert.match(out, /kind:"task" -> task/);
    assert.match(out, /proxy stopped/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
