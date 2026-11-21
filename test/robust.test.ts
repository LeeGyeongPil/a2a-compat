// AC-9: 견고성 — 선택 필드 결측·null, 모르는 필드 보존, JSON-RPC 가 아닌 입력, 고장 난 업스트림.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProxy, toV1, toV03, TranslationError, type ProxyHandle } from '../src/index.js';
import { SseTranslator } from '../src/proxy/sse.js';
import { msgV1, rpc } from './helpers/common.js';
import { brokenUpstream, type BrokenMode } from './helpers/broken-upstream.js';

const req = (method: string, params: unknown) => ({ jsonrpc: '2.0', id: 1, method, params });
const res = (result: unknown) => ({ jsonrpc: '2.0', id: 1, result });

// 20가지: 0.3·1.0 양쪽의 결측·null·모르는 값
const CASES: Array<[string, () => unknown]> = [
  ['0.3 send without referenceTaskIds', () => toV1(req('message/send', { message: { kind: 'message', role: 'user', messageId: 'm', parts: [{ kind: 'text', text: 'x' }] } }))],
  ['0.3 send with parts:null', () => toV1(req('message/send', { message: { kind: 'message', role: 'user', messageId: 'm', parts: null } }))],
  ['0.3 send without message', () => toV1(req('message/send', {}))],
  ['0.3 send with params:null', () => toV1(req('message/send', null))],
  ['0.3 send with unknown part kind', () => toV1(req('message/send', { message: { role: 'user', messageId: 'm', parts: [{ kind: 'video', src: 'v' }] } }))],
  ['0.3 send with null part', () => toV1(req('message/send', { message: { role: 'user', messageId: 'm', parts: [null, 3, 'x'] } }))],
  ['0.3 file part without file', () => toV1(req('message/send', { message: { role: 'user', messageId: 'm', parts: [{ kind: 'file' }] } }))],
  ['0.3 task without history', () => toV1(res({ kind: 'task', id: 't', contextId: 'c', status: { state: 'working' } }), { method: 'message/send' })],
  ['0.3 task with status:null', () => toV1(res({ kind: 'task', id: 't', status: null }), { method: 'message/send' })],
  ['0.3 status-update without status', () => toV1(res({ kind: 'status-update', taskId: 't' }), { method: 'message/stream' })],
  ['0.3 result with unknown kind', () => toV1(res({ kind: 'mystery', x: 1 }), { method: 'message/send' })],
  ['0.3 result null', () => toV1(res(null), { method: 'message/send' })],
  ['1.0 send with parts:null', () => toV03(req('SendMessage', { message: { role: 'ROLE_USER', messageId: 'm', parts: null } }))],
  ['1.0 send with unknown part shape', () => toV03(req('SendMessage', { message: { role: 'ROLE_USER', messageId: 'm', parts: [{ hologram: true }] } }))],
  ['1.0 task without history/artifacts', () => toV03(res({ task: { id: 't', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } } }), { method: 'SendMessage' })],
  ['1.0 task without status', () => toV03(res({ task: { id: 't' } }), { method: 'SendMessage' })],
  ['1.0 statusUpdate with status:null', () => toV03(res({ statusUpdate: { taskId: 't', status: null } }), { method: 'SendStreamingMessage' })],
  ['1.0 artifactUpdate without artifact', () => toV03(res({ artifactUpdate: { taskId: 't' } }), { method: 'SendStreamingMessage' })],
  ['1.0 numeric enum state', () => toV03(res({ id: 't', status: { state: 3 } }), { method: 'GetTask' })],
  ['1.0 error without data', () => toV03({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'x' } })],
];

for (const [name, fn] of CASES) {
  test(`no exception: ${name}`, () => {
    assert.doesNotThrow(fn);
  });
}

