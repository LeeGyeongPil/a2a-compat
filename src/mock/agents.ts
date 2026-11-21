// 연습용 목(mock) 에이전트 3종 — echo 만 하는 실제 HTTP 서버다.
// 와이어 동작(카드 모양, A2A-Version 헤더 해석, 오류 코드·문구)은 공식 SDK 1.3.0 / 0.3.14 서버를
// 프로브로 측정한 값을 따른다. 번역기를 쓰지 않고 0.3·1.0 모양을 각각 손으로 만든다
// (번역기를 검증하는 상대가 번역기에 기대면 버그가 서로 가려지기 때문).
//
//   v0.3      : 0.3 원본 서버. A2A-Version 헤더를 무시한다.
//   v1-strict : 1.0 엄격 서버. 헤더가 없으면 0.3 요청으로 보고 -32009 로 거부한다.
//   v1-compat : 1.0 + 0.3 호환. 헤더가 없으면 0.3 디스패처로 보낸다(그래서 헤더 빠진 SendMessage 는 -32601).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { errorBodyV1 } from '../rules/errors.js';
import { versionFamily } from '../card/detect.js';

export type MockKind = 'v0.3' | 'v1-strict' | 'v1-compat';
export const MOCK_KINDS: MockKind[] = ['v0.3', 'v1-strict', 'v1-compat'];

