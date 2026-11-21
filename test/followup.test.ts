// Follow-ups from QA: test runner on Node 20, EPIPE, directory input, shared footnotes, --public-url, SSE event count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/common.js';
import { convertCard, createProxy, startMockAgent } from '../src/index.js';

const EN = { A2A_COMPAT_LANG: 'en' };

test('card validate on a directory says it is a directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-compat-dir-'));
  try {
    const r = await runCli(['card', 'validate', dir], EN);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /is a directory/);
    assert.doesNotMatch(r.stderr, /file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('matrix rows with the same cause share one footnote', async () => {
  const r = await runCli(['check', '--mock', 'v0.3'], EN);
  assert.equal(r.code, 0, r.stderr);
  const notes = r.stdout.split('\n').filter((l) => /^\s+\[\d\] The/.test(l));
  assert.equal(notes.length, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /\[3\]/);
});

test('--rewrite-url keeps the PROTOCOL_VERSION_PATCH warning', () => {
  const card = { name: 'x', description: 'x', version: '1', url: 'http://a/', protocolVersion: '0.3.0', preferredTransport: 'JSONRPC', capabilities: {}, defaultInputModes: ['text'], defaultOutputModes: ['text'], skills: [] };
  const withRw = convertCard(card, 'hybrid', { rewriteUrl: 'http://127.0.0.1:8787' });
  assert.ok(withRw.warnings.some((w) => w.code === 'PROTOCOL_VERSION_PATCH'));
  const to03 = convertCard(card, '0.3', { rewriteUrl: 'http://127.0.0.1:8787' });
  assert.ok(to03.warnings.some((w) => w.code === 'PROTOCOL_VERSION_PATCH'));
});

test('proxy --public-url is written into the translated card', async () => {
  const mock = await startMockAgent('v0.3');
  const proxy = await createProxy({ upstream: mock.url, host: '127.0.0.1', port: 0, publicUrl: 'https://agents.example.test/' });
  try {
    const port = (proxy.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } });
    const card = (await res.json()) as { supportedInterfaces: { url: string }[] };
    assert.ok(card.supportedInterfaces.every((i) => i.url.startsWith('https://agents.example.test/')), JSON.stringify(card.supportedInterfaces));
    assert.ok(!card.supportedInterfaces.some((i) => i.url.includes('//agents.example.test//')));
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test('proxy rejects a malformed --public-url with exit 2', async () => {
  const r = await runCli(['proxy', '--mock-upstream', 'v0.3', '--public-url', 'nope'], EN);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--public-url/);
});

test('streaming log counts translated events, not transport chunks', async () => {
  const mock = await startMockAgent('v0.3');
  const shapes: string[] = [];
  const proxy = await createProxy({ upstream: mock.url, onEvent: (e) => { if (e.type === 'response' && e.shape) shapes.push(e.shape); } });
  try {
    const res = await fetch(`${proxy.url}/a2a/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage', params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] } } }),
    });
    await res.text();
    assert.ok(shapes.some((s) => s === 'stream (3 events)'), shapes.join(' | '));
  } finally {
    await proxy.close();
    await mock.close();
  }
});