test('unknown fields are preserved in both directions', () => {
  const v1 = toV1(req('message/send', { message: { kind: 'message', role: 'user', messageId: 'm', parts: [{ kind: 'text', text: 'x', extra: 1 }], futureField: 'keep' }, vendorParam: true })) as any;
  assert.equal(v1.params.message.futureField, 'keep');
  assert.equal(v1.params.vendorParam, true);
  assert.equal(v1.params.message.parts[0].extra, 1);
  const v03 = toV03(res({ task: { id: 't', status: { state: 'TASK_STATE_WORKING' }, vendor: { a: 1 } } }), { method: 'SendMessage' }) as any;
  assert.deepEqual(v03.result.vendor, { a: 1 });
  assert.equal(toV03(res({ id: 't', status: { state: 3 } }), { method: 'GetTask' }).result && (toV03(res({ id: 't', status: { state: 3 } }), { method: 'GetTask' }) as any).result.status.state, 'completed');
});

test('only non-JSON-RPC input raises TranslationError', () => {
  for (const bad of [null, [], 'text', 42, { foo: 1 }, { jsonrpc: '2.0', id: 1 }]) {
    assert.throws(() => toV1(bad as any), TranslationError, JSON.stringify(bad));
    assert.throws(() => toV03(bad as any), TranslationError, JSON.stringify(bad));
  }
});

test('SSE translator handles arbitrary chunk boundaries, CRLF, comments and multi-line data', () => {
  const upper = new SseTranslator((d) => d.toUpperCase());
  const input = ': ping\n\nevent: msg\r\ndata: {"a":\ndata: 1}\n\ndata: {"b":2}\n\n';
  let out = '';
  for (const ch of input) out += upper.push(ch); // 한 글자씩
  out += upper.end();
  assert.equal(out, ': ping\n\nevent: msg\ndata: {"A":\ndata: 1}\n\ndata: {"B":2}\n\n');
  // 끝에 빈 줄 없이 잘린 이벤트: 완전한 JSON 이면 내보내고, 잘렸으면 버린다
  const t1 = new SseTranslator((d) => d);
  assert.equal(t1.push('data: {"ok":true}') + t1.end(), 'data: {"ok":true}\n\n');
  const t2 = new SseTranslator((d) => d);
  assert.equal(t2.push('data: {"cut":') + t2.end(), '');
});

// ---------- 고장 난 업스트림 ----------

const toClose: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of toClose.reverse()) await c();
});

test('non-JSON upstream answer -> client gets -32603, proxy keeps running', async () => {
  const mode = { value: 'html' as BrokenMode };
  const up = await brokenUpstream(mode);
  const proxy: ProxyHandle = await createProxy({ upstream: up.url });
  toClose.push(up.close, proxy.close);
  const r = await rpc(`${proxy.url}/a2a/jsonrpc`, 'SendMessage', msgV1(), '1.0');
  assert.equal(r.error.code, -32603);
  assert.match(r.error.message, /non-JSON/);
  // 프록시는 살아 있다
  assert.equal((await fetch(`${proxy.url}/.well-known/agent-card.json`)).status, 200);
});

test('upstream gone after start -> -32603 "upstream request failed"', async () => {
  const up = await brokenUpstream({ value: 'html' });
  const proxy = await createProxy({ upstream: up.url });
  toClose.push(proxy.close);
  await up.close();
  const r = await rpc(`${proxy.url}/a2a/jsonrpc`, 'SendMessage', msgV1(), '1.0');
  assert.equal(r.error.code, -32603);
  assert.match(r.error.message, /upstream request failed/);
});

test('malformed client requests get JSON-RPC errors, not crashes', async () => {
  const up = await brokenUpstream({ value: 'html' });
  const proxy = await createProxy({ upstream: up.url });
  toClose.push(up.close, proxy.close);
  const post = (body: string) => fetch(`${proxy.url}/a2a/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((r) => r.json() as Promise<any>);
  assert.equal((await post('{not json')).error.code, -32700);
  assert.equal((await post('[]')).error.code, -32600);
  assert.equal((await post('{"jsonrpc":"2.0","id":1}')).error.code, -32600);
});
