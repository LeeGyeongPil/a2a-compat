// 번역 프록시: 고칠 수 없는 에이전트 앞에 서서 0.3 <-> 1.0 JSON-RPC 와 SSE 를 양방향 번역한다.
//
// 요청 하나의 흐름 (위에서 아래로):
//   1. 클라이언트 버전 판별: A2A-Version 헤더 1.0 -> 1.0, 없음 -> 0.3(규격 §3.6.2), 그 밖 -> -32009
//   2. 업스트림이 그 버전을 말하면 그대로 전달(passthrough), 아니면 요청을 번역
//   3. 응답이 SSE 면 이벤트마다, JSON 이면 한 번 번역해 돌려준다
//   4. 대응이 없는 기능(ListTasks, 푸시 설정 등)은 조용히 통과시키지 않고 -32004 + 이유로 거부
//
// 보안: 기본 127.0.0.1 바인딩, 업스트림은 시작할 때 고정(요청이 대상을 바꿀 수 없음),
//       헤더·본문은 logBodies 를 켜지 않는 한 기록하지 않는다.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { UnsupportedOperationError } from '../errors.js';
import { jsonRpcUrl, versionFamily } from '../card/detect.js';
import { CODE, errorBodyV1 } from '../rules/errors.js';
import { isV03Method, isV1Method, unsupportedKind } from '../rules/methods.js';
import { translateEventData } from '../translate/event.js';
import { requestToV03, requestToV1 } from '../translate/request.js';
import { responseToV03, responseToV1 } from '../translate/response.js';
import { isObj, type Obj } from '../translate/util.js';
import { cardUrlFor, describeFetchError, UnreachableError } from '../check/probe.js';
import { proxyCard } from './card.js';
import { SseTranslator } from './sse.js';

export type ProtocolVersion = '0.3' | '1.0';

/**
 * 거부·오류 이벤트의 이유 코드. `message` 는 라이브러리 사용자를 위한 영어 문장이고,
 * CLI 는 이 코드로 각 언어 문장(i18n `proxy.reason.<code>`)을 고른다 — 영어 문장을 화면에 그대로 붙이지 않는다.
 */
export const PROXY_REASONS = [
  // 클라이언트 요청 문제 (reject)
  'body_too_large',
  'parse_error',
  'invalid_request',
  'batch_unsupported',
  'version_not_supported',
  'missing_version_header',
  'v03_method_with_v1_header',
  // 번역할 수 없는 기능 (reject, -32004)
  'v1_only_method',
  'not_translated',
  'unknown_method',
  // 업스트림·스트림 문제 (error)
  'upstream_failed',
  'upstream_timeout',
  'upstream_cut',
  'upstream_non_json',
  'upstream_not_jsonrpc',
  'stream_ended',
  'stream_idle_timeout',
  'client_closed',
  // 카드 (error)
  'card_failed',
  'card_timeout',
  'card_http',
  // 그 밖의 예외 (error)
  'internal',
] as const;

export type ProxyReason = (typeof PROXY_REASONS)[number];

export interface ProxyEvent {
  type: 'request' | 'response' | 'reject' | 'error' | 'card';
  clientVersion?: ProtocolVersion;
  method?: string;
  upstreamMethod?: string;
  translated?: boolean;
  /** 결과 모양 요약(예: kind:"task" -> task). */
  shape?: string;
  /** 스트림 응답이면 번역해 흘려보낸 SSE 이벤트 수. */
  events?: number;
  code?: number;
  /** 사람이 읽는 영어 설명(라이브러리용). 화면 문구는 reason 으로 고른다. */
  message?: string;
  /** reject·error 이벤트의 이유 코드. */
  reason?: ProxyReason;
  /** 이유에 덧붙는 기술 값(오류 코드 ECONNREFUSED, HTTP 상태, 초, 헤더 값 등). 번역 대상이 아니다. */
  detail?: string | number;
  inferred?: boolean;
  body?: unknown;
}

