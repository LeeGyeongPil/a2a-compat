// 단건 결과·오류 변환.
//   0.3 결과: { kind:'task'|'message'|'status-update'|'artifact-update', ... }
//   1.0 결과: SendMessage·스트림은 { task } | { message } | { statusUpdate } | { artifactUpdate } 로 감싸고,
//             GetTask·CancelTask 는 Task 를 그대로 돌려준다.
// 그래서 응답만 보고는 모양을 정할 수 없어 원 요청의 메서드(ctx.method)가 필요하다.
import { errorToV03, errorToV1, type JsonRpcErrorBody } from '../rules/errors.js';
import {
  artifactUpdateToV03,
  artifactUpdateToV1,
  messageToV03,
  messageToV1,
  statusUpdateToV03,
  statusUpdateToV1,
  taskToV03,
  taskToV1,
} from './message.js';
import { isObj, type Obj } from './util.js';

/** 메서드가 Task 를 감싸지 않고 바로 돌려주는가 (0.3·1.0 어느 이름이든). */
export function returnsBareTask(method: string | undefined): boolean {
  return method === 'GetTask' || method === 'CancelTask' || method === 'tasks/get' || method === 'tasks/cancel';
}

/** 0.3 결과 -> 1.0 결과. */
export function resultToV1(result: unknown, method?: string): unknown {
  if (!isObj(result)) return result;
  if (returnsBareTask(method)) return taskToV1(result);
  switch (result.kind) {
    case 'task':
      return { task: taskToV1(result) };
    case 'message':
      return { message: messageToV1(result) };
    case 'status-update':
      return { statusUpdate: statusUpdateToV1(result) };
    case 'artifact-update':
      return { artifactUpdate: artifactUpdateToV1(result) };
    default:
      return result; // kind 가 없으면 이미 1.0 이거나 모르는 모양: 그대로
  }
}

const WRAPPER_KEYS = ['task', 'message', 'statusUpdate', 'artifactUpdate'] as const;

/** 1.0 결과 -> 0.3 결과. */
export function resultToV03(result: unknown, method?: string): unknown {
  if (!isObj(result)) return result;
  if (typeof result.kind === 'string') return result; // 이미 0.3
  if (returnsBareTask(method)) return taskToV03(result);
  const key = WRAPPER_KEYS.find((k) => isObj(result[k]));
  if (!key) {
    // 감싸지 않은 Task 처럼 보이면(메서드를 모를 때) Task 로 본다.
    if (method === undefined && 'status' in result && 'id' in result) return taskToV03(result);
    return result;
  }
  const inner = result[key];
  if (key === 'task') return taskToV03(inner);
  if (key === 'message') return messageToV03(inner);
  if (key === 'statusUpdate') return statusUpdateToV03(inner);
  return artifactUpdateToV03(inner);
}

/** JSON-RPC 응답 봉투(단건 또는 SSE 한 이벤트) 변환. id·jsonrpc 와 모르는 필드는 그대로. */
export function responseToV1(res: Obj, method?: string): Obj {
  const out: Obj = { ...res };
  if ('result' in res) out.result = resultToV1(res.result, method);
  if (isObj(res.error)) out.error = errorToV1(res.error as JsonRpcErrorBody);
  return out;
}

export function responseToV03(res: Obj, method?: string): Obj {
  const out: Obj = { ...res };
  if ('result' in res) out.result = resultToV03(res.result, method);
  if (isObj(res.error)) out.error = errorToV03(res.error as JsonRpcErrorBody);
  return out;
}
