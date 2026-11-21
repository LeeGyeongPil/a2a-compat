// JSON-RPC 메서드 이름 대응 표 (A2A 0.3 <-> 1.0).
// 값은 공식 SDK @a2a-js/sdk 1.3.0 의 공개 함수 legacyJsonRpcToV1Method 를 실측한 결과와 같다.
import { UnsupportedOperationError } from '../errors.js';

export type ProtocolVersion = '0.3' | '1.0';

/** M1 에서 양방향으로 번역하는 메서드 5쌍 (0.3 이름 -> 1.0 이름). */
export const METHOD_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['message/send', 'SendMessage'],
  ['message/stream', 'SendStreamingMessage'],
  ['tasks/get', 'GetTask'],
  ['tasks/cancel', 'CancelTask'],
  ['tasks/resubscribe', 'SubscribeToTask'],
];

/** 이름은 대응하지만 M1 에서는 본문 번역을 하지 않는 메서드 (프록시가 -32004 로 거부). */
export const M1_UNSUPPORTED_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['tasks/pushNotificationConfig/set', 'CreateTaskPushNotificationConfig'],
  ['tasks/pushNotificationConfig/get', 'GetTaskPushNotificationConfig'],
  ['tasks/pushNotificationConfig/list', 'ListTaskPushNotificationConfigs'],
  ['tasks/pushNotificationConfig/delete', 'DeleteTaskPushNotificationConfig'],
  ['agent/getAuthenticatedExtendedCard', 'GetExtendedAgentCard'],
];

/** 1.0 에만 있고 0.3 에 대응이 없는 메서드와 그 이유. */
export const V1_ONLY_METHODS: Readonly<Record<string, string>> = {
  ListTasks: 'A2A 0.3 has no method to list tasks, so ListTasks cannot be forwarded to a 0.3 agent.',
};

/** 스트림(SSE)으로 응답하는 메서드. */
export const STREAMING_METHODS = new Set([
  'message/stream',
  'tasks/resubscribe',
  'SendStreamingMessage',
  'SubscribeToTask',
]);

/**
 * 번역할 수 없는 메서드가 왜 거부되는지 분류한다(화면 로그는 이 코드로 각 언어 문장을 고른다).
 * - v1_only_method: 1.0 에만 있는 메서드(ListTasks)
 * - not_translated: 이름은 대응하지만 M1 에서 본문 번역을 하지 않는 메서드(푸시 설정, 확장 카드)
 * - unknown_method: 어느 버전에도 없는 이름
 */
export type UnsupportedKind = 'v1_only_method' | 'not_translated' | 'unknown_method';

export function unsupportedKind(name: string): UnsupportedKind {
  if (name in V1_ONLY_METHODS) return 'v1_only_method';
  if (M1_UNSUPPORTED_PAIRS.some(([a, b]) => a === name || b === name)) return 'not_translated';
  return 'unknown_method';
}

const V03_TO_V1 = new Map([...METHOD_PAIRS, ...M1_UNSUPPORTED_PAIRS]);
const V1_TO_V03 = new Map([...METHOD_PAIRS, ...M1_UNSUPPORTED_PAIRS].map(([a, b]) => [b, a] as const));
const M1_PAIRS_V03 = new Set(METHOD_PAIRS.map(([a]) => a));
const M1_PAIRS_V1 = new Set(METHOD_PAIRS.map(([, b]) => b));

export function isV03Method(name: string): boolean {
  return V03_TO_V1.has(name);
}

export function isV1Method(name: string): boolean {
  return V1_TO_V03.has(name) || name in V1_ONLY_METHODS;
}

/** 이 메서드의 본문을 M1 번역기가 다룰 수 있는가. */
export function isTranslatableMethod(name: string): boolean {
  return M1_PAIRS_V03.has(name) || M1_PAIRS_V1.has(name);
}

/** 0.3 메서드 이름 -> 1.0. 이미 1.0 이름이면 그대로 돌려준다. */
export function methodToV1(name: string): string {
  const mapped = V03_TO_V1.get(name);
  if (mapped) return mapped;
  if (isV1Method(name)) return name;
  throw new UnsupportedOperationError(`Unknown A2A 0.3 method "${name}"; no A2A 1.0 equivalent is known.`);
}

/** 1.0 메서드 이름 -> 0.3. 대응이 없으면 UnsupportedOperationError(-32004). */
export function methodToV03(name: string): string {
  const mapped = V1_TO_V03.get(name);
  if (mapped) return mapped;
  if (name in V1_ONLY_METHODS) throw new UnsupportedOperationError(V1_ONLY_METHODS[name]!);
  if (V03_TO_V1.has(name)) return name;
  throw new UnsupportedOperationError(`Unknown A2A 1.0 method "${name}"; no A2A 0.3 equivalent is known.`);
}