export interface ProxyOptions {
  /** 업스트림 에이전트 주소(기본 주소 또는 카드 주소). */
  upstream: string;
  /** auto = 업스트림 카드로 판별. */
  upstreamVersion?: 'auto' | ProtocolVersion;
  /** 헤더 없이 1.0 메서드 이름이 오면 1.0 으로 추론해 받아 준다. */
  inferVersion?: boolean;
  host?: string;
  port?: number;
  /** Address clients use to reach the proxy; written into the translated card (default: the bound address). */
  publicUrl?: string;
  /** 단건 요청의 업스트림 응답 대기 시간(ms). 실제 에이전트는 LLM 을 부르므로 넉넉히. */
  timeoutMs?: number;
  /** 스트림에서 이 시간 동안 아무 바이트도 오지 않으면 끊는다(ms). */
  idleTimeoutMs?: number;
  /** 업스트림에 덧붙일 헤더(예: Authorization). 값은 기록하지 않는다. */
  headers?: Record<string, string>;
  onEvent?: (e: ProxyEvent) => void;
  /** 요청·응답 본문을 onEvent 로 넘긴다(기본 끔). */
  logBodies?: boolean;
}

export interface ProxyHandle {
  server: http.Server;
  /** 프록시 기본 주소. 클라이언트는 이 주소를 에이전트 주소로 쓴다(--public-url 이 있으면 그 값). */
  url: string;
  /** 실제로 바인딩한 주소(http://host:port). publicUrl 이 없으면 url 과 같다. */
  listenUrl: string;
  /** 업스트림이 말하는 버전들. */
  upstreamVersions: ProtocolVersion[];
  upstreamEndpoints: Partial<Record<ProtocolVersion, string>>;
  close(): Promise<void>;
}

const RPC_PATH = '/a2a/jsonrpc';
const CARD_PATH = '/.well-known/agent-card.json';
const MAX_BODY = 10 * 1024 * 1024;
const CARD_TTL_MS = 30_000;
// 클라이언트 헤더 중 업스트림에 넘기지 않는 것(연결 단위 헤더, 프록시가 다시 정하는 것)
const DROP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'content-length', 'accept-encoding', 'a2a-version', 'a2a-extensions', 'x-a2a-extensions',
]);

type Json = Obj;

/** 업스트림 카드를 헤더 없이·1.0 으로 받아 말하는 버전과 엔드포인트를 정한다. */
async function discoverUpstream(opts: ProxyOptions) {
  const cardUrl = cardUrlFor(opts.upstream);
  let lastError = 'unknown error'; // 카드를 못 읽었을 때 알려 줄 기술 값(ECONNREFUSED, HTTP 404 등)
  const get = async (header: string | null) => {
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
    if (header) headers['A2A-Version'] = header;
    try {
      const res = await fetch(cardUrl, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        return undefined;
      }
      return (await res.json()) as unknown;
    } catch (e) {
      lastError = e instanceof SyntaxError ? 'response is not JSON' : describeFetchError(e);
      return undefined;
    }
  };
  const card10 = await get('1.0');
  const card03 = await get(null);
  if (card10 === undefined && card03 === undefined) {
    throw new UnreachableError(`Could not read the upstream agent card at ${cardUrl}: ${lastError}`, cardUrl, lastError);
  }
  // 카드는 읽었는데 JSON-RPC 주소가 없음 (REST·gRPC 만 있는 카드)
  const noEndpoint = () =>
    new UnreachableError('The upstream card lists no JSON-RPC endpoint (REST/gRPC are not proxied in M1).', cardUrl, undefined, 'no_jsonrpc_endpoint');
  const endpoints: Partial<Record<ProtocolVersion, string>> = {};
  const v1 = jsonRpcUrl(card10, '1.0') ?? jsonRpcUrl(card03, '1.0');
  const v03 = jsonRpcUrl(card03, '0.3') ?? jsonRpcUrl(card10, '0.3');
  if (v1) endpoints['1.0'] = v1;
  if (v03) endpoints['0.3'] = v03;
  const forced = opts.upstreamVersion && opts.upstreamVersion !== 'auto' ? opts.upstreamVersion : undefined;
  if (forced) {
    // 강제 지정: 그 버전 엔드포인트가 없으면 아는 아무 주소나 쓴다.
    const url = endpoints[forced] ?? v1 ?? v03;
    if (!url) throw noEndpoint();
    return { cardUrl, endpoints: { [forced]: url } as Partial<Record<ProtocolVersion, string>>, card: card10 ?? card03 };
  }
  if (!v1 && !v03) throw noEndpoint();
  return { cardUrl, endpoints, card: endpoints['1.0'] ? (card10 ?? card03) : (card03 ?? card10) };
}

