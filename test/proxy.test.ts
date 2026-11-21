// AC-5: 프록시(목 상대) — 요청·응답·SSE·카드·거부·헤더 누락 안내·--infer-version.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProxy, detectCardVersion, startMockAgent, validateCard, type MockAgent, type ProxyHandle } from '../src/index.js';
import { spawn } from 'node:child_process';
import { CLI, msgV03, msgV1, rpc, sse } from './helpers/common.js';

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

async function setup(kind: 'v0.3' | 'v1-strict' | 'v1-compat', inferVersion = false): Promise<{ mock: MockAgent; proxy: ProxyHandle; rpcUrl: string }> {
  const mock = await startMockAgent(kind);
  const proxy = await createProxy({ upstream: mock.url, inferVersion });
  cleanups.push(() => mock.close(), () => proxy.close());
  return { mock, proxy, rpcUrl: `${proxy.url}/a2a/jsonrpc` };
}

test('1.0 client -> proxy -> v0.3 agent: SendMessage returns {task:{status:{state:TASK_STATE_COMPLETED}}}', async () => {
  const { rpcUrl, proxy } = await setup('v0.3');
  assert.deepEqual(proxy.upstreamVersions, ['0.3']);
  const res = await rpc(rpcUrl, 'SendMessage', msgV1('hello'), '1.0');
  assert.equal(res.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(res.result.task.artifacts[0].parts[0], { text: 'echo: hello' });
  assert.equal(res.result.task.history[0].role, 'ROLE_USER');
  assert.equal(JSON.stringify(res).includes('"kind"'), false);

  // GetTask 는 감싸지 않은 Task 로 돌아온다
  const got = await rpc(rpcUrl, 'GetTask', { id: res.result.task.id }, '1.0');
  assert.equal(got.result.id, res.result.task.id);
  assert.equal(got.result.status.state, 'TASK_STATE_COMPLETED');
  assert.equal('task' in got.result, false);
});

test('1.0 client -> proxy -> v0.3 agent: SendStreamingMessage events have no kind/final and use statusUpdate', async () => {
  const { rpcUrl } = await setup('v0.3');
  const { contentType, events } = await sse(rpcUrl, 'SendStreamingMessage', msgV1(), '1.0');
  assert.match(contentType, /text\/event-stream/);
  assert.equal(events.length, 3);
  for (const e of events) {
    assert.equal(JSON.stringify(e).includes('"kind"'), false);
    assert.equal(JSON.stringify(e).includes('"final"'), false);
  }
  assert.ok(events[0].result.task);
  assert.ok(events[1].result.artifactUpdate);
  assert.equal(events[2].result.statusUpdate.status.state, 'TASK_STATE_COMPLETED');
});

test('ListTasks and push-notification config methods are refused with -32004 and a reason', async () => {
  const { rpcUrl, mock } = await setup('v0.3');
  const list = await rpc(rpcUrl, 'ListTasks', {}, '1.0');
  assert.equal(list.error.code, -32004);
  assert.match(list.error.message, /0\.3 has no method to list tasks/);
  assert.equal(list.error.data[0].reason, 'UNSUPPORTED_OPERATION');
  const push = await rpc(rpcUrl, 'CreateTaskPushNotificationConfig', { taskId: 't', url: 'https://hook.example' }, '1.0');
  assert.equal(push.error.code, -32004);
  assert.match(push.error.message, /M1/);
  assert.equal(mock.taskCount(), 0);
});

test('proxy card: header 1.0 -> strict 1.0 card; no header -> hybrid card + Vary, url = proxy', async () => {
  const { proxy } = await setup('v0.3');
  const cardUrl = `${proxy.url}/.well-known/agent-card.json`;
  const r1 = await fetch(cardUrl, { headers: { 'A2A-Version': '1.0' } });
  const v1card: any = await r1.json();
  assert.equal(r1.headers.get('vary'), 'A2A-Version');
  const v1check = validateCard(v1card);
  assert.equal(v1check.v10.valid, true, v1check.v10.errors.join('; '));
  assert.ok(v1card.supportedInterfaces.every((i: any) => i.url === `${proxy.url}/a2a/jsonrpc`));

  const r0 = await fetch(cardUrl);
  const hybrid: any = await r0.json();
  assert.equal(r0.headers.get('vary'), 'A2A-Version');
  assert.equal(detectCardVersion(hybrid), 'hybrid');
  assert.equal(validateCard(hybrid).v03.valid, true);
  assert.equal(hybrid.url, `${proxy.url}/a2a/jsonrpc`);
});

test('SendMessage without A2A-Version: default explains the missing header, --infer-version accepts it', async () => {
  const strict = await setup('v0.3');
  const refused = await rpc(strict.rpcUrl, 'SendMessage', msgV1());
  assert.equal(refused.error.code, -32601);
  assert.match(refused.error.message, /A2A-Version header/);
  assert.match(refused.error.message, /--infer-version/);

  const lenient = await setup('v0.3', true);
  const ok = await rpc(lenient.rpcUrl, 'SendMessage', msgV1());
  assert.equal(ok.result.task.status.state, 'TASK_STATE_COMPLETED');
});

test('unsupported A2A-Version header -> -32009 listing 1.0 and 0.3', async () => {
  const { rpcUrl } = await setup('v0.3');
  const res = await rpc(rpcUrl, 'SendMessage', msgV1(), '2.0');
  assert.equal(res.error.code, -32009);
  assert.match(res.error.message, /Supported versions: 1\.0, 0\.3/);
});

test('0.3 client -> proxy -> strict 1.0 agent: message/send result has kind:"task"', async () => {
  const { rpcUrl, proxy } = await setup('v1-strict');
  assert.deepEqual(proxy.upstreamVersions, ['1.0']);
  const res = await rpc(rpcUrl, 'message/send', msgV03('hey'));
  assert.equal(res.result.kind, 'task');
  assert.equal(res.result.status.state, 'completed');
  assert.deepEqual(res.result.artifacts[0].parts[0], { kind: 'text', text: 'echo: hey' });
  const got = await rpc(rpcUrl, 'tasks/get', { id: res.result.id });
  assert.equal(got.result.kind, 'task');
  const missing = await rpc(rpcUrl, 'tasks/get', { id: 'nope' });
  assert.equal(missing.error.code, -32001);
  assert.equal('data' in missing.error, false); // 0.3 오류에는 ErrorInfo 가 없다
});

test('0.3 client -> proxy -> strict 1.0 agent: last stream event is status-update with final:true', async () => {
  const { rpcUrl } = await setup('v1-strict');
  const { events } = await sse(rpcUrl, 'message/stream', msgV03());
  assert.equal(events[0].result.kind, 'task');
  assert.equal(events[0].result.status.state, 'working');
  assert.equal(events[1].result.kind, 'artifact-update');
  const last = events.at(-1);
  assert.equal(last.result.kind, 'status-update');
  assert.equal(last.result.final, true);
  assert.equal(last.result.status.state, 'completed');
});

test('passthrough when the upstream already speaks the client version (compat upstream)', async () => {
  const { rpcUrl, proxy } = await setup('v1-compat');
  assert.deepEqual(proxy.upstreamVersions, ['1.0', '0.3']);
  const v1 = await rpc(rpcUrl, 'SendMessage', msgV1(), '1.0');
  assert.equal(v1.result.task.status.state, 'TASK_STATE_COMPLETED');
  const v03 = await rpc(rpcUrl, 'message/send', msgV03());
  assert.equal(v03.result.kind, 'task');
  // passthrough 이면 ListTasks 도 1.0 업스트림이 직접 처리한다
  const list = await rpc(rpcUrl, 'ListTasks', {}, '1.0');
  assert.ok(Array.isArray(list.result.tasks));
});

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

test('close() stops the proxy and refuses new connections', async () => {
  const mock = await startMockAgent('v0.3');
  cleanups.push(() => mock.close());
  const proxy = await createProxy({ upstream: mock.url });
  await proxy.close();
  await assert.rejects(fetch(`${proxy.url}/.well-known/agent-card.json`));
});
