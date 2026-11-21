// Regenerates test/fixtures/sdk/ and the SDK-derived cards in test/fixtures/cards/ from the official
// @a2a-js/sdk 1.3.0 and 0.3.14 (devDependencies). Run after bumping either SDK and review the diff:
//   npm run capture-fixtures
// Everything runs on localhost; nothing is downloaded.
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v1 from 'a2a-v1';
import * as v1c from 'a2a-v1/client';
import * as o3c from 'a2a-v03/client';
import { startSdkServers } from '../test/helpers/sdk-servers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sdkDir = join(root, 'test', 'fixtures', 'sdk');
const cardDir = join(root, 'test', 'fixtures', 'cards');
mkdirSync(sdkDir, { recursive: true });
mkdirSync(cardDir, { recursive: true });
const save = (dir, name, data) => writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`);
const STABLE = 'https://agent.example.com';

/** Replace the random localhost origin with a stable one so card fixtures do not churn. */
function stableUrls(value, origin) {
  return JSON.parse(JSON.stringify(value).split(origin).join(STABLE));
}

async function rpc(url, method, params, header, accept = 'application/json') {
  const headers = { 'content-type': 'application/json', accept };
  if (header) headers['A2A-Version'] = header;
  const res = await fetch(`${url}/a2a/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await res.text();
  if (accept === 'text/event-stream') {
    return text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  }
  return JSON.parse(text);
}

async function card(url, header) {
  const res = await fetch(`${url}/.well-known/agent-card.json`, { headers: header ? { 'A2A-Version': header } : {} });
  return res.json();
}

/** A tiny recorder that serves a card and records what an official client POSTs. */
async function recordClient(cardFor, reply, run) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(cardFor(`http://127.0.0.1:${server.address().port}`)));
        return;
      }
      const parsed = JSON.parse(body);
      seen.push({ headers: { 'a2a-version': req.headers['a2a-version'] ?? null, 'content-type': req.headers['content-type'] }, body: parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: reply }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  return seen[0];
}

// --- 1. what official clients send ---
const v03Reply = { kind: 'task', id: 't-1', contextId: 'c-1', status: { state: 'completed' } };
const v1Reply = { task: { id: 't-1', contextId: 'c-1', status: { state: 'TASK_STATE_COMPLETED' } } };

const fromV03Client = await recordClient(
  (u) => ({ name: 'rec', description: 'rec', version: '1', protocolVersion: '0.3.0', url: `${u}/rpc`, preferredTransport: 'JSONRPC', capabilities: {}, defaultInputModes: ['text'], defaultOutputModes: ['text'], skills: [] }),
  v03Reply,
  async (u) => {
    const client = await new o3c.ClientFactory().createFromUrl(u);
    await client.sendMessage({
      message: { kind: 'message', role: 'user', messageId: 'fx-1', parts: [{ kind: 'text', text: 'hi' }] },
      configuration: { blocking: true, acceptedOutputModes: ['text'] },
    });
  },
);
save(sdkDir, 'client-v03.message-send.request.json', fromV03Client);

const fromV1Client = await recordClient(
  (u) => ({ name: 'rec', description: 'rec', version: '1', supportedInterfaces: [{ url: `${u}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], capabilities: {}, defaultInputModes: ['text'], defaultOutputModes: ['text'], skills: [] }),
  v1Reply,
  async (u) => {
    const client = await new v1c.ClientFactory().createFromUrl(u);
    await client.sendMessage({
      message: {
        role: v1.Role.ROLE_USER,
        messageId: 'fx-1',
        parts: [{ content: { $case: 'text', value: 'hi' }, metadata: undefined, filename: '', mediaType: '' }],
        contextId: '',
        taskId: '',
        extensions: [],
        metadata: undefined,
        referenceTaskIds: [],
      },
      configuration: { acceptedOutputModes: ['text'], taskPushNotificationConfig: undefined, historyLength: undefined, returnImmediately: false },
      metadata: undefined,
      tenant: '',
    });
  },
);
save(sdkDir, 'client-v1.send-message.request.json', fromV1Client);

// --- 2. official servers ---
const servers = await startSdkServers();
try {
  const compat = servers['v1-compat'].url;
  const msg1 = { message: { role: 'ROLE_USER', messageId: 'fx-2', parts: [{ text: 'hi' }] } };
  const msg03 = { message: { kind: 'message', role: 'user', messageId: 'fx-3', parts: [{ kind: 'text', text: 'hi' }] } };

  // Same task read through both dialects of one compat server = an exact 0.3/1.0 pair from the official translator.
  const sent = await rpc(compat, 'SendMessage', msg1, '1.0');
  save(sdkDir, 'p2.send-message.v1.response.json', sent);
  const taskId = sent.result.task.id;
  save(sdkDir, 'p2.get-task.v1.response.json', await rpc(compat, 'GetTask', { id: taskId }, '1.0'));
  save(sdkDir, 'p2.get-task.v03.response.json', await rpc(compat, 'tasks/get', { id: taskId }, null));
  save(sdkDir, 'p2.message-send.v03.response.json', await rpc(compat, 'message/send', msg03, null));

  save(sdkDir, 'p2.stream.v1.events.json', await rpc(compat, 'SendStreamingMessage', msg1, '1.0', 'text/event-stream'));
  save(sdkDir, 'p2.stream.v03.events.json', await rpc(compat, 'message/stream', msg03, null, 'text/event-stream'));
  save(sdkDir, 'p3.stream.v03.events.json', await rpc(servers['v0.3'].url, 'message/stream', msg03, null, 'text/event-stream'));

  save(sdkDir, 'errors.json', {
    'v1-strict SendMessage no header': await rpc(servers['v1-strict'].url, 'SendMessage', msg1, null),
    'v1-compat SendMessage no header': await rpc(compat, 'SendMessage', msg1, null),
    'v1-strict GetTask unknown id': await rpc(servers['v1-strict'].url, 'GetTask', { id: 'does-not-exist' }, '1.0'),
    'v0.3 tasks/get unknown id': await rpc(servers['v0.3'].url, 'tasks/get', { id: 'does-not-exist' }, null),
    'v0.3 ListTasks': await rpc(servers['v0.3'].url, 'ListTasks', {}, '1.0'),
  });

  // Cards (with stable URLs) for the card tests and README examples.
  save(cardDir, 'v1-strict.json', stableUrls(await card(servers['v1-strict'].url, '1.0'), servers['v1-strict'].url));
  save(cardDir, 'hybrid.json', stableUrls(await card(compat, null), compat));
  save(cardDir, 'v1-compat.json', stableUrls(await card(compat, '1.0'), compat));
  save(cardDir, 'v03-native.json', stableUrls(await card(servers['v0.3'].url, null), servers['v0.3'].url));
} finally {
  await servers.close();
}
console.log('fixtures written to test/fixtures/sdk and test/fixtures/cards');