/** 업스트림 카드 요청이 HTTP 오류 상태로 끝남. */
class CardHttpError extends Error {
  constructor(readonly status: number) {
    super(`upstream card HTTP ${status}`);
  }
}

/** 클라이언트 버전에 맞는 오류 본문(1.0 은 ErrorInfo 포함). */
function errorFor(version: ProtocolVersion, id: unknown, code: number, message: string): Json {
  const error = version === '1.0' ? errorBodyV1(code, message) : { code, message };
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 결과 모양을 한 단어로 요약(로그용). */
function shapeOf(result: unknown): string | undefined {
  if (!isObj(result)) return undefined;
  if (typeof result.kind === 'string') return `kind:"${result.kind}"`;
  const key = ['task', 'message', 'statusUpdate', 'artifactUpdate'].find((k) => k in result);
  return key ?? (('status' in result && 'id' in result) ? 'Task' : undefined);
}

export async function createProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const up = await discoverUpstream(opts);
  const upstreamVersions = (Object.keys(up.endpoints) as ProtocolVersion[]).sort().reverse();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 300_000;
  const emit = (e: ProxyEvent) => opts.onEvent?.(e);
  const active = new Set<AbortController>(); // 종료할 때 진행 중인 업스트림 요청을 모두 끊는다
  let baseUrl = '';

  // 업스트림 카드 캐시: 항목 하나, 30초 TTL (상한 없는 캐시를 만들지 않는다)
  let cardCache: { at: number; card: unknown } = { at: Date.now(), card: up.card };
  async function upstreamCard(): Promise<unknown> {
    if (Date.now() - cardCache.at < CARD_TTL_MS) return cardCache.card;
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
    if (up.endpoints['1.0']) headers['A2A-Version'] = '1.0';
    const res = await fetch(up.cardUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new CardHttpError(res.status);
    cardCache = { at: Date.now(), card: await res.json() };
    return cardCache.card;
  }

  async function handleCard(req: http.IncomingMessage, res: http.ServerResponse) {
    const clientVersion = versionFamily(req.headers['a2a-version']) === '1.0' ? '1.0' : '0.3';
    try {
      const { card, warnings } = proxyCard(await upstreamCard(), clientVersion, baseUrl + RPC_PATH);
      emit({ type: 'card', clientVersion, message: warnings.map((w) => w.code).join(',') });
      sendJson(res, 200, card, { vary: 'A2A-Version' });
    } catch (e) {
      // 이유 코드: HTTP 상태 오류 / 시간 초과 / 그 밖의 연결 실패
      const why: { reason: ProxyReason; detail: string | number } =
        e instanceof CardHttpError
          ? { reason: 'card_http', detail: e.status }
          : (e as Error)?.name === 'TimeoutError'
            ? { reason: 'card_timeout', detail: Math.round(timeoutMs / 1000) }
            : { reason: 'card_failed', detail: describeFetchError(e) };
      emit({ type: 'error', ...why, message: `card: ${describeFetchError(e)}` });
      sendJson(res, 502, { error: `a2a-compat could not read the upstream agent card: ${describeFetchError(e)}` });
    }
  }

  /** 업스트림으로 보낼 헤더: 클라이언트 헤더(인증 등)를 넘기되 버전·확장 헤더는 대상 버전 이름으로. */
  function upstreamHeaders(req: http.IncomingMessage, target: ProtocolVersion): Record<string, string> {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (DROP_HEADERS.has(k) || v === undefined) continue;
      h[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const ext = req.headers['a2a-extensions'] ?? req.headers['x-a2a-extensions'];
    if (ext) h[target === '1.0' ? 'A2A-Extensions' : 'X-A2A-Extensions'] = Array.isArray(ext) ? ext.join(', ') : ext;
    h['content-type'] = 'application/json';
    h.accept = 'application/json, text/event-stream';
    if (target === '1.0') h['A2A-Version'] = '1.0';
    return { ...h, ...(opts.headers ?? {}) };
  }

  async function handleRpc(req: http.IncomingMessage, res: http.ServerResponse) {
    // 1. 클라이언트 버전 판별
    const rawHeader = req.headers['a2a-version'];
    const header = typeof rawHeader === 'string' && rawHeader.trim() !== '' ? rawHeader.trim() : undefined;
    let clientVersion: ProtocolVersion | undefined = header === undefined ? '0.3' : versionFamily(header);

    let raw: string;
    try {
      raw = await readBody(req);
    } catch (e) {
      const message = String((e as Error).message);
      emit({ type: 'reject', clientVersion, code: CODE.INVALID_REQUEST, reason: 'body_too_large', detail: MAX_BODY, message });
      sendJson(res, 413, errorFor(clientVersion ?? '1.0', null, CODE.INVALID_REQUEST, message));
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      emit({ type: 'reject', clientVersion, code: CODE.PARSE_ERROR, reason: 'parse_error', message: 'Parse error' });
      sendJson(res, 200, errorFor(clientVersion ?? '1.0', null, CODE.PARSE_ERROR, 'Parse error'));
      return;
    }
    if (!isObj(body) || typeof body.method !== 'string') {
      const batch = Array.isArray(body);
      const msg = batch ? 'Batch requests are not supported by a2a-compat.' : 'Invalid Request';
      emit({ type: 'reject', clientVersion, code: CODE.INVALID_REQUEST, reason: batch ? 'batch_unsupported' : 'invalid_request', message: msg });
      sendJson(res, 200, errorFor(clientVersion ?? '1.0', null, CODE.INVALID_REQUEST, msg));
      return;
    }
    const id = body.id ?? null;
    const method = body.method;

    if (clientVersion === undefined) {
      emit({ type: 'reject', method, code: CODE.VERSION_NOT_SUPPORTED, reason: 'version_not_supported', detail: header });
      sendJson(res, 200, errorFor('1.0', id, CODE.VERSION_NOT_SUPPORTED, `The requested A2A protocol version '${header}' is not supported. Supported versions: 1.0, 0.3`));
      return;
    }

    // 헤더 없이 1.0 메서드 이름 -> 규격상 0.3 요청. 기본은 원인을 알려 주며 거부, --infer-version 이면 1.0 으로 받는다.
    let inferred = false;
    if (clientVersion === '0.3' && isV1Method(method) && !isV03Method(method)) {
      if (opts.inferVersion) {
        clientVersion = '1.0';
        inferred = true;
      } else {
        const message =
          `Method not found: ${method}. a2a-compat: this is an A2A 1.0 method but the request had no A2A-Version header, ` +
          'so it was treated as A2A 0.3 (spec section 3.6.2). Send "A2A-Version: 1.0" or start the proxy with --infer-version.';
        emit({ type: 'reject', clientVersion, method, code: CODE.METHOD_NOT_FOUND, reason: 'missing_version_header', message: 'missing A2A-Version header' });
        sendJson(res, 200, errorFor('0.3', id, CODE.METHOD_NOT_FOUND, message));
        return;
      }
    }
    if (clientVersion === '1.0' && isV03Method(method) && !isV1Method(method)) {
      const message = `Invalid method. a2a-compat: "${method}" is an A2A 0.3 method but the request declared A2A-Version: 1.0.`;
      emit({ type: 'reject', clientVersion, method, code: CODE.METHOD_NOT_FOUND, reason: 'v03_method_with_v1_header', message });
      sendJson(res, 200, errorFor('1.0', id, CODE.METHOD_NOT_FOUND, message));
      return;
    }

    // 2. 대상 버전과 요청 번역
    const target: ProtocolVersion = up.endpoints[clientVersion] ? clientVersion : clientVersion === '1.0' ? '0.3' : '1.0';
    const translate = target !== clientVersion;
    let outgoing: Json = body;
    if (translate) {
      try {
        outgoing = target === '0.3' ? requestToV03(body) : requestToV1(body);
      } catch (e) {
        if (e instanceof UnsupportedOperationError) {
          // message(영어)는 와이어 오류 본문 그대로, 화면 로그는 reason 으로 각 언어 문장을 고른다
          emit({ type: 'reject', clientVersion, method, code: e.code, reason: unsupportedKind(method), message: e.message });
          sendJson(res, 200, errorFor(clientVersion, id, e.code, e.message));
          return;
        }
        throw e;
      }
    }
    const upstreamMethod = String(outgoing.method);
    emit({ type: 'request', clientVersion, method, upstreamMethod, translated: translate, inferred, ...(opts.logBodies ? { body } : {}) });

    // 3. 업스트림 호출 (클라이언트가 끊으면 업스트림도 끊는다)
    const ac = new AbortController();
    active.add(ac);
    // 왜 끊었는지 기억해 둔다(시간 초과·클라이언트 종료). 로그의 이유 코드가 된다.
    let abortWhy: { reason: ProxyReason; detail?: number } | undefined;
    const abortFor = (reason: ProxyReason, detail?: number) => {
      abortWhy ??= { reason, detail };
      ac.abort();
    };
    const onClientClose = () => {
      if (!res.writableFinished) abortFor('client_closed');
    };
    res.on('close', onClientClose);
    let timer: NodeJS.Timeout | undefined = setTimeout(() => abortFor('upstream_timeout', Math.round(timeoutMs / 1000)), timeoutMs);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      active.delete(ac);
      res.off('close', onClientClose);
    };

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(up.endpoints[target]!, {
        method: 'POST',
        headers: upstreamHeaders(req, target),
        body: JSON.stringify(outgoing),
        signal: ac.signal,
      });
    } catch (e) {
      cleanup();
      const why = abortWhy ?? { reason: 'upstream_failed' as const, detail: describeFetchError(e) };
      const reason =
        why.reason === 'upstream_timeout' ? `upstream did not answer within ${why.detail}s` : why.reason === 'client_closed' ? 'client closed the connection' : describeFetchError(e);
      emit({ type: 'error', clientVersion, method, code: CODE.INTERNAL_ERROR, ...why, message: reason });
      sendJson(res, 200, errorFor(clientVersion, id, CODE.INTERNAL_ERROR, `a2a-compat: upstream request failed: ${reason}`));
      return;
    }

    const contentType = upstreamRes.headers.get('content-type') ?? '';
    const ctxMethod = method; // 응답 모양은 원 요청 메서드로 정한다

    // 4a. SSE: 이벤트마다 번역해 바로 흘려보낸다.
    if (contentType.includes('text/event-stream') && upstreamRes.body) {
      res.writeHead(upstreamRes.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const direction = clientVersion === '1.0' ? 'toV1' : 'toV03';
      const sse = new SseTranslator((data) => (translate ? translateEventData(data, direction, ctxMethod) : data));
      const decoder = new TextDecoder();
      const resetIdle = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => abortFor('stream_idle_timeout', Math.round(idleTimeoutMs / 1000)), idleTimeoutMs);
      };
      resetIdle();
      let events = 0;
      try {
        for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
          resetIdle();
          const out = sse.push(decoder.decode(chunk, { stream: true }));
          if (out) {
            events += (out.match(/\n\n/g) ?? []).length; // 이벤트 경계(빈 줄) 수 = 번역된 이벤트 수
            res.write(out);
          }
        }
        const tail = sse.end();
        if (tail) res.write(tail);
        emit({ type: 'response', clientVersion, method, translated: translate, events, shape: `stream (${events} event${events === 1 ? '' : 's'})` });
      } catch (e) {
        // 업스트림이 중간에 끊겨도 프록시는 살아 있고, 클라이언트 스트림만 닫는다.
        const why = abortWhy ?? { reason: 'stream_ended' as const, detail: describeFetchError(e) };
        emit({ type: 'error', clientVersion, method, ...why, message: `stream ended early: ${why.reason === 'stream_ended' ? why.detail : why.reason}` });
      } finally {
        cleanup();
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // 4b. 단건 JSON
    let text: string;
    try {
      text = await upstreamRes.text();
    } catch (e) {
      cleanup();
      const why = abortWhy ?? { reason: 'upstream_cut' as const, detail: describeFetchError(e) };
      emit({ type: 'error', clientVersion, method, code: CODE.INTERNAL_ERROR, ...why, message: `upstream response was cut off: ${describeFetchError(e)}` });
      sendJson(res, 200, errorFor(clientVersion, id, CODE.INTERNAL_ERROR, `a2a-compat: upstream response was cut off: ${describeFetchError(e)}`));
      return;
    }
    cleanup();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      emit({ type: 'error', clientVersion, method, code: CODE.INTERNAL_ERROR, reason: 'upstream_non_json', detail: upstreamRes.status, message: 'upstream returned non-JSON' });
      sendJson(res, 200, errorFor(clientVersion, id, CODE.INTERNAL_ERROR, `a2a-compat: upstream returned a non-JSON response (HTTP ${upstreamRes.status}).`));
      return;
    }
    if (!isObj(parsed)) {
      emit({ type: 'error', clientVersion, method, code: CODE.INTERNAL_ERROR, reason: 'upstream_not_jsonrpc', message: 'upstream returned JSON that is not a JSON-RPC response' });
      sendJson(res, 200, errorFor(clientVersion, id, CODE.INTERNAL_ERROR, 'a2a-compat: upstream returned JSON that is not a JSON-RPC response.'));
      return;
    }
    const before = shapeOf(parsed.result);
    const out = translate ? (clientVersion === '1.0' ? responseToV1(parsed, ctxMethod) : responseToV03(parsed, ctxMethod)) : parsed;
    const after = shapeOf(out.result);
    const err = isObj(out.error) ? out.error : undefined;
    emit({
      type: 'response',
      clientVersion,
      method,
      translated: translate,
      shape: before && after && before !== after ? `${before} -> ${after}` : after,
      code: typeof err?.code === 'number' ? err.code : undefined,
      ...(opts.logBodies ? { body: out } : {}),
    });
    sendJson(res, 200, out);
  }

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const run = async () => {
      if (req.method === 'GET' && path === CARD_PATH) return handleCard(req, res);
      if (req.method === 'POST') return handleRpc(req, res);
      sendJson(res, 404, { error: 'not found' });
    };
    run().catch((e) => {
      // 어떤 예외도 프로세스를 죽이지 않는다.
      const message = String((e as Error)?.message ?? e);
      emit({ type: 'error', reason: 'internal', detail: message, message });
      if (!res.headersSent) sendJson(res, 200, errorFor('1.0', null, CODE.INTERNAL_ERROR, 'a2a-compat internal error'));
      else if (!res.writableEnded) res.end();
    });
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const listenUrl = `http://${shownHost}:${addr.port}`;
  baseUrl = opts.publicUrl ? opts.publicUrl.replace(/\/+$/, '') : listenUrl;

  return {
    server,
    url: baseUrl,
    listenUrl,
    upstreamVersions,
    upstreamEndpoints: up.endpoints,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ac of active) ac.abort();
        active.clear();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

