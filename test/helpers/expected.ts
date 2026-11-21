// 프로브(공식 SDK 서버 실측)와 같은 기대 행렬. check.test 와 interop-sdk.test 가 함께 쓴다.
import type { CheckReport, MockKind } from '../../src/index.js';

export type ExpectedRows = Array<[string, string, string | undefined, number | undefined]>;

/** [client, verdict, cause, observedCode] */
export const EXPECTED: Record<MockKind, ExpectedRows> = {
  'v1-strict': [
    ['v0.3', 'FAILS', 'v03_client_cannot_parse_card', -32009],
    ['v1.0', 'CAN_CONNECT', undefined, -32001],
    ['v1.0-no-header', 'FAILS', 'missing_version_header', -32009],
  ],
  'v1-compat': [
    ['v0.3', 'CAN_CONNECT', undefined, -32001],
    ['v1.0', 'CAN_CONNECT', undefined, -32001],
    ['v1.0-no-header', 'FAILS', 'missing_version_header', -32601],
  ],
  'v0.3': [
    ['v0.3', 'CAN_CONNECT', undefined, -32001],
    ['v1.0', 'FAILS', 'v1_client_needs_legacy_compat', -32601],
    ['v1.0-no-header', 'FAILS', 'v1_client_needs_legacy_compat', -32601],
  ],
};

export function rows(report: CheckReport): ExpectedRows {
  return report.matrix.map((r) => [r.client, r.verdict, r.cause, r.observedCode]);
}
