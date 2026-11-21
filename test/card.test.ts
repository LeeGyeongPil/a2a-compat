// AC-2: 카드 판별·검증·변환과 경고 코드.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertCard, detectCardVersion, validateCard, TranslationError } from '../src/index.js';
import { fixture } from './helpers/common.js';

const codes = (r: { warnings: Array<{ code: string }> }) => r.warnings.map((w) => w.code);
const versions = (card: any) => (card.supportedInterfaces as any[]).map((i) => i.protocolVersion).sort();

test('detectCardVersion: 1.0 strict / hybrid / 0.3 native / empty', () => {
  assert.equal(detectCardVersion(fixture('cards/v1-strict.json')), 'v1.0');
  assert.equal(detectCardVersion(fixture('cards/v1-compat.json')), 'v1.0');
  assert.equal(detectCardVersion(fixture('cards/hybrid.json')), 'hybrid');
  assert.equal(detectCardVersion(fixture('cards/v03-native.json')), 'v0.3');
  assert.equal(detectCardVersion(fixture('cards/empty.json')), 'unknown');
  assert.equal(detectCardVersion(null), 'unknown');
  assert.equal(detectCardVersion([]), 'unknown');
});

test('validateCard reproduces the probe: hybrid passes 0.3 and fails strict 1.0 (additionalProperties)', () => {
  const hybrid = validateCard(fixture('cards/hybrid.json'));
  assert.equal(hybrid.detected, 'hybrid');
  assert.equal(hybrid.v03.valid, true);
  assert.equal(hybrid.v10.valid, false);
  assert.ok(hybrid.v10.errors.some((e) => e.includes('(url)')), hybrid.v10.errors.join('; '));
  const strict = validateCard(fixture('cards/v1-strict.json'));
  assert.equal(strict.v10.valid, true);
  assert.equal(strict.v03.valid, false);
  assert.equal(validateCard(fixture('cards/v03-native.json')).v03.valid, true);
});

test('convert 0.3 -> 1.0 passes the bundled 1.0 schema', () => {
  const r = convertCard(fixture('cards/v03-native.json'), '1.0');
  assert.equal(validateCard(r.card).v10.valid, true, validateCard(r.card).v10.errors.join('; '));
  assert.equal(r.from, 'v0.3');
  assert.deepEqual((r.card as any).supportedInterfaces, [{ url: 'https://agent.example.com/a2a/jsonrpc', protocolBinding: 'JSONRPC', protocolVersion: '0.3' }]);
  assert.ok(codes(r).includes('PROTOCOL_VERSION_PATCH')); // "0.3.0" -> "0.3"
});

test('convert 1.0 -> 0.3 passes the 0.3 schema', () => {
  const fromCompat = convertCard(fixture('cards/v1-compat.json'), '0.3');
  assert.equal(validateCard(fromCompat.card).v03.valid, true);
  assert.equal(codes(fromCompat).includes('NO_V03_INTERFACE'), false);
  const fromStrict = convertCard(fixture('cards/v1-strict.json'), '0.3');
  assert.equal(validateCard(fromStrict.card).v03.valid, true);
  assert.ok(codes(fromStrict).includes('NO_V03_INTERFACE'));
  assert.equal('supportedInterfaces' in fromStrict.card, false);
});

test('convert -> hybrid passes 0.3 and lists both 1.0 and 0.3 interfaces', () => {
  for (const name of ['v03-native', 'v1-strict', 'v1-compat']) {
    const r = convertCard(fixture(`cards/${name}.json`), 'hybrid');
    const v = validateCard(r.card);
    assert.equal(v.v03.valid, true, `${name}: ${v.v03.errors.join('; ')}`);
    assert.equal(v.detected, 'hybrid');
    assert.deepEqual(versions(r.card), ['0.3', '1.0'], name);
    assert.ok(codes(r).includes('HYBRID_FAILS_STRICT_V1_SCHEMA'));
    assert.equal(v.v10.valid, false); // 그래서 경고가 맞다
  }
  // 이미 두 버전을 말하는 서버의 카드면 "두 버전 가정" 경고는 없다
  assert.equal(codes(convertCard(fixture('cards/v1-compat.json'), 'hybrid')).includes('ASSUMES_DUAL_STACK'), false);
  assert.ok(codes(convertCard(fixture('cards/v03-native.json'), 'hybrid')).includes('ASSUMES_DUAL_STACK'));
});

