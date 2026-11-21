// AC-7 회귀(3회차 QA Q-1·Q-2): 프록시 로그·연결 오류·스키마 오류가 고른 언어로만 나오는가.
// 라이브러리 이벤트의 영어 message 가 한국어 화면에 그대로 붙지 않는지, 이유 코드마다 두 언어 문장이 있는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
