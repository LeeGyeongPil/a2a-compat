// AC-7 회귀(3회차 QA Q-1·Q-2): 프록시 로그·연결 오류·스키마 오류가 고른 언어로만 나오는가.
// 라이브러리 이벤트의 영어 message 가 한국어 화면에 그대로 붙지 않는지, 이유 코드마다 두 언어 문장이 있는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { catalog } from '../src/i18n/index.js';
import { PROXY_REASONS, type ProxyEvent } from '../src/index.js';
import { formatProxyEvent } from '../src/cli/commands/proxy.js';
import type { Ctx } from '../src/cli/render.js';
import { CLI, ROOT, fixturePath, msgV1, runCli } from './helpers/common.js';

const HANGUL = /[가-힣]/;
// 영어 문장 흔적: 소문자 영어 낱말 세 개 이상이 이어짐 (메서드 이름·코드·주소는 여기에 걸리지 않는다)
const ENGLISH_RUN = /\b[a-z]{2,} [a-z]{2,} [a-z]{2,}\b/;
const SENTINEL = 'this english sentence must not appear';

function ctxOf(lang: 'en' | 'ko'): Ctx {
  return { lang, out: () => {}, err: () => {}, color: false };
}

test('every proxy reason code has a sentence in en.json and ko.json', () => {
  for (const r of PROXY_REASONS) {
    assert.ok(catalog('en')[`proxy.reason.${r}`], `en proxy.reason.${r}`);
    assert.ok(catalog('ko')[`proxy.reason.${r}`], `ko proxy.reason.${r}`);
  }
});

test('ko proxy log lines use the reason code, never the English library message', () => {
  for (const reason of PROXY_REASONS) {
    for (const type of ['reject', 'error'] as const) {
      const e: ProxyEvent = { type, reason, method: 'ListTasks', clientVersion: '1.0', code: -32004, detail: 'ECONNREFUSED', message: SENTINEL };
      const ko = formatProxyEvent(ctxOf('ko'), e).join('\n');
      assert.ok(HANGUL.test(ko), `${type}/${reason}: ${ko}`);
      assert.ok(!ko.includes(SENTINEL), `${type}/${reason}: ${ko}`);
      assert.doesNotMatch(ko, ENGLISH_RUN, `${type}/${reason}: ${ko}`);
      const en = formatProxyEvent(ctxOf('en'), e).join('\n');
      assert.ok(!HANGUL.test(en), `${type}/${reason}: ${en}`);
    }
  }
  // 기술 값 중 영어 낱말로 된 것(timed out)은 옮긴다
  const timedOut = formatProxyEvent(ctxOf('ko'), { type: 'error', reason: 'card_failed', detail: 'timed out' }).join('');
  assert.match(timedOut, /시간 초과/);
});

test('stream response line is localized with an event count', () => {
  const e: ProxyEvent = { type: 'response', method: 'SendStreamingMessage', events: 3, shape: 'stream (3 events)' };
  assert.equal(formatProxyEvent(ctxOf('ko'), e)[0], '← SendStreamingMessage: 스트림 (이벤트 3개)');
  assert.equal(formatProxyEvent(ctxOf('en'), e)[0], '← SendStreamingMessage: stream (3 events)');
  assert.equal(formatProxyEvent(ctxOf('en'), { ...e, events: 1 })[0], '← SendStreamingMessage: stream (1 event)');
});

