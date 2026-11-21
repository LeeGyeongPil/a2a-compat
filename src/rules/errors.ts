// JSON-RPC 오류 코드 표와 1.0 ErrorInfo 붙이기/떼기.
// 1.0 은 오류 본문에 data:[{ "@type": ".../google.rpc.ErrorInfo", reason, domain }] 를 붙인다.
// 0.3 에는 이 형식이 없고, -32009(VersionNotSupported)도 없다.

export const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';
export const A2A_ERROR_DOMAIN = 'a2a-protocol.org';

/** 코드 -> 1.0 ErrorInfo.reason (공식 SDK 1.3.0 의 표와 같다). */
export const ERROR_REASONS: Readonly<Record<number, string>> = {
  [-32001]: 'TASK_NOT_FOUND',
  [-32002]: 'TASK_NOT_CANCELABLE',
  [-32003]: 'PUSH_NOTIFICATION_NOT_SUPPORTED',
  [-32004]: 'UNSUPPORTED_OPERATION',
  [-32005]: 'CONTENT_TYPE_NOT_SUPPORTED',
  [-32006]: 'INVALID_AGENT_RESPONSE',
  [-32007]: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED',
  [-32008]: 'EXTENSION_SUPPORT_REQUIRED',
  [-32009]: 'VERSION_NOT_SUPPORTED',
};

export const CODE = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001,
  UNSUPPORTED_OPERATION: -32004,
  VERSION_NOT_SUPPORTED: -32009,
} as const;

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
  [extra: string]: unknown;
}

function isErrorInfo(item: unknown): boolean {
  return typeof item === 'object' && item !== null && (item as Record<string, unknown>)['@type'] === ERROR_INFO_TYPE;
}

/** 1.0 오류 본문 만들기: A2A 전용 코드면 ErrorInfo 를 붙인다. */
export function errorBodyV1(code: number, message: string, extraData?: unknown): JsonRpcErrorBody {
  const reason = ERROR_REASONS[code];
  const body: JsonRpcErrorBody = { code, message };
  if (reason) body.data = [{ '@type': ERROR_INFO_TYPE, reason, domain: A2A_ERROR_DOMAIN }];
  else if (extraData !== undefined) body.data = extraData;
  return body;
}

/** 0.3 오류 -> 1.0 오류. 모르는 필드는 남긴다. */
export function errorToV1(err: JsonRpcErrorBody): JsonRpcErrorBody {
  const out: JsonRpcErrorBody = { ...err };
  const reason = typeof err.code === 'number' ? ERROR_REASONS[err.code] : undefined;
  if (!reason) return out;
  const info = { '@type': ERROR_INFO_TYPE, reason, domain: A2A_ERROR_DOMAIN };
  if (Array.isArray(err.data)) {
    out.data = err.data.some(isErrorInfo) ? err.data : [info, ...err.data];
  } else if (err.data === undefined || err.data === null) {
    out.data = [info];
  } else {
    // 0.3 의 자유 형식 data 는 ErrorInfo.metadata 로 보존할 수 없으니 뒤에 그대로 둔다.
    out.data = [info, err.data];
  }
  return out;
}

/** 1.0 오류 -> 0.3 오류. ErrorInfo 를 떼고, -32009 는 0.3 에 없으니 -32600 으로 바꾼다. */
export function errorToV03(err: JsonRpcErrorBody): JsonRpcErrorBody {
  const out: JsonRpcErrorBody = { ...err };
  if (Array.isArray(err.data)) {
    const rest = err.data.filter((d) => !isErrorInfo(d));
    if (rest.length === 0) delete out.data;
    else out.data = rest.length === 1 ? rest[0] : rest;
  }
  if (err.code === CODE.VERSION_NOT_SUPPORTED) {
    out.code = CODE.INVALID_REQUEST;
    out.message = `${err.message} (A2A 1.0 VersionNotSupportedError -32009; A2A 0.3 has no such code)`;
  }
  return out;
}
