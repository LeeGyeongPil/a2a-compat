// AC-3: CLI 카드 명령의 stdout·stderr·종료 코드(0/1/2)를 자식 프로세스로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixturePath, runCli } from './helpers/common.js';

const EN = { A2A_COMPAT_LANG: 'en' };

test('card convert v03-native.json --to 1.0 prints a card with supportedInterfaces, exit 0', async () => {
  const r = await runCli(['card', 'convert', fixturePath('cards/v03-native.json'), '--to', '1.0'], EN);
  assert.equal(r.code, 0, r.stderr);
  const card = JSON.parse(r.stdout);
  assert.ok(Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length > 0);
  assert.match(r.stderr, /PROTOCOL_VERSION_PATCH/); // 경고는 stderr 로만
});

test('card convert v1-device-code.json --to 0.3 --strict reports LOSSY_DEVICE_CODE on stderr, exit 1', async () => {
  const r = await runCli(['card', 'convert', fixturePath('cards/v1-device-code.json'), '--to', '0.3', '--strict'], EN);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /LOSSY_DEVICE_CODE/);
  assert.equal(JSON.parse(r.stdout).protocolVersion, '0.3'); // 카드는 그래도 출력된다
});

test('the same conversion without --strict exits 0 but still warns', async () => {
  const r = await runCli(['card', 'convert', fixturePath('cards/v1-device-code.json'), '--to', '0.3'], EN);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /LOSSY_DEVICE_CODE/);
});

test('a missing file exits 2', async () => {
  const r = await runCli(['card', 'convert', fixturePath('cards/does-not-exist.json'), '--to', '1.0'], EN);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not found/);
  assert.equal(r.stdout, '');
});

test('usage errors exit 2: bad --to, missing --to, unknown command, unknown option', async () => {
  assert.equal((await runCli(['card', 'convert', fixturePath('cards/v03-native.json'), '--to', '2.0'], EN)).code, 2);
  assert.equal((await runCli(['card', 'convert', fixturePath('cards/v03-native.json')], EN)).code, 2);
  assert.equal((await runCli(['frobnicate'], EN)).code, 2);
  assert.equal((await runCli(['card', 'validate', fixturePath('cards/hybrid.json'), '--nope'], EN)).code, 2);
  assert.equal((await runCli(['card', 'convert', fixturePath('cards/empty.json'), '--to', '1.0'], EN)).code, 2); // 카드가 아님
});

test('card validate: hybrid is valid for 0.3 (exit 0), empty object is not a card (exit 1), --json', async () => {
  const ok = await runCli(['card', 'validate', fixturePath('cards/hybrid.json')], EN);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /hybrid/);
  const bad = await runCli(['card', 'validate', fixturePath('cards/empty.json')], EN);
  assert.equal(bad.code, 1);
  const json = await runCli(['card', 'validate', fixturePath('cards/v1-strict.json'), '--json'], EN);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.detected, 'v1.0');
  assert.equal(parsed.v10.valid, true);
});

test('--out writes the converted card to a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-compat-'));
  try {
    const out = join(dir, 'card.v1.json');
    const r = await runCli(['card', 'convert', fixturePath('cards/v03-native.json'), '--to', '1.0', '--out', out], EN);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.ok(JSON.parse(readFileSync(out, 'utf8')).supportedInterfaces);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
