// e2e (로컬 전용): 오래 사는 CLI 프록시 자식 프로세스를 띄우고 SIGINT 로 끝내며 로그의 언어를 확인한다.
// 시그널·자식 프로세스 수명·타이머에 기대므로 CI 기본 스위트에서는 돌리지 않는다. 실행: npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CLI, ROOT, msgV1 } from '../helpers/common.js';

// 영어 문장 흔적: 소문자 영어 낱말 세 개 이상이 이어짐 (메서드 이름·코드·주소는 여기에 걸리지 않는다)
const ENGLISH_RUN = /\b[a-z]{2,} [a-z]{2,} [a-z]{2,}\b/;


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

