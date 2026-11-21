// 카드 변환 경고 코드. 코드는 고정 문자열이라 CI·스크립트에서 grep 할 수 있다.
//   lossy: 정보가 사라지거나 결과 카드가 실제와 다를 수 있음 -> CLI --strict 에서 exit 1
//   info : 알아 두면 좋은 차이(표기 정규화, 이중 카드의 본질적 한계)

export type WarningCode =
  | 'LOSSY_DEVICE_CODE'
  | 'LOSSY_MULTIPLE_SECURITY_SCHEMES'
  | 'EMPTY_TOP_LEVEL_URL'
  | 'PROTOCOL_VERSION_PATCH'
  | 'HYBRID_FAILS_STRICT_V1_SCHEMA'
  | 'DROPPED_FIELD'
  | 'SIGNATURES_INVALIDATED'
  | 'NO_V03_INTERFACE'
  | 'ASSUMES_DUAL_STACK';

export interface CompatWarning {
  code: WarningCode;
  /** 경고가 가리키는 카드 안의 위치(JSON Pointer 비슷한 표기). */
  path: string;
  /** 영어 설명. CLI 는 code 로 언어별 문장을 고른다. */
  message: string;
  severity: 'lossy' | 'info';
}

const SEVERITY: Record<WarningCode, 'lossy' | 'info'> = {
  LOSSY_DEVICE_CODE: 'lossy',
  LOSSY_MULTIPLE_SECURITY_SCHEMES: 'lossy',
  EMPTY_TOP_LEVEL_URL: 'lossy',
  DROPPED_FIELD: 'lossy',
  SIGNATURES_INVALIDATED: 'lossy',
  NO_V03_INTERFACE: 'lossy',
  PROTOCOL_VERSION_PATCH: 'info',
  HYBRID_FAILS_STRICT_V1_SCHEMA: 'info',
  ASSUMES_DUAL_STACK: 'info',
};

export const WARNING_MESSAGES: Record<WarningCode, string> = {
  LOSSY_DEVICE_CODE: 'The OAuth2 deviceCode flow exists only in A2A 1.0 and is dropped in the 0.3 card.',
  LOSSY_MULTIPLE_SECURITY_SCHEMES:
    'This OAuth2 security scheme declares several flows; A2A 1.0 allows one flow per scheme, so only the first (authorizationCode > clientCredentials > implicit > password) is kept.',
  EMPTY_TOP_LEVEL_URL: 'The top-level "url" is empty; A2A 0.3 clients will not know where to send requests.',
  PROTOCOL_VERSION_PATCH: 'protocolVersion carried a patch number (e.g. "0.3.0"); A2A 1.0 interfaces use major.minor only ("0.3").',
  HYBRID_FAILS_STRICT_V1_SCHEMA:
    'A hybrid card keeps 0.3 top-level fields (url, protocolVersion, preferredTransport, ...), so strict A2A 1.0 validators (additionalProperties: false) reject it. Serve it only to clients that send no A2A-Version header.',
  DROPPED_FIELD: 'This field has no place in the target version and was dropped.',
  SIGNATURES_INVALIDATED: 'The card is signed; converting it changes the signed content, so the signatures no longer verify.',
  NO_V03_INTERFACE:
    'The agent advertises no 0.3 interface; this 0.3 card points at a 1.0 endpoint, which 0.3 clients still cannot call unless a translating proxy serves it (use rewriteUrl).',
  ASSUMES_DUAL_STACK:
    'A hybrid card claims the endpoint speaks both 0.3 and 1.0. That is only true for compat-enabled servers or behind a translating proxy.',
};

export function makeWarning(code: WarningCode, path: string, detail?: string): CompatWarning {
  const message = detail ? `${WARNING_MESSAGES[code]} (${detail})` : WARNING_MESSAGES[code];
  return { code, path, message, severity: SEVERITY[code] };
}