export interface MockAgent {
  kind: MockKind;
  /** 에이전트 기본 주소(카드는 `${url}/.well-known/agent-card.json`). */
  url: string;
  /** 지금까지 만든 작업 수. check 탐침이 작업을 만들지 않는지 확인할 때 쓴다. */
  taskCount(): number;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;
interface StoredTask {
  id: string;
  contextId: string;
  messageId: string;
  text: string;
}

const MAX_TASKS = 1000; // 연습용 저장소 상한(오래된 것부터 지움)
const MAX_BODY = 1024 * 1024;
const RPC_PATH = '/a2a/jsonrpc';
const CARD_PATH = '/.well-known/agent-card.json';

// ---------- 카드 ----------

const SKILL_V03 = { id: 'echo', name: 'Echo', description: 'Echoes your text back (practice mock).', tags: ['practice'] };

function cardV03(rpcUrl: string): Json {
  return {
    name: 'practice-v03-agent',
    description: 'Practice mock agent that speaks only A2A 0.3 (echo).',
    version: '1.0.0',
    protocolVersion: '0.3.0',
    url: rpcUrl,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [SKILL_V03],
  };
}

function cardV1(rpcUrl: string, withLegacy: boolean): Json {
  const interfaces: Json[] = [{ url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }];
  if (withLegacy) interfaces.push({ url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '0.3' });
  return {
    name: withLegacy ? 'practice-v1-compat-agent' : 'practice-v1-strict-agent',
    description: withLegacy ? 'Practice mock agent: A2A 1.0 with 0.3 compatibility (echo).' : 'Practice mock agent: strict A2A 1.0 (echo).',
    version: '1.0.0',
    supportedInterfaces: interfaces,
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [{ ...SKILL_V03 }],
  };
}

/** 공식 SDK 호환 모드가 헤더 없는 요청에 주는 이중 카드와 같은 모양. */
function cardHybrid(rpcUrl: string): Json {
  return {
    name: 'practice-v1-compat-agent',
    description: 'Practice mock agent: A2A 1.0 with 0.3 compatibility (echo).',
    version: '1.0.0',
    url: rpcUrl,
    preferredTransport: 'JSONRPC',
    protocolVersion: '0.3',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [SKILL_V03],
    supportsAuthenticatedExtendedCard: false,
    supportedInterfaces: [
      { url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ],
  };
}

// ---------- 작업 모양 (0.3 / 1.0 을 각각 직접 만든다) ----------

function taskV03(t: StoredTask, state: string, withArtifact = true): Json {
  const out: Json = {
    kind: 'task',
    id: t.id,
    contextId: t.contextId,
    status: { state, timestamp: new Date().toISOString() },
    history: [{ kind: 'message', role: 'user', messageId: t.messageId, parts: [{ kind: 'text', text: t.text }], contextId: t.contextId, taskId: t.id }],
  };
  if (withArtifact) out.artifacts = [{ artifactId: 'echo', name: 'echo', parts: [{ kind: 'text', text: `echo: ${t.text}` }] }];
  return out;
}

function taskV1(t: StoredTask, state: string, withArtifact = true): Json {
  const out: Json = {
    id: t.id,
    contextId: t.contextId,
    status: { state, timestamp: new Date().toISOString() },
    history: [{ messageId: t.messageId, contextId: t.contextId, taskId: t.id, role: 'ROLE_USER', parts: [{ text: t.text }] }],
  };
  if (withArtifact) out.artifacts = [{ artifactId: 'echo', name: 'echo', parts: [{ text: `echo: ${t.text}` }] }];
  return out;
}

// ---------- 응답 도우미 ----------

type Reply = { kind: 'json'; body: Json } | { kind: 'sse'; events: Json[] };
const ok = (id: unknown, result: unknown): Reply => ({ kind: 'json', body: { jsonrpc: '2.0', id, result } });
const errV03 = (id: unknown, code: number, message: string): Reply => ({ kind: 'json', body: { jsonrpc: '2.0', id, error: { code, message } } });
const errV1 = (id: unknown, code: number, message: string): Reply => ({ kind: 'json', body: { jsonrpc: '2.0', id, error: errorBodyV1(code, message) } });
const sse = (id: unknown, results: unknown[]): Reply => ({ kind: 'sse', events: results.map((result) => ({ jsonrpc: '2.0', id, result })) });

/** 0.3 part 또는 1.0 part 에서 텍스트를 꺼낸다. */
function firstText(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const parts = (message as Json).parts;
  if (!Array.isArray(parts)) return undefined;
  for (const p of parts) if (p && typeof p === 'object' && typeof (p as Json).text === 'string') return (p as Json).text as string;
  return '';
}

class Store {
  private tasks = new Map<string, StoredTask>();
  created = 0;
  add(message: Json, text: string): StoredTask {
    const t: StoredTask = {
      id: randomUUID(),
      contextId: typeof message.contextId === 'string' && message.contextId ? message.contextId : randomUUID(),
      messageId: typeof message.messageId === 'string' ? message.messageId : randomUUID(),
      text,
    };
    this.tasks.set(t.id, t);
    this.created += 1;
    if (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value as string);
    return t;
  }
  get(id: unknown): StoredTask | undefined {
    return typeof id === 'string' ? this.tasks.get(id) : undefined;
  }
  all(): StoredTask[] {
    return [...this.tasks.values()];
  }
}

// ---------- 0.3 디스패처 ----------

function dispatchV03(store: Store, method: string, params: Json, id: unknown): Reply {
  switch (method) {
    case 'message/send':
    case 'message/stream': {
      const message = params.message as Json | undefined;
      const text = firstText(message);
      if (!message || text === undefined) return errV03(id, -32602, 'Invalid params: message with parts is required');
      const t = store.add(message, text);
      if (method === 'message/send') return ok(id, taskV03(t, 'completed'));
      return sse(id, [
        taskV03(t, 'working', false),
        { kind: 'artifact-update', taskId: t.id, contextId: t.contextId, artifact: { artifactId: 'echo', name: 'echo', parts: [{ kind: 'text', text: `echo: ${t.text}` }] }, lastChunk: true },
        { kind: 'status-update', taskId: t.id, contextId: t.contextId, status: { state: 'completed', timestamp: new Date().toISOString() }, final: true },
      ]);
    }
    case 'tasks/get': {
      const t = store.get(params.id);
      return t ? ok(id, taskV03(t, 'completed')) : errV03(id, -32001, 'Task not found');
    }
    case 'tasks/cancel': {
      const t = store.get(params.id);
      return t ? errV03(id, -32002, 'Task cannot be canceled') : errV03(id, -32001, 'Task not found');
    }
    case 'tasks/resubscribe': {
      const t = store.get(params.id);
      if (!t) return errV03(id, -32001, 'Task not found');
      return sse(id, [{ kind: 'status-update', taskId: t.id, contextId: t.contextId, status: { state: 'completed' }, final: true }]);
    }
    default:
      return errV03(id, -32601, `Method not found: ${method}`);
  }
}

// ---------- 1.0 디스패처 ----------

function dispatchV1(store: Store, method: string, params: Json, id: unknown): Reply {
  switch (method) {
    case 'SendMessage':
    case 'SendStreamingMessage': {
      const message = params.message as Json | undefined;
      const text = firstText(message);
      if (!message || text === undefined) return errV1(id, -32602, 'Invalid params: message with parts is required');
      const t = store.add(message, text);
      if (method === 'SendMessage') return ok(id, { task: taskV1(t, 'TASK_STATE_COMPLETED') });
      return sse(id, [
        { task: taskV1(t, 'TASK_STATE_WORKING', false) },
        { artifactUpdate: { taskId: t.id, contextId: t.contextId, artifact: { artifactId: 'echo', name: 'echo', parts: [{ text: `echo: ${t.text}` }] }, lastChunk: true } },
        { statusUpdate: { taskId: t.id, contextId: t.contextId, status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() } } },
      ]);
    }
    case 'GetTask': {
      const t = store.get(params.id);
      return t ? ok(id, taskV1(t, 'TASK_STATE_COMPLETED')) : errV1(id, -32001, 'Task not found');
    }
    case 'CancelTask': {
      const t = store.get(params.id);
      return t ? errV1(id, -32002, 'Task cannot be canceled') : errV1(id, -32001, 'Task not found');
    }
    case 'SubscribeToTask': {
      const t = store.get(params.id);
      if (!t) return errV1(id, -32001, 'Task not found');
      return sse(id, [{ statusUpdate: { taskId: t.id, contextId: t.contextId, status: { state: 'TASK_STATE_COMPLETED' } } }]);
    }
    case 'ListTasks': {
      const tasks = store.all().map((t) => taskV1(t, 'TASK_STATE_COMPLETED', false));
      return ok(id, { tasks, nextPageToken: '', pageSize: 50, totalSize: tasks.length });
    }
    default:
      return errV1(id, -32601, 'Invalid method.');
  }
}

// ---------- 서버 ----------

function sendReply(res: http.ServerResponse, reply: Reply): void {
  if (reply.kind === 'json') {
    // JSON-RPC 오류도 HTTP 200 (SDK 1.2.1 부터의 동작)
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const e of reply.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function versionNotSupported(id: unknown, requested: string, supported: string): Reply {
  return errV1(id, -32009, `The requested A2A protocol version '${requested}' is not supported. Supported versions: ${supported}`);
}

function route(kind: MockKind, store: Store, header: string | undefined, rpc: Json): Reply {
  const id = rpc.id ?? null;
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  const params = (rpc.params && typeof rpc.params === 'object' ? rpc.params : {}) as Json;
  if (kind === 'v0.3') return dispatchV03(store, method, params, id); // 헤더 무시

  // 헤더가 비어 있으면 규격(§3.6.2)대로 0.3 요청으로 본다.
  const requested = header && header.trim() !== '' ? header.trim() : '0.3';
  const fam = versionFamily(requested);
  if (fam === '1.0') return dispatchV1(store, method, params, id);
  if (kind === 'v1-compat' && fam === '0.3') return dispatchV03(store, method, params, id);
  return versionNotSupported(id, requested, kind === 'v1-compat' ? '1.0, 0.3' : '1.0');
}

export async function startMockAgent(kind: MockKind, opts: { port?: number; host?: string } = {}): Promise<MockAgent> {
  const store = new Store();
  const host = opts.host ?? '127.0.0.1';
  let baseUrl = '';

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const header = req.headers['a2a-version'] as string | undefined;

    if (req.method === 'GET' && path === CARD_PATH) {
      const rpcUrl = baseUrl + RPC_PATH;
      let card: Json;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (kind === 'v0.3') card = cardV03(rpcUrl);
      else if (kind === 'v1-strict') card = cardV1(rpcUrl, false);
      else {
        // 호환 모드만 헤더를 보고 카드 모양을 바꾼다.
        headers.vary = 'A2A-Version';
        card = versionFamily(header) === '1.0' ? cardV1(rpcUrl, true) : cardHybrid(rpcUrl);
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(card));
      return;
    }

    if (req.method === 'POST' && path === RPC_PATH) {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        let rpc: unknown;
        try {
          rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          sendReply(res, errV03(null, -32700, 'Parse error'));
          return;
        }
        if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) {
          sendReply(res, errV03(null, -32600, 'Invalid Request'));
          return;
        }
        sendReply(res, route(kind, store, header, rpc as Json));
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://${host}:${addr.port}`;

  return {
    kind,
    url: baseUrl,
    taskCount: () => store.created,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections(); // keep-alive 연결까지 정리
        server.close(() => resolve());
      }),
  };
}
