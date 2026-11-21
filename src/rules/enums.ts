// 작업 상태·역할 enum 대응 표.
// 1.0 와이어 이름은 번들 1.0 스키마(TaskStatus.state)의 enum 값 그대로다 — CANCELED 는 L 하나.

export const TASK_STATE_V03_TO_V1: Readonly<Record<string, string>> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  canceled: 'TASK_STATE_CANCELED',
  failed: 'TASK_STATE_FAILED',
  rejected: 'TASK_STATE_REJECTED',
  'auth-required': 'TASK_STATE_AUTH_REQUIRED',
  unknown: 'TASK_STATE_UNSPECIFIED',
};

export const TASK_STATE_V1_TO_V03: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(TASK_STATE_V03_TO_V1).map(([k, v]) => [v, k])),
  // 옛 gRPC 표기(L 두 개)도 받아 준다.
  TASK_STATE_CANCELLED: 'canceled',
};

/** proto JSON 은 enum 을 숫자로 보낼 수도 있다(0..8). */
const TASK_STATE_V1_BY_NUMBER = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
];

/** 0.3 스트림에서 final:true 가 되는 상태 (공식 SDK 호환 계층과 같은 집합). */
export const FINAL_V03_STATES = new Set(['completed', 'canceled', 'failed', 'rejected']);

export function taskStateToV1(state: unknown): unknown {
  if (typeof state !== 'string') return state; // 결측·이상 값은 건드리지 않는다
  if (state.startsWith('TASK_STATE_')) return state; // 이미 1.0
  return TASK_STATE_V03_TO_V1[state] ?? 'TASK_STATE_UNSPECIFIED';
}

export function taskStateToV03(state: unknown): unknown {
  if (typeof state === 'number') state = TASK_STATE_V1_BY_NUMBER[state] ?? 'TASK_STATE_UNSPECIFIED';
  if (typeof state !== 'string') return state;
  if (state in TASK_STATE_V03_TO_V1) return state; // 이미 0.3
  return TASK_STATE_V1_TO_V03[state] ?? 'unknown';
}

export function roleToV1(role: unknown): unknown {
  if (role === 'user') return 'ROLE_USER';
  if (role === 'agent') return 'ROLE_AGENT';
  return role;
}

export function roleToV03(role: unknown): unknown {
  if (role === 'ROLE_USER' || role === 1) return 'user';
  if (role === 'ROLE_AGENT' || role === 2) return 'agent';
  return role;
}
