// Message · Task · Artifact · 상태 이벤트 변환.
// 원칙: 아는 필드만 바꾸고 모르는 필드는 그대로 둔다. 없거나 null 인 선택 필드에서 죽지 않는다.
import { FINAL_V03_STATES, roleToV03, roleToV1, taskStateToV03, taskStateToV1 } from '../rules/enums.js';
import { partToV03, partToV1 } from './part.js';
import { isEmptyValue, isObj, mapArray, omit, type Obj } from './util.js';

// ---------- 0.3 -> 1.0 ----------

export function messageToV1(m: unknown): unknown {
  if (!isObj(m)) return m;
  const out = omit(m, 'kind');
  if ('role' in m) out.role = roleToV1(m.role);
  if ('parts' in m) out.parts = mapArray(m.parts, partToV1);
  return out;
}

export function artifactToV1(a: unknown): unknown {
  if (!isObj(a)) return a;
  const out: Obj = { ...a };
  if ('parts' in a) out.parts = mapArray(a.parts, partToV1);
  return out;
}

export function statusToV1(s: unknown): unknown {
  if (!isObj(s)) return s;
  const out: Obj = { ...s };
  if ('state' in s) out.state = taskStateToV1(s.state);
  if (isObj(s.message)) out.message = messageToV1(s.message);
  return out;
}

export function taskToV1(t: unknown): unknown {
  if (!isObj(t)) return t;
  const out = omit(t, 'kind');
  if ('status' in t) out.status = statusToV1(t.status);
  if ('history' in t) out.history = mapArray(t.history, messageToV1);
  if ('artifacts' in t) out.artifacts = mapArray(t.artifacts, artifactToV1);
  return out;
}

/** 0.3 status-update -> 1.0 TaskStatusUpdateEvent: kind 와 final 이 사라진다. */
export function statusUpdateToV1(e: unknown): unknown {
  if (!isObj(e)) return e;
  const out = omit(e, 'kind', 'final');
  if ('status' in e) out.status = statusToV1(e.status);
  return out;
}

export function artifactUpdateToV1(e: unknown): unknown {
  if (!isObj(e)) return e;
  const out = omit(e, 'kind');
  if ('artifact' in e) out.artifact = artifactToV1(e.artifact);
  return out;
}

// ---------- 1.0 -> 0.3 ----------

/** 1.0 proto JSON 은 기본값(빈 문자열·빈 배열)을 실어 보내기도 한다. 0.3 쪽에서는 빼 준다. */
function dropEmpty(o: Obj, ...keys: string[]): Obj {
  for (const k of keys) if (k in o && isEmptyValue(o[k])) delete o[k];
  return o;
}

export function messageToV03(m: unknown): unknown {
  if (!isObj(m)) return m;
  if (m.kind === 'message') return m; // 이미 0.3
  const out: Obj = { kind: 'message', ...m };
  if ('role' in m) out.role = roleToV03(m.role);
  if ('parts' in m) out.parts = mapArray(m.parts, partToV03);
  return dropEmpty(out, 'contextId', 'taskId', 'extensions', 'referenceTaskIds');
}

export function artifactToV03(a: unknown): unknown {
  if (!isObj(a)) return a;
  const out: Obj = { ...a };
  if ('parts' in a) out.parts = mapArray(a.parts, partToV03);
  return dropEmpty(out, 'name', 'description', 'extensions');
}

export function statusToV03(s: unknown): unknown {
  if (!isObj(s)) return s;
  const out: Obj = { ...s };
  if ('state' in s) out.state = taskStateToV03(s.state);
  if (isObj(s.message)) out.message = messageToV03(s.message);
  return dropEmpty(out, 'timestamp');
}

export function taskToV03(t: unknown): unknown {
  if (!isObj(t)) return t;
  const out: Obj = { kind: 'task', ...t };
  out.status = isObj(t.status) ? statusToV03(t.status) : { state: 'unknown' }; // 0.3 은 status 필수
  if ('history' in t) out.history = mapArray(t.history, messageToV03);
  if ('artifacts' in t) out.artifacts = mapArray(t.artifacts, artifactToV03);
  return dropEmpty(out, 'history', 'artifacts');
}

/** 1.0 TaskStatusUpdateEvent -> 0.3 status-update: final 을 상태로부터 다시 계산한다. */
export function statusUpdateToV03(e: unknown): unknown {
  if (!isObj(e)) return e;
  const status = isObj(e.status) ? (statusToV03(e.status) as Obj) : { state: 'unknown' };
  const out: Obj = { kind: 'status-update', ...omit(e, 'final', 'kind'), status };
  out.final = FINAL_V03_STATES.has(String(status.state)); // 종료 상태면 true
  return out;
}

export function artifactUpdateToV03(e: unknown): unknown {
  if (!isObj(e)) return e;
  const out: Obj = { kind: 'artifact-update', ...omit(e, 'kind') };
  if ('artifact' in e) out.artifact = artifactToV03(e.artifact);
  return out;
}
