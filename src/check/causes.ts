// 행렬의 "원인" 코드 표. 코드는 --json 과 CI 에서 언어와 무관하게 쓰는 영어 고정 문자열이고,
// 사람이 읽는 해설은 i18n 카탈로그의 `cause.<code>` / `fix.<code>` 키에 있다.

export const CAUSES = [
  /** 헤더 없는 카드가 0.3 스키마로 읽히지 않는다(1.0 카드에는 최상위 url·protocolVersion 이 없다). */
  'v03_client_cannot_parse_card',
  /** 0.3 카드는 읽히지만 0.3 메서드(tasks/get)가 거부된다. */
  'v03_methods_rejected',
  /** 1.0 카드가 없거나(0.3 전용) 1.0 메서드를 모른다 -> 1.0 클라이언트 쪽 legacyCompat 이 필요. */
  'v1_client_needs_legacy_compat',
  /** 카드를 어느 버전으로도 해석할 수 없다. */
  'v1_client_cannot_parse_card',
  /** 1.0 카드는 있지만 헤더를 보낸 GetTask 가 거부된다. */
  'v1_methods_rejected',
  /** A2A-Version 헤더가 빠지면 서버가 0.3 으로 처리 -> -32009 또는 -32601 로 원인이 가려진다. */
  'missing_version_header',
  /** 카드에 이 버전의 JSON-RPC 엔드포인트가 없다(REST·gRPC 는 M1 에서 점검하지 않음). */
  'no_jsonrpc_interface',
  /** 엔드포인트에 닿지 못했거나 JSON-RPC 응답이 아니다. */
  'endpoint_unreachable',
  /** --probe-send 로 보낸 실제 메시지가 실패했다. */
  'send_failed',
] as const;

export type CauseCode = (typeof CAUSES)[number];
