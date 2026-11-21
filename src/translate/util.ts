// 번역기 공통 도우미. 입력은 신뢰할 수 없는 와이어 JSON 이므로 모든 접근을 방어한다.

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 배열이면 각 원소를 바꾸고, 배열이 아니면(없음·null 포함) 그대로 둔다. */
export function mapArray(v: unknown, fn: (item: unknown) => unknown): unknown {
  return Array.isArray(v) ? v.map(fn) : v;
}

/** 지정한 키를 뺀 얕은 복사본. 모르는 필드는 모두 남는다. */
export function omit(o: Obj, ...keys: string[]): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** 값이 undefined 인 키만 지운다(직렬화 결과를 깔끔하게). */
export function compact(o: Obj): Obj {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}
