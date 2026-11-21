// check 의 네트워크 부분: 카드 2회 요청과 부작용 없는 메서드 탐침.
// 기본 탐침은 "존재하지 않는 작업 ID" 로 tasks/get · GetTask 를 부를 뿐이라 상대에 작업이 생기지 않는다.
import { randomUUID } from 'node:crypto';
import type { CardVersion } from '../card/detect.js';
import { detectCardVersion } from '../card/detect.js';
import { validateAgainst, type SchemaResult } from '../card/validate.js';

export interface ProbeOptions {
  timeoutMs: number;
  headers: Record<string, string>;
}

export interface CardFetch {
  /** 카드 요청에 붙인 A2A-Version 헤더 (없으면 null). */
  header: '1.0' | null;
  ok: boolean;
  status?: number;
  error?: string;
  vary: string | null;
  card?: unknown;
  detected: CardVersion;
  v03: SchemaResult;
  v10: SchemaResult;
}

export type ProbeId = 'v03_get' | 'v1_get' | 'v1_get_no_header' | 'v03_send' | 'v1_send';

export interface MethodProbe {
  id: ProbeId;
  method: string;
  header: '1.0' | null;
  url: string;
  /** recognized = 서버가 메서드를 알아들었다(성공 또는 TaskNotFound 같은 업무 오류). */
  outcome: 'recognized' | 'rejected' | 'transport_error';
  http?: number;
  code?: number;
  message?: string;
}

/** 이 코드들은 "메서드·버전을 못 알아들었다"는 뜻이다. 나머지 오류(-32001 등)는 알아들은 것. */
const REJECTION_CODES = new Set([-32700, -32600, -32601, -32009]);

/**
 * 에이전트 카드를 읽을 수 없거나(card_unreadable) 카드에 JSON-RPC 주소가 없을 때(no_jsonrpc_endpoint).
 * message 는 영어(라이브러리 규칙). CLI 는 kind·cardUrl·detail 로 각 언어 문장을 만든다.
 */
export class UnreachableError extends Error {
  constructor(
    message: string,
    readonly cardUrl?: string,
    /** 기술 값: ECONNREFUSED, HTTP 404, timed out 등. */
    readonly detail?: string,
    readonly kind: 'card_unreadable' | 'no_jsonrpc_endpoint' = 'card_unreadable',
  ) {
    super(message);
    this.name = 'UnreachableError';
  }
}

export function cardUrlFor(target: string): string {
  const t = target.trim();
  if (/\.json(\?.*)?$/.test(t)) return t; // 카드 주소를 직접 준 경우
  return `${t.replace(/\/+$/, '')}/.well-known/agent-card.json`;
}

const EMPTY: SchemaResult = { valid: false, errors: [], issues: [] };

export async function fetchCard(cardUrl: string, header: '1.0' | null, opts: ProbeOptions): Promise<CardFetch> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (header) headers['A2A-Version'] = header;
  let res: Response;
  try {
    res = await fetch(cardUrl, { headers, signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (e) {
    return { header, ok: false, error: describeFetchError(e), vary: null, detected: 'unknown', v03: EMPTY, v10: EMPTY };
  }
  const vary = res.headers.get('vary');
  const text = await res.text().catch(() => '');
  if (!res.ok) return { header, ok: false, status: res.status, error: `HTTP ${res.status}`, vary, detected: 'unknown', v03: EMPTY, v10: EMPTY };
  let card: unknown;
  try {
    card = JSON.parse(text);
  } catch {
    return { header, ok: false, status: res.status, error: 'response is not JSON', vary, detected: 'unknown', v03: EMPTY, v10: EMPTY };
  }
  return {
    header,
    ok: true,
    status: res.status,
    vary,
    card,
    detected: detectCardVersion(card),
    v03: validateAgainst(card, '0.3'),
    v10: validateAgainst(card, '1.0'),
  };
}

export function describeFetchError(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError') return 'timed out';
  return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
}

/** JSON-RPC 한 번 호출. 스트림 메서드는 쓰지 않으므로 본문을 통째로 읽는다. */
export async function callMethod(
  id: ProbeId,
  url: string,
  method: string,
  params: unknown,
  header: '1.0' | null,
  opts: ProbeOptions,
): Promise<MethodProbe> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', ...opts.headers };
  if (header) headers['A2A-Version'] = header;
  const base: MethodProbe = { id, method, header, url, outcome: 'transport_error' };
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: `a2a-compat-${id}`, method, params }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    return { ...base, message: describeFetchError(e) };
  }
  const text = await res.text().catch(() => '');
  let body: Record<string, unknown> | undefined;
  try {
    body = JSON.parse(text);
  } catch {
    // 스트림처럼 data: 줄로 온 경우 첫 줄만 본다.
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    try {
      body = line ? JSON.parse(line.slice(5)) : undefined;
    } catch {
      body = undefined;
    }
  }
  if (!body || typeof body !== 'object') return { ...base, http: res.status, message: `not a JSON-RPC response (HTTP ${res.status})` };
  // JSON-RPC 오류도 HTTP 200 으로 온다 -> HTTP 상태가 아니라 본문으로 판정한다.
  const error = body.error as { code?: unknown; message?: unknown } | undefined;
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'number' ? error.code : undefined;
    return {
      ...base,
      http: res.status,
      code,
      message: typeof error.message === 'string' ? error.message : undefined,
      outcome: code !== undefined && REJECTION_CODES.has(code) ? 'rejected' : 'recognized',
    };
  }
  if ('result' in body) return { ...base, http: res.status, outcome: 'recognized' };
  return { ...base, http: res.status, message: 'neither result nor error' };
}

/** 존재할 수 없는 작업 ID — 탐침이 실제 작업을 건드리지 않게 한다. */
export function probeTaskId(): string {
  return `a2a-compat-probe-${randomUUID()}`;
}

export function sendParamsV03(): unknown {
  return { message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'text', text: 'a2a-compat probe' }] } };
}

export function sendParamsV1(): unknown {
  return { message: { role: 'ROLE_USER', messageId: randomUUID(), parts: [{ text: 'a2a-compat probe' }] } };
}
