// SSE 이벤트 한 개(data: 줄의 JSON) 변환.
// 0.3 스트림 이벤트는 { result:{ kind:'status-update', ..., final } },
// 1.0 은 { result:{ statusUpdate:{...} } } 이고 final 이 없다. final 은 1.0->0.3 에서 다시 계산된다.
import { responseToV03, responseToV1 } from './response.js';
import { isObj } from './util.js';

export type Direction = 'toV1' | 'toV03';

/**
 * data 문자열을 번역해 돌려준다. JSON 이 아니거나 JSON-RPC 응답이 아니면 손대지 않고 돌려준다
 * (스트림 하나가 이상하다고 연결 전체를 죽이지 않는다).
 */
export function translateEventData(data: string, direction: Direction, method?: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return data;
  }
  if (!isObj(parsed) || !('result' in parsed || 'error' in parsed)) return data;
  const out = direction === 'toV1' ? responseToV1(parsed, method) : responseToV03(parsed, method);
  return JSON.stringify(out);
}
