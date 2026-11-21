// 탐침 결과 -> "어느 클라이언트가 붙을 수 있나" 행렬.
// SDK 를 흉내 내지 않고 와이어 사실(카드 모양·헤더·오류 코드)만으로 판정한다.
// 판정 근거는 공식 JS SDK 1.3.0 / 0.3.14 의 기본 설정 클라이언트 동작(프로브로 측정)이다.
import { isObj } from '../translate/util.js';
import { jsonRpcUrl } from '../card/detect.js';
import type { CauseCode } from './causes.js';
import {
  UnreachableError,
  callMethod,
  cardUrlFor,
  fetchCard,
  probeTaskId,
  sendParamsV03,
  sendParamsV1,
  type CardFetch,
  type MethodProbe,
  type ProbeOptions,
} from './probe.js';

export type ClientId = 'v0.3' | 'v1.0' | 'v1.0-no-header';
export type Verdict = 'CAN_CONNECT' | 'FAILS';

export interface MatrixRow {
  client: ClientId;
  /** 이 클라이언트가 카드를 읽을 수 있는가. */
  card: 'readable' | 'unreadable';
  /** 메서드 탐침 결과(카드를 못 읽어도 참고용으로 부른다). */
  call: 'ok' | 'rejected' | 'unreachable' | 'not_run';
  observedCode?: number;
  observedMessage?: string;
  verdict: Verdict;
  cause?: CauseCode;
}

export interface CheckReport {
  target: string;
  cardUrl: string;
  checkedAt: string;
  cards: { noHeader: Omit<CardFetch, 'card'>; v10: Omit<CardFetch, 'card'> };
  /** 카드가 A2A-Version 헤더에 따라 달라지는가(Vary: A2A-Version). */
  varyOnVersion: boolean;
  endpoints: { v03?: string; v10?: string };
  probes: MethodProbe[];
  matrix: MatrixRow[];
  probeSend: boolean;
}

export interface CheckOptions {
  timeoutMs?: number;
  /** 실제 message/send · SendMessage 도 보낸다(상대에 작업이 생긴다). */
  probeSend?: boolean;
  headers?: Record<string, string>;
}

/** 0.3 클라이언트가 보는 엔드포인트: 최상위 url(+preferredTransport) 또는 additionalInterfaces 만 읽는다. */
function v03ClientEndpoint(card: unknown): string | undefined {
  if (!isObj(card)) return undefined;
  const preferred = typeof card.preferredTransport === 'string' ? card.preferredTransport : 'JSONRPC';
  if (typeof card.url === 'string' && card.url !== '' && preferred.toUpperCase() === 'JSONRPC') return card.url;
  if (Array.isArray(card.additionalInterfaces)) {
    for (const i of card.additionalInterfaces) {
      if (isObj(i) && String(i.transport).toUpperCase() === 'JSONRPC' && typeof i.url === 'string' && i.url !== '') return i.url;
    }
  }
  return undefined;
}

function callState(p: MethodProbe | undefined): MatrixRow['call'] {
  if (!p) return 'not_run';
  if (p.outcome === 'recognized') return 'ok';
  if (p.outcome === 'rejected') return 'rejected';
  return 'unreachable';
}

function row(client: ClientId, readable: boolean, probe: MethodProbe | undefined, verdict: Verdict, cause?: CauseCode): MatrixRow {
  const r: MatrixRow = { client, card: readable ? 'readable' : 'unreadable', call: callState(probe), verdict };
  if (probe?.code !== undefined) r.observedCode = probe.code;
  if (probe?.message !== undefined) r.observedMessage = probe.message;
  if (cause) r.cause = cause;
  return r;
}

function stripCard(f: CardFetch): Omit<CardFetch, 'card'> {
  const { card: _card, ...rest } = f;
  return rest;
}

