// AC-1: 번역기가 공식 SDK 캡처 fixture 와 일치한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toV1, toV03, methodToV1, methodToV03, UnsupportedOperationError } from '../src/index.js';
import { fixture, normalizeIds } from './helpers/common.js';

const v03ClientReq = fixture('sdk/client-v03.message-send.request.json');
const v1ClientReq = fixture('sdk/client-v1.send-message.request.json');

test('0.3 message/send (official 0.3.14 client) -> 1.0 SendMessage like the official 1.3.0 client', () => {
  const out = toV1(v03ClientReq.body);
  assert.equal(out.method, 'SendMessage');
  const params = out.params as any;
  // 메시지는 공식 1.0 클라이언트가 보낸 것과 정확히 같다: ROLE_USER, kind 없는 part
  assert.deepEqual(params.message, v1ClientReq.body.params.message);
  assert.equal(params.message.role, 'ROLE_USER');
  assert.equal('kind' in params.message.parts[0], false);
  // blocking:true -> returnImmediately:false (1.0 클라이언트는 기본값 false 를 생략한다)
  assert.equal(params.configuration.returnImmediately, false);
  assert.deepEqual(params.configuration.acceptedOutputModes, v1ClientReq.body.params.configuration.acceptedOutputModes);
  assert.equal(out.id, v03ClientReq.body.id);
});

test('1.0 SendMessage (official 1.3.0 client) -> 0.3 message/send exactly like the official 0.3.14 client', () => {
  const out = toV03(v1ClientReq.body);
  assert.deepEqual(out, v03ClientReq.body);
});

test('same task read through both dialects of the official compat server: exact pair both ways', () => {
  const v1 = fixture('sdk/p2.get-task.v1.response.json');
  const v03 = fixture('sdk/p2.get-task.v03.response.json');
  assert.deepEqual(toV03(v1, { method: 'GetTask' }), v03);
  assert.deepEqual(toV1(v03, { method: 'tasks/get' }), v1);
});

