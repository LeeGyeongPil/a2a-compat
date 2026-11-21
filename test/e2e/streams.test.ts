// e2e (로컬 전용): 업스트림 SSE 가 중간에 끊기거나 클라이언트가 떠나거나 업스트림이 조용할 때 프록시 동작.
// 짧은 타이머와 소켓 종료 순서에 기대므로 CI 기본 스위트에서는 돌리지 않는다. 실행: npm run test:e2e
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProxy } from '../../src/index.js';
import { msgV1, rpc } from '../helpers/common.js';
import { brokenUpstream, type BrokenMode } from './broken-stream-upstream.js';

const toClose: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of toClose.reverse()) await c();
});

test('upstream SSE cut mid-event -> client stream ends, first event delivered, proxy keeps running', async () => {
  const mode = { value: 'cut-stream' as BrokenMode };
  const up = await brokenUpstream(mode);
  const proxy = await createProxy({ upstream: up.url });
  toClose.push(up.close, proxy.close);
  const resp = await fetch(`${proxy.url}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage', params: msgV1() }),
  });
  const text = await resp.text(); // 스트림이 닫혀야 끝난다
  const events = text.split('\n').filter((l) => l.startsWith('data:'));
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0]!.slice(5)).result.task.status.state, 'TASK_STATE_WORKING');
  mode.value = 'html';
  const again = await rpc(`${proxy.url}/a2a/jsonrpc`, 'SendMessage', msgV1(), '1.0');
  assert.equal(again.error.code, -32603);
});

test('a client that disconnects mid-stream makes the proxy close the upstream stream too', async () => {
  let closed!: () => void;
  const upstreamClosed = new Promise<void>((r) => (closed = r));
  const up = await brokenUpstream({ value: 'hang' }, () => closed());
  const proxy = await createProxy({ upstream: up.url });
  toClose.push(up.close, proxy.close);
  const ac = new AbortController();
  const resp = await fetch(`${proxy.url}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage', params: msgV1() }),
    signal: ac.signal,
  });
  const reader = resp.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /TASK_STATE_WORKING/);
  ac.abort(); // 클라이언트가 떠난다
  // 기다림 타이머는 끝나면 지운다(남겨 두면 테스트 프로세스가 5초 더 살아 있다).
  let guard: NodeJS.Timeout | undefined;
  try {
    await Promise.race([upstreamClosed, new Promise((_, rej) => (guard = setTimeout(() => rej(new Error('upstream stream was not closed')), 5000)))]);
  } finally {
    clearTimeout(guard);
  }
});

test('stream idle timeout closes a silent upstream stream', async () => {
  let closed!: () => void;
  const upstreamClosed = new Promise<void>((r) => (closed = r));
  const up = await brokenUpstream({ value: 'hang' }, () => closed());
  const proxy = await createProxy({ upstream: up.url, idleTimeoutMs: 200 });
  toClose.push(up.close, proxy.close);
  const resp = await fetch(`${proxy.url}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage', params: msgV1() }),
  });
  const text = await resp.text(); // 유휴 타임아웃 뒤 프록시가 스트림을 닫아야 끝난다
  assert.match(text, /TASK_STATE_WORKING/);
  await upstreamClosed;
});

