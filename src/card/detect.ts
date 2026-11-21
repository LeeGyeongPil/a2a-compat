// 카드 버전 판별.
//   v0.3  : 최상위 url·protocolVersion·preferredTransport 가 있는 평평한 카드
//   v1.0  : supportedInterfaces[] 하나로 통합된 카드
//   hybrid: 둘 다 있는 카드(공식 SDK 호환 모드가 헤더 없는 요청에 내주는 모양)
import { isObj, type Obj } from '../translate/util.js';

export type CardVersion = 'v0.3' | 'v1.0' | 'hybrid' | 'unknown';

const LEGACY_TOP_LEVEL = ['url', 'protocolVersion', 'preferredTransport', 'additionalInterfaces', 'supportsAuthenticatedExtendedCard'];

/** "0.3", "0.3.0", "0.3.1" -> 0.3 계열, "1", "1.0" -> 1.0 계열. 문자열 비교 대신 major.minor 로 본다. */
export function versionFamily(v: unknown): '0.3' | '1.0' | undefined {
  if (typeof v !== 'string') return undefined;
  const [major, minor] = v.trim().split('.').map((s) => Number.parseInt(s, 10));
  if (major === 0 && minor === 3) return '0.3';
  if (major === 1) return '1.0';
  return undefined;
}

export function hasV1Interfaces(card: Obj): boolean {
  return Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length > 0;
}

export function hasLegacyFields(card: Obj): boolean {
  return LEGACY_TOP_LEVEL.some((k) => k in card);
}

export function detectCardVersion(card: unknown): CardVersion {
  if (!isObj(card)) return 'unknown';
  const v1 = hasV1Interfaces(card);
  const legacy = hasLegacyFields(card);
  if (v1 && legacy) return 'hybrid';
  if (v1) return 'v1.0';
  if (legacy) {
    // protocolVersion 이 1.x 인데 supportedInterfaces 가 없으면 어느 쪽도 아니다.
    if ('protocolVersion' in card && versionFamily(card.protocolVersion) === '1.0') return 'unknown';
    return 'v0.3';
  }
  return 'unknown';
}

export interface InterfaceInfo {
  url: string;
  binding: string;
  version: '0.3' | '1.0' | undefined;
}

/** 카드가 알려 주는 모든 엔드포인트를 버전별로 모은다(0.3 필드와 supportedInterfaces 둘 다). */
export function listInterfaces(card: unknown): InterfaceInfo[] {
  if (!isObj(card)) return [];
  const out: InterfaceInfo[] = [];
  if (Array.isArray(card.supportedInterfaces)) {
    for (const i of card.supportedInterfaces) {
      if (!isObj(i)) continue;
      // protocolVersion 이 비어 있으면 공식 SDK 처럼 0.3 으로 본다.
      const fam = i.protocolVersion === undefined || i.protocolVersion === '' ? '0.3' : versionFamily(i.protocolVersion);
      out.push({ url: String(i.url ?? ''), binding: String(i.protocolBinding ?? ''), version: fam });
    }
  }
  if (typeof card.url === 'string') {
    out.push({ url: card.url, binding: String(card.preferredTransport ?? 'JSONRPC'), version: '0.3' });
  }
  if (Array.isArray(card.additionalInterfaces)) {
    for (const i of card.additionalInterfaces) {
      if (isObj(i)) out.push({ url: String(i.url ?? ''), binding: String(i.transport ?? ''), version: '0.3' });
    }
  }
  return out;
}

/** 해당 버전의 JSON-RPC 엔드포인트 URL (없으면 undefined). */
export function jsonRpcUrl(card: unknown, version: '0.3' | '1.0'): string | undefined {
  return listInterfaces(card).find((i) => i.version === version && i.binding.toUpperCase() === 'JSONRPC' && i.url !== '')?.url;
}