test('1.0 {task:{TASK_STATE_COMPLETED}} -> 0.3 {kind:"task", state:"completed"} with part kind restored', () => {
  const v1 = fixture('sdk/p2.send-message.v1.response.json');
  const out = toV03(v1, { method: 'SendMessage' }) as any;
  assert.equal(out.result.kind, 'task');
  assert.equal(out.result.status.state, 'completed');
  assert.equal(out.result.artifacts[0].parts[0].kind, 'text');
  assert.equal(out.result.history[0].kind, 'message');
  assert.equal(out.result.history[0].role, 'user');
  // 반대로 0.3 응답(공식 호환 서버 출력) -> 1.0 은 {task:{...}} 로 감싼다
  const back = toV1(fixture('sdk/p2.message-send.v03.response.json'), { method: 'message/send' }) as any;
  assert.equal(back.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal('kind' in back.result.task, false);
  assert.deepEqual(back.result.task.artifacts[0].parts[0], { text: 'echo: hi' });
});

test('SSE: 1.0 statusUpdate -> 0.3 status-update with final recomputed (matches the official compat stream)', () => {
  const v1Events = fixture<any[]>('sdk/p2.stream.v1.events.json');
  const v03Events = fixture<any[]>('sdk/p2.stream.v03.events.json');
  const translated = v1Events.map((e) => toV03(e, { method: 'SendStreamingMessage' }));
  assert.deepEqual(normalizeIds(translated), normalizeIds(v03Events));
  const last = translated.at(-1) as any;
  assert.equal(last.result.kind, 'status-update');
  assert.equal(last.result.final, true);
  // 0.3 -> 1.0: kind·final 이 사라지고 statusUpdate 키로 감싼다
  const back = v03Events.map((e) => toV1(e, { method: 'message/stream' }));
  assert.deepEqual(normalizeIds(back), normalizeIds(v1Events));
  assert.equal(JSON.stringify(back).includes('"final"'), false);
});

test('final is true only for terminal states, false for working / input-required', () => {
  const ev = (state: string) => toV03({ jsonrpc: '2.0', id: 1, result: { statusUpdate: { taskId: 't', contextId: 'c', status: { state } } } }, { method: 'SendStreamingMessage' }) as any;
  for (const s of ['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED']) assert.equal(ev(s).result.final, true, s);
  for (const s of ['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']) assert.equal(ev(s).result.final, false, s);
  assert.equal(ev('TASK_STATE_CANCELED').result.status.state, 'canceled');
});

test('blocking <-> returnImmediately polarity is inverted', () => {
  const send03 = (configuration: unknown) => toV1({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm', parts: [] }, configuration } }) as any;
  assert.equal(send03({ blocking: true }).params.configuration.returnImmediately, false);
  assert.equal(send03({ blocking: false }).params.configuration.returnImmediately, true);
  assert.equal('blocking' in send03({ blocking: true }).params.configuration, false);
  const send1 = (configuration: unknown) => toV03({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: 'm', parts: [] }, configuration } }) as any;
  assert.equal(send1({ returnImmediately: false }).params.configuration.blocking, true);
  assert.equal(send1({ returnImmediately: true }).params.configuration.blocking, false);
  assert.equal(send1({}).params.configuration.blocking, true); // 1.0 기본값 false = blocking
});

test('five method pairs round-trip through methodToV1/methodToV03 and request translation', () => {
  const pairs = [
    ['message/send', 'SendMessage'],
    ['message/stream', 'SendStreamingMessage'],
    ['tasks/get', 'GetTask'],
    ['tasks/cancel', 'CancelTask'],
    ['tasks/resubscribe', 'SubscribeToTask'],
  ];
  for (const [old, neu] of pairs) {
    assert.equal(methodToV1(old!), neu);
    assert.equal(methodToV03(neu!), old);
    const req = { jsonrpc: '2.0', id: 3, method: old!, params: { id: 'task-1' } };
    const there = toV1(req);
    assert.equal(there.method, neu);
    assert.equal(toV03(there).method, old);
  }
});

test('ListTasks -> 0.3 throws UnsupportedOperationError (-32004)', () => {
  assert.throws(() => methodToV03('ListTasks'), (e: unknown) => e instanceof UnsupportedOperationError && e.code === -32004);
  assert.throws(
    () => toV03({ jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {} }),
    (e: unknown) => e instanceof UnsupportedOperationError && /0\.3/.test((e as Error).message),
  );
});

test('all nine task states and both roles map both ways', () => {
  const states = ['submitted', 'working', 'input-required', 'completed', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'];
  for (const s of states) {
    const v1 = toV1({ jsonrpc: '2.0', id: 1, result: { kind: 'task', id: 't', contextId: 'c', status: { state: s } } }, { method: 'tasks/get' }) as any;
    assert.match(v1.result.status.state, /^TASK_STATE_/);
    const back = toV03(v1, { method: 'GetTask' }) as any;
    assert.equal(back.result.status.state, s);
  }
  const m = toV1({ jsonrpc: '2.0', id: 1, result: { kind: 'message', role: 'agent', messageId: 'x', parts: [] } }, { method: 'message/send' }) as any;
  assert.equal(m.result.message.role, 'ROLE_AGENT');
});

test('errors: 1.0 ErrorInfo is added/removed and -32009 becomes -32600 for 0.3 clients', () => {
  const errors = fixture('sdk/errors.json');
  const strict = toV03(errors['v1-strict SendMessage no header']) as any;
  assert.equal(strict.error.code, -32600);
  assert.equal('data' in strict.error, false);
  assert.match(strict.error.message, /0\.3/);
  // 0.3 TaskNotFound -> 1.0 와 같은 ErrorInfo (공식 1.0 서버 출력과 data 가 같다)
  const notFound = toV1(errors['v0.3 tasks/get unknown id']) as any;
  assert.deepEqual(notFound.error.data, errors['v1-strict GetTask unknown id'].error.data);
});

test('parts: file (uri/bytes) and data parts map to url/raw/mediaType/filename and back', () => {
  const parts03 = [
    { kind: 'file', file: { uri: 'https://x.example/a.pdf', mimeType: 'application/pdf', name: 'a.pdf' } },
    { kind: 'file', file: { bytes: 'aGVsbG8=', mimeType: 'text/plain' } },
    { kind: 'data', data: { k: 1 } },
  ];
  const req = { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm', parts: parts03 } } };
  const v1 = toV1(req) as any;
  assert.deepEqual(v1.params.message.parts, [
    { url: 'https://x.example/a.pdf', mediaType: 'application/pdf', filename: 'a.pdf' },
    { raw: 'aGVsbG8=', mediaType: 'text/plain' },
    { data: { k: 1 } },
  ]);
  const back = toV03(v1) as any;
  assert.deepEqual(back.params.message.parts, parts03);
  // 1.0 data part 의 원시값은 0.3 에서 { value } 로 감싸고, 되돌리면 원래 값
  const prim = toV03({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: 'm', parts: [{ data: 42 }] } } }) as any;
  assert.deepEqual(prim.params.message.parts[0].data, { value: 42 });
  assert.equal((toV1(prim) as any).params.message.parts[0].data, 42);
});