test('warning LOSSY_DEVICE_CODE: 1.0 deviceCode flow dropped in 0.3', () => {
  const r = convertCard(fixture('cards/v1-device-code.json'), '0.3');
  assert.ok(codes(r).includes('LOSSY_DEVICE_CODE'));
  const card = r.card as any;
  assert.deepEqual(card.securitySchemes.deviceLogin, { type: 'oauth2', flows: {} });
  assert.deepEqual(card.securitySchemes.apiKey, { type: 'apiKey', name: 'X-API-Key', in: 'header' });
  assert.deepEqual(card.security, [{ deviceLogin: ['agent:use'] }]);
  assert.equal(validateCard(card).v03.valid, true);
  assert.equal(r.warnings.find((w) => w.code === 'LOSSY_DEVICE_CODE')!.severity, 'lossy');
});

test('warning LOSSY_MULTIPLE_SECURITY_SCHEMES: two OAuth flows in 0.3 -> one in 1.0', () => {
  const r = convertCard(fixture('cards/v03-multi-flows.json'), '1.0');
  assert.ok(codes(r).includes('LOSSY_MULTIPLE_SECURITY_SCHEMES'));
  assert.ok(codes(r).includes('DROPPED_FIELD')); // capabilities.stateTransitionHistory 는 1.0 에 없다
  const card = r.card as any;
  assert.deepEqual(Object.keys(card.securitySchemes.oauth.oauth2SecurityScheme.flows), ['authorizationCode']);
  assert.deepEqual(card.securityRequirements, [{ schemes: { oauth: { list: ['agent:use'] } } }]);
  assert.deepEqual(card.skills[0].securityRequirements, [{ schemes: { oauth: { list: ['agent:use'] } } }]);
  assert.equal(validateCard(card).v10.valid, true, validateCard(card).v10.errors.join('; '));
});

test('warning EMPTY_TOP_LEVEL_URL on a hybrid card with an empty url', () => {
  const r = convertCard(fixture('cards/hybrid-empty-url.json'), '0.3');
  assert.ok(codes(r).includes('EMPTY_TOP_LEVEL_URL'));
});

test('warning PROTOCOL_VERSION_PATCH and HYBRID_FAILS_STRICT_V1_SCHEMA are info level', () => {
  const r = convertCard(fixture('cards/v03-native.json'), 'hybrid');
  const byCode = Object.fromEntries(r.warnings.map((w) => [w.code, w.severity]));
  assert.equal(byCode.PROTOCOL_VERSION_PATCH, 'info');
  assert.equal(byCode.HYBRID_FAILS_STRICT_V1_SCHEMA, 'info');
  assert.equal((r.card as any).protocolVersion, '0.3');
});

test('signed cards warn SIGNATURES_INVALIDATED when converted', () => {
  assert.ok(codes(convertCard(fixture('cards/v03-signed.json'), '1.0')).includes('SIGNATURES_INVALIDATED'));
  assert.equal(codes(convertCard(fixture('cards/v03-signed.json'), '0.3')).includes('SIGNATURES_INVALIDATED'), false);
});

test('rewriteUrl points every endpoint at the proxy and lists both versions', () => {
  const r = convertCard(fixture('cards/v03-native.json'), '1.0', { rewriteUrl: 'http://127.0.0.1:8787/a2a/jsonrpc' });
  assert.deepEqual((r.card as any).supportedInterfaces, [
    { url: 'http://127.0.0.1:8787/a2a/jsonrpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    { url: 'http://127.0.0.1:8787/a2a/jsonrpc', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
  ]);
  assert.equal(validateCard(r.card).v10.valid, true);
  const h = convertCard(fixture('cards/v1-strict.json'), 'hybrid', { rewriteUrl: 'http://127.0.0.1:8787/a2a/jsonrpc' });
  assert.equal((h.card as any).url, 'http://127.0.0.1:8787/a2a/jsonrpc');
  assert.equal(codes(h).includes('NO_V03_INTERFACE'), false);
});

test('not a card -> TranslationError', () => {
  assert.throws(() => convertCard(fixture('cards/empty.json'), '1.0'), TranslationError);
  assert.throws(() => convertCard('nope', '0.3'), TranslationError);
});
