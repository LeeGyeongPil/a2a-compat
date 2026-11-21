// AC-8: 첫 실행 — demo 가 로컬 주소만으로 끝나고 FAILS 와 CAN CONNECT 를 함께 보여 준다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers/common.js';

test('demo prints "1.0 client → v0.3 agent: FAILS" before and CAN CONNECT after the proxy, exit 0', async () => {
  const r = await runCli(['demo'], { A2A_COMPAT_LANG: 'en' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1\.0 client → v0\.3 agent: FAILS/);
  assert.match(r.stdout, /1\.0 client → v0\.3 agent via a2a-compat proxy: CAN CONNECT/);
  assert.match(r.stdout, /mock/i); // 연습용 목 모드임을 밝힌다
  assert.match(r.stdout, /state=TASK_STATE_COMPLETED/);
});

test('demo in Korean keeps the verdict tokens', async () => {
  const r = await runCli(['demo'], { LANG: 'ko_KR.UTF-8' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /FAILS/);
  assert.match(r.stdout, /CAN CONNECT/);
  assert.match(r.stdout, /연습용 목\(mock\) 모드/);
});