export async function checkEndpoint(target: string, options: CheckOptions = {}): Promise<CheckReport> {
  const opts: ProbeOptions = { timeoutMs: options.timeoutMs ?? 10_000, headers: options.headers ?? {} };
  const cardUrl = cardUrlFor(target);

  // 1) 카드를 헤더 없이 / A2A-Version: 1.0 으로 두 번 받는다.
  const noHeader = await fetchCard(cardUrl, null, opts);
  const v10 = await fetchCard(cardUrl, '1.0', opts);
  if (!noHeader.ok && !v10.ok) {
    const detail = noHeader.error ?? v10.error ?? 'unknown error';
    throw new UnreachableError(`Could not read an agent card from ${cardUrl}: ${detail}`, cardUrl, detail);
  }
  const card03 = noHeader.ok ? noHeader.card : v10.card; // 0.3 클라이언트는 헤더를 보내지 않는다
  const card10 = v10.ok ? v10.card : noHeader.card; // 1.0 클라이언트는 헤더 1.0

  // 2) 엔드포인트: 각 버전 클라이언트가 실제로 고를 주소. 없으면 다른 쪽 주소로라도 탐침해 관측값을 남긴다.
  const url03 = v03ClientEndpoint(card03);
  const url10 = jsonRpcUrl(card10, '1.0');
  const anyUrl = url10 ?? url03 ?? jsonRpcUrl(card10, '0.3') ?? jsonRpcUrl(card03, '0.3');

  // 3) 부작용 없는 메서드 탐침 (없는 작업 ID)
  const probes: MethodProbe[] = [];
  const taskId = probeTaskId();
  const p03 = anyUrl || url03 ? await callMethod('v03_get', (url03 ?? anyUrl)!, 'tasks/get', { id: taskId }, null, opts) : undefined;
  const p10 = anyUrl ? await callMethod('v1_get', (url10 ?? anyUrl)!, 'GetTask', { id: taskId }, '1.0', opts) : undefined;
  const p10n = anyUrl ? await callMethod('v1_get_no_header', (url10 ?? anyUrl)!, 'GetTask', { id: taskId }, null, opts) : undefined;
  for (const p of [p03, p10, p10n]) if (p) probes.push(p);

  // 4) 선택: 실제 전송
  let s03: MethodProbe | undefined;
  let s10: MethodProbe | undefined;
  if (options.probeSend) {
    if (url03) s03 = await callMethod('v03_send', url03, 'message/send', sendParamsV03(), null, opts);
    if (url10) s10 = await callMethod('v1_send', url10, 'SendMessage', sendParamsV1(), '1.0', opts);
    for (const p of [s03, s10]) if (p) probes.push(p);
  }

  // 5) 판정
  const matrix: MatrixRow[] = [];

  // (a) 0.3 클라이언트: 헤더 없는 카드가 0.3 스키마로 읽히고 JSON-RPC url 이 있어야 한다.
  const readable03 = noHeader.ok ? noHeader.v03.valid && url03 !== undefined : v10.v03.valid && url03 !== undefined;
  if (!readable03) {
    const valid = noHeader.ok ? noHeader.v03.valid : v10.v03.valid;
    matrix.push(row('v0.3', false, p03, 'FAILS', valid ? 'no_jsonrpc_interface' : 'v03_client_cannot_parse_card'));
  } else if (p03?.outcome !== 'recognized') {
    matrix.push(row('v0.3', true, p03, 'FAILS', p03?.outcome === 'rejected' ? 'v03_methods_rejected' : 'endpoint_unreachable'));
  } else if (s03 && s03.outcome !== 'recognized') {
    matrix.push(row('v0.3', true, s03, 'FAILS', 'send_failed'));
  } else {
    matrix.push(row('v0.3', true, s03 ?? p03, 'CAN_CONNECT'));
  }

  // (b)(c) 1.0 클라이언트: 카드에 1.0 JSON-RPC 인터페이스가 있어야 한다.
  const readable10 = url10 !== undefined;
  const detected10 = v10.ok ? v10.detected : noHeader.detected;
  const cardCause: CauseCode =
    detected10 === 'v0.3' ? 'v1_client_needs_legacy_compat' : detected10 === 'unknown' ? 'v1_client_cannot_parse_card' : 'no_jsonrpc_interface';

  if (!readable10) {
    matrix.push(row('v1.0', false, p10, 'FAILS', cardCause));
    matrix.push(row('v1.0-no-header', false, p10n, 'FAILS', cardCause));
  } else {
    if (p10?.outcome !== 'recognized') {
      matrix.push(row('v1.0', true, p10, 'FAILS', p10?.outcome === 'rejected' ? 'v1_methods_rejected' : 'endpoint_unreachable'));
    } else if (s10 && s10.outcome !== 'recognized') {
      matrix.push(row('v1.0', true, s10, 'FAILS', 'send_failed'));
    } else {
      matrix.push(row('v1.0', true, s10 ?? p10, 'CAN_CONNECT'));
    }
    // 헤더 빠진 1.0 요청: 서버는 0.3 으로 본다 -> -32009(엄격) 또는 -32601(호환, 원인이 가려짐)
    if (p10n?.outcome === 'recognized') {
      matrix.push(row('v1.0-no-header', true, p10n, 'CAN_CONNECT'));
    } else if (p10n?.outcome === 'rejected' && (p10n.code === -32009 || p10n.code === -32601)) {
      matrix.push(row('v1.0-no-header', true, p10n, 'FAILS', 'missing_version_header'));
    } else {
      matrix.push(row('v1.0-no-header', true, p10n, 'FAILS', p10n?.outcome === 'rejected' ? 'v1_methods_rejected' : 'endpoint_unreachable'));
    }
  }

  return {
    target,
    cardUrl,
    checkedAt: new Date().toISOString(),
    cards: { noHeader: stripCard(noHeader), v10: stripCard(v10) },
    varyOnVersion: [noHeader.vary, v10.vary].some((v) => typeof v === 'string' && /a2a-version/i.test(v)),
    endpoints: { v03: url03, v10: url10 },
    probes,
    matrix,
    probeSend: Boolean(options.probeSend),
  };
}

/** --require 0.3,1.0 판정: 필수 클라이언트 중 FAILS 가 있으면 그 목록. */
export function failedRequirements(report: CheckReport, required: Array<'0.3' | '1.0'>): Array<'0.3' | '1.0'> {
  return required.filter((v) => report.matrix.find((r) => r.client === (v === '0.3' ? 'v0.3' : 'v1.0'))?.verdict !== 'CAN_CONNECT');
}
