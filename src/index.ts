// a2a-compat 공개 API. 와이어 JSON 만 다룬다(SDK 내부의 ts-proto 객체 형태는 쓰지 않는다).
export type { ProtocolVersion } from './rules/methods.js';
export { methodToV1, methodToV03 } from './rules/methods.js';
export { toV1, toV03, type JsonRpcMessage, type TranslateContext } from './translate/index.js';
export { detectCardVersion, type CardVersion } from './card/detect.js';
export { validateCard, type CardValidation, type SchemaResult, type SchemaIssue } from './card/validate.js';
export { convertCard, type CardTarget, type ConvertOptions, type ConvertResult } from './card/convert.js';
export type { CompatWarning, WarningCode } from './card/warnings.js';
export { checkEndpoint, type CheckReport, type CheckOptions, type MatrixRow, type ClientId, type Verdict } from './check/matrix.js';
export type { CauseCode } from './check/causes.js';
export { createProxy, PROXY_REASONS, type ProxyOptions, type ProxyHandle, type ProxyEvent, type ProxyReason } from './proxy/server.js';
export { startMockAgent, type MockAgent, type MockKind } from './mock/agents.js';
export { UnsupportedOperationError, TranslationError } from './errors.js';