/** CLI 프록시를 띄워 요청 몇 개를 보내고 로그 전체를 돌려준다. */
async function proxyLog(args: string[], send: (rpcUrl: string) => Promise<void>): Promise<string> {
  const child = spawn(process.execPath, [CLI, 'proxy', '--mock-upstream', 'v0.3', '--listen', '0', ...args], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', A2A_COMPAT_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: '' },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  // 'exit' 는 stdout 의 마지막 데이터보다 먼저 올 수 있다. 'close' 는 stdio 까지 닫힌 뒤에 온다.
  const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  try {
    const deadline = Date.now() + 15_000;
    while (!out.includes('Ctrl+C') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    // 실제 바인딩 주소는 첫 줄에 있다(--public-url 과 상관없이)
    const listen = /(http:\/\/127\.0\.0\.1:\d+)/.exec(out.split('\n')[0] ?? '')?.[1];
    assert.ok(listen, out);
    await send(`${listen}/a2a/jsonrpc`);
    child.kill('SIGINT');
    assert.equal(await exited, 0);
    return out;
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function post(url: string, body: string, header?: string): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (header) headers['A2A-Version'] = header;
  const res = await fetch(url, { method: 'POST', headers, body });
  await res.text();
}

const call = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

test('proxy --lang ko: refusals, streams and malformed requests are logged in Korean only', async () => {
  const out = await proxyLog(['--lang', 'ko'], async (url) => {
    await post(url, call(1, 'SendMessage', msgV1('hello')), '1.0');
    await post(url, call(2, 'ListTasks', {}), '1.0');
    await post(url, call(3, 'SendStreamingMessage', msgV1('hi')), '1.0');
    await post(url, call(4, 'GetTask', { id: 'x' })); // 헤더 없는 1.0 메서드
    await post(url, call(5, 'CreateTaskPushNotificationConfig', {}), '1.0');
    await post(url, call(6, 'GetTask', {}), '9.9');
    await post(url, 'not json');
    await post(url, '[1]');
  });
  // QA Q-1 재현 줄: 거부 사유가 한국어
  const list = out.split('\n').find((l) => l.includes('ListTasks'));
  assert.ok(list, out);
  assert.match(list, /0\.3 에이전트로 넘길 수 없습니다/);
  assert.doesNotMatch(out, /has no method|cannot be forwarded|is not translated|Batch requests|Parse error/);
  assert.match(out, /스트림 \(이벤트 3개\)/);
  for (const line of out.split('\n')) assert.doesNotMatch(line, ENGLISH_RUN, line);
});

test('proxy --public-url: the first line shows the bound address, a second line the advertised one (en and ko)', async () => {
  const en = await proxyLog(['--public-url', 'https://agents.example.test/', '--lang', 'en'], async () => {});
  const first = en.split('\n')[0]!;
  assert.match(first, /listening on http:\/\/127\.0\.0\.1:\d+$/);
  assert.doesNotMatch(first, /agents\.example\.test/);
  assert.match(en, /advertise https:\/\/agents\.example\.test \(--public-url\)/);
  assert.match(en, /Use https:\/\/agents\.example\.test as the agent address/);

  const ko = await proxyLog(['--public-url', 'https://agents.example.test/', '--lang', 'ko'], async () => {});
  assert.match(ko.split('\n')[0]!, /http:\/\/127\.0\.0\.1:\d+ 에서 대기 중$/);
  assert.match(ko, /https:\/\/agents\.example\.test 을 알립니다 \(--public-url\)/);
});

test('check / proxy against an unreachable agent explain the failure in the chosen language', async () => {
  // 빈 포트를 얻은 뒤 닫아서 "아무도 듣지 않는 주소" 를 만든다.
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  const dead = `http://127.0.0.1:${port}`;

  const ko = await runCli(['check', dead, '--lang', 'ko', '--timeout', '5']);
  assert.equal(ko.code, 2);
  assert.match(ko.stderr, /에이전트 카드에 닿을 수 없습니다: ECONNREFUSED/);
  assert.doesNotMatch(ko.stderr, /Could not read/);
  const en = await runCli(['check', dead, '--lang', 'en', '--timeout', '5']);
  assert.match(en.stderr, /Cannot reach the agent card at .*: ECONNREFUSED/);

  const p = await runCli(['proxy', '--upstream', dead, '--listen', '0', '--lang', 'ko', '--timeout', '5']);
  assert.equal(p.code, 2);
  assert.match(p.stderr, /에이전트 카드에 닿을 수 없습니다: ECONNREFUSED/);
  assert.doesNotMatch(p.stderr, /Could not read/);
});

test('card validate --lang ko explains schema errors in Korean; --json keeps the English errors and adds issues', async () => {
  const ko = await runCli(['card', 'validate', fixturePath('cards/hybrid.json'), '--lang', 'ko']);
  assert.match(ko.stdout, /스키마가 허용하지 않는 필드가 있습니다 \(url\)/);
  assert.doesNotMatch(ko.stdout, /must NOT have/);
  for (const line of ko.stdout.split('\n')) assert.doesNotMatch(line, ENGLISH_RUN, line);

  const json = await runCli(['card', 'validate', fixturePath('cards/hybrid.json'), '--json', '--lang', 'ko']);
  const r = JSON.parse(json.stdout);
  assert.ok(r.v10.errors.some((e: string) => e.includes('must NOT have additional properties')));
  assert.deepEqual(r.v10.issues[0], { path: '/', keyword: 'additionalProperties', detail: 'url' });
  assert.equal(HANGUL.test(json.stdout), false);
});
