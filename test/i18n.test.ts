// AC-7: 화면 언어 — --lang > A2A_COMPAT_LANG > LC_ALL/LC_MESSAGES/LANG, 한국어가 아니면 영어.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalog, resolveLang } from '../src/i18n/index.js';
import { CAUSES } from '../src/check/causes.js';
import { WARNING_MESSAGES } from '../src/card/warnings.js';
import { runCli } from './helpers/common.js';

const HANGUL = /[가-힣]/;

test('--help --lang ko is Korean, --lang en is English', async () => {
  const ko = await runCli(['--help', '--lang', 'ko']);
  assert.equal(ko.code, 0);
  assert.match(ko.stdout, /사용법/);
  const en = await runCli(['--help', '--lang', 'en']);
  assert.match(en.stdout, /Usage:/);
  assert.equal(HANGUL.test(en.stdout), false);
});

test('A2A_COMPAT_LANG=ko and LANG=ko_KR.UTF-8 each pick Korean; --lang en wins over both', async () => {
  assert.match((await runCli(['--help'], { A2A_COMPAT_LANG: 'ko' })).stdout, /사용법/);
  assert.match((await runCli(['--help'], { LANG: 'ko_KR.UTF-8' })).stdout, /사용법/);
  assert.match((await runCli(['--help'], { LC_ALL: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' })).stdout, /사용법/);
  assert.match((await runCli(['--help', '--lang', 'en'], { A2A_COMPAT_LANG: 'ko', LANG: 'ko_KR.UTF-8' })).stdout, /Usage:/);
});

test('LANG=fr_FR.UTF-8 (or nothing) falls back to English', async () => {
  assert.match((await runCli(['--help'], { LANG: 'fr_FR.UTF-8' })).stdout, /Usage:/);
  assert.match((await runCli(['--help'])).stdout, /Usage:/);
});

test('resolveLang priority order', () => {
  assert.equal(resolveLang(undefined, { A2A_COMPAT_LANG: 'ko', LANG: 'en_US.UTF-8' }), 'ko');
  assert.equal(resolveLang('en', { A2A_COMPAT_LANG: 'ko' }), 'en');
  assert.equal(resolveLang(undefined, { LC_MESSAGES: 'ko_KR', LANG: 'en_US' }), 'ko');
  assert.equal(resolveLang(undefined, { LANG: 'C' }), 'en');
  assert.equal(resolveLang('fr'), 'en');
});

test('en.json and ko.json have the same keys, covering every cause and warning code', () => {
  const en = Object.keys(catalog('en')).sort();
  const ko = Object.keys(catalog('ko')).sort();
  assert.deepEqual(ko, en);
  for (const c of CAUSES) {
    assert.ok(en.includes(`cause.${c}`), `cause.${c}`);
    assert.ok(en.includes(`fix.${c}`), `fix.${c}`);
  }
  for (const w of Object.keys(WARNING_MESSAGES)) assert.ok(en.includes(`warning.${w}`), `warning.${w}`);
  for (const k of en) assert.ok(catalog('ko')[k]!.length > 0, k);
});

test('check --json keeps English keys and cause codes under --lang ko; text output is Korean', async () => {
  const json = await runCli(['check', '--mock', 'v1-compat', '--json', '--lang', 'ko']);
  assert.equal(json.code, 0);
  assert.equal(HANGUL.test(json.stdout), false);
  const report = JSON.parse(json.stdout);
  assert.equal(report.matrix[2].cause, 'missing_version_header');
  assert.equal(report.matrix[2].verdict, 'FAILS');

  const text = await runCli(['check', '--mock', 'v1-compat', '--lang', 'ko']);
  assert.match(text.stdout, /클라이언트/); // 행렬 머리글
  assert.match(text.stdout, /원인/);
  assert.match(text.stdout, /가려집니다/); // -32601 로 가려진 헤더 누락 해설
});
