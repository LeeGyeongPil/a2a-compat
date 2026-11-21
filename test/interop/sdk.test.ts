// AC-6: 공식 SDK 교차 — @a2a-js/sdk 1.3.0 / 0.3.14 의 실제 서버·클라이언트가 프록시를 거쳐 붙는지,
// 그리고 공식 서버 3종에 대한 check 행렬이 목 행렬(AC-4)과 같은지. 전부 localhost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkEndpoint, createProxy, type ProxyHandle } from '../src/index.js';
import { EXPECTED, rows } from './helpers/expected.js';

// 타입 없는 동적 import: 테스트에서 SDK 의 ts-proto 타입을 따라 쓰지 않으려는 것
const load = (spec: string): Promise<any> => import(spec);
let v1: any;
let v1c: any;
let o3c: any;
let servers: any;
const proxies: ProxyHandle[] = [];

before(async () => {
  v1 = await load('a2a-v1');
  v1c = await load('a2a-v1/client');
  o3c = await load('a2a-v03/client');
  const helpers = await load(new URL('../../test/helpers/sdk-servers.mjs', import.meta.url).href);
  servers = await helpers.startSdkServers();
});

after(async () => {
  for (const p of proxies) await p.close();
  await servers?.close();
});

async function proxyFor(kind: string): Promise<string> {
  const p = await createProxy({ upstream: servers[kind].url });
  proxies.push(p);
  return p.url;
}

/** 공식 1.0 클라이언트(기본 설정: legacyCompat 끔)가 보내는 메시지(ts-proto 객체 형태). */
function v1Send(client: any, text = 'hi') {
  return client.sendMessage({
    message: {
      role: v1.Role.ROLE_USER,
      messageId: crypto.randomUUID(),
      parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: '' }],
      contextId: '',
      taskId: '',
      extensions: [],
      metadata: undefined,
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
    tenant: '',
  });
}

function v03Send(client: any, text = 'hi') {
  return client.sendMessage({ message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text }] } });
}

test('official 1.0 client -> official 0.3 server: direct fails, through the proxy succeeds', async () => {
  const direct = servers['v0.3'].url;
  await assert.rejects(async () => v1Send(await new v1c.ClientFactory().createFromUrl(direct)), /No compatible transport found/);

  const client = await new v1c.ClientFactory().createFromUrl(await proxyFor('v0.3'));
  const task = await v1Send(client, 'through the proxy');
  assert.equal(task.status.state, v1.TaskState.TASK_STATE_COMPLETED);
  assert.equal(task.artifacts[0].parts[0].content.value, 'echo: through the proxy');
});

test('official 0.3 client -> official strict 1.0 server: direct fails, through the proxy succeeds', async () => {
  const direct = servers['v1-strict'].url;
  await assert.rejects(async () => v03Send(await new o3c.ClientFactory().createFromUrl(direct)), /No compatible transport found/);

  const client = await new o3c.ClientFactory().createFromUrl(await proxyFor('v1-strict'));
  const task = await v03Send(client, 'legacy says hi');
  assert.equal(task.kind, 'task');
  assert.equal(task.status.state, 'completed');
  assert.equal(task.artifacts[0].parts[0].text, 'echo: legacy says hi');
});

test('official clients stream through the proxy in both directions', async () => {
  const c1 = await new v1c.ClientFactory().createFromUrl(await proxyFor('v0.3'));
  const events1: any[] = [];
  for await (const e of c1.sendMessageStream({
    message: { role: v1.Role.ROLE_USER, messageId: crypto.randomUUID(), parts: [{ content: { $case: 'text', value: 's' }, metadata: undefined, filename: '', mediaType: '' }], contextId: '', taskId: '', extensions: [], metadata: undefined, referenceTaskIds: [] },
    configuration: undefined,
    metadata: undefined,
    tenant: '',
  })) {
    events1.push(e);
  }
  assert.ok(events1.length >= 2);
  // 공식 1.0 클라이언트는 StreamResponse 를 { payload: { $case, value } } 로 돌려준다
  assert.equal(events1[0].payload.$case, 'task');
  const last1 = events1.at(-1);
  assert.equal(last1.payload.$case, 'statusUpdate');
  assert.equal(last1.payload.value.status.state, v1.TaskState.TASK_STATE_COMPLETED);

  const c03 = await new o3c.ClientFactory().createFromUrl(await proxyFor('v1-strict'));
  const events03: any[] = [];
  for await (const e of c03.sendMessageStream({ message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text: 's' }] } })) events03.push(e);
  const last03 = events03.at(-1);
  assert.equal(last03.kind, 'status-update');
  assert.equal(last03.final, true);
  assert.equal(last03.status.state, 'completed');
});

for (const kind of ['v1-strict', 'v1-compat', 'v0.3']) {
  test(`check against the official ${kind} server gives the same matrix as the ${kind} mock`, async () => {
    const before = servers[kind].taskCount();
    const report = await checkEndpoint(servers[kind].url);
    assert.deepEqual(rows(report), EXPECTED[kind as keyof typeof EXPECTED]);
    assert.equal(servers[kind].taskCount(), before); // 탐침은 작업을 만들지 않는다
  });
}
