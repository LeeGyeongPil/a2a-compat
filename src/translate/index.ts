// 공개 진입점 toV1 · toV03: JSON-RPC 요청·단건 응답·SSE 이벤트를 받아 모양을 판별하고 번역한다.
import { TranslationError } from '../errors.js';
import { requestToV03, requestToV1 } from './request.js';
import { responseToV03, responseToV1 } from './response.js';
import { isObj, type Obj } from './util.js';

export type JsonRpcMessage = Record<string, unknown>;

export interface TranslateContext {
  /** 응답·SSE 이벤트를 번역할 때 원 요청의 메서드 이름(0.3·1.0 어느 쪽 이름이든). */
  method?: string;
}

type Kind = 'request' | 'response';

function classify(msg: unknown): Kind {
  if (!isObj(msg)) throw new TranslationError('Expected a JSON-RPC object (request, response or SSE event payload).');
  if (typeof msg.method === 'string') return 'request';
  if ('result' in msg || isObj(msg.error)) return 'response';
  throw new TranslationError('Not a JSON-RPC message: it has neither "method" nor "result"/"error".');
}

/** A2A 0.3 메시지를 1.0 모양으로. 이미 1.0 이면 거의 그대로 돌려준다. */
export function toV1(msg: JsonRpcMessage, ctx: TranslateContext = {}): JsonRpcMessage {
  return classify(msg) === 'request' ? requestToV1(msg as Obj) : responseToV1(msg as Obj, ctx.method);
}

/** A2A 1.0 메시지를 0.3 모양으로. 대응 없는 메서드는 UnsupportedOperationError. */
export function toV03(msg: JsonRpcMessage, ctx: TranslateContext = {}): JsonRpcMessage {
  return classify(msg) === 'request' ? requestToV03(msg as Obj) : responseToV03(msg as Obj, ctx.method);
}
