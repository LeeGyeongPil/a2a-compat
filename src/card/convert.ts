// 카드 변환: 0.3 <-> 1.0 <-> hybrid.
// 규칙은 공식 SDK 1.3.0 호환 계층(toCoreAgentCard / toCompatAgentCard)을 와이어 JSON 기준으로 옮긴 것이고,
// 정보가 사라지는 곳마다 경고(CompatWarning)를 남긴다.
import { TranslationError } from '../errors.js';
import { isObj, type Obj } from '../translate/util.js';
import { detectCardVersion, listInterfaces, versionFamily, type CardVersion } from './detect.js';
import { makeWarning, type CompatWarning } from './warnings.js';

export type CardTarget = '0.3' | '1.0' | 'hybrid';

export interface ConvertOptions {
  /**
   * 변환한 카드를 번역 프록시가 내줄 때의 주소. 주면 모든 엔드포인트를 이 주소로 바꾸고,
   * 프록시는 두 버전을 다 말하므로 1.0·0.3 인터페이스를 둘 다 적는다.
   */
  rewriteUrl?: string;
}

export interface ConvertResult {
  card: Obj;
  warnings: CompatWarning[];
  /** 입력 카드의 판별 결과. */
  from: CardVersion;
}

type W = CompatWarning[];

const V1_CARD_KEYS = [
  'name', 'description', 'version', 'supportedInterfaces', 'provider', 'capabilities', 'securitySchemes',
  'securityRequirements', 'defaultInputModes', 'defaultOutputModes', 'skills', 'documentationUrl', 'iconUrl', 'signatures',
];
// 0.3 전용 필드: 1.0 으로 갈 때 다른 자리로 옮겨지므로 "버려짐" 경고 대상이 아니다.
const V03_CONSUMED_KEYS = ['url', 'protocolVersion', 'preferredTransport', 'additionalInterfaces', 'supportsAuthenticatedExtendedCard', 'security'];
const V1_SKILL_KEYS = ['id', 'name', 'description', 'tags', 'examples', 'inputModes', 'outputModes', 'securityRequirements'];
const OAUTH_FLOW_ORDER = ['authorizationCode', 'clientCredentials', 'implicit', 'password'] as const;

const clone = <T>(v: T): T => structuredClone(v);

/** "0.3.0" -> "0.3". 패치 번호가 있었으면 경고. */
function normalizeVersion(v: unknown, path: string, w: W): string {
  if (typeof v !== 'string' || v.trim() === '') return '0.3';
  const parts = v.trim().split('.');
  if (parts.length > 2) {
    w.push(makeWarning('PROTOCOL_VERSION_PATCH', path, `"${v}" -> "${parts[0]}.${parts[1]}"`));
    return `${parts[0]}.${parts[1]}`;
  }
  return v.trim();
}

// ---------- 보안 스킴 ----------

function flowsToV1(flows: unknown, path: string, w: W): Obj {
  if (!isObj(flows)) return {};
  const present = OAUTH_FLOW_ORDER.filter((k) => isObj(flows[k]));
  if (present.length > 1) {
    w.push(makeWarning('LOSSY_MULTIPLE_SECURITY_SCHEMES', path, `kept "${present[0]}", dropped ${present.slice(1).map((p) => `"${p}"`).join(', ')}`));
  }
  const first = present[0];
  return first ? { [first]: clone(flows[first]) } : {};
}

function flowsToV03(flows: unknown, path: string, w: W): Obj {
  if (!isObj(flows)) return {};
  const out: Obj = {};
  for (const k of OAUTH_FLOW_ORDER) {
    if (!isObj(flows[k])) continue;
    const flow = clone(flows[k]) as Obj;
    if ('pkceRequired' in flow) {
      if (flow.pkceRequired === true) w.push(makeWarning('DROPPED_FIELD', `${path}/${k}/pkceRequired`));
      delete flow.pkceRequired;
    }
    out[k] = flow;
  }
  if (isObj(flows.deviceCode)) w.push(makeWarning('LOSSY_DEVICE_CODE', `${path}/deviceCode`));
  return out;
}

function schemeToV1(s: unknown, path: string, w: W): unknown {
  if (!isObj(s)) return s;
  const description = typeof s.description === 'string' ? { description: s.description } : {};
  switch (s.type) {
    case 'apiKey':
      return { apiKeySecurityScheme: { name: s.name, location: s.in, ...description } };
    case 'http':
      return { httpAuthSecurityScheme: { scheme: s.scheme, ...(s.bearerFormat ? { bearerFormat: s.bearerFormat } : {}), ...description } };
    case 'mutualTLS':
      return { mtlsSecurityScheme: { ...description } };
    case 'oauth2':
      return {
        oauth2SecurityScheme: {
          flows: flowsToV1(s.flows, `${path}/flows`, w),
          ...(s.oauth2MetadataUrl ? { oauth2MetadataUrl: s.oauth2MetadataUrl } : {}),
          ...description,
        },
      };
    case 'openIdConnect':
      return { openIdConnectSecurityScheme: { openIdConnectUrl: s.openIdConnectUrl, ...description } };
    default:
      return s; // 이미 1.0 모양이거나 모르는 스킴
  }
}

function schemeToV03(s: unknown, path: string, w: W): unknown {
  if (!isObj(s)) return s;
  if (typeof s.type === 'string') return s; // 이미 0.3
  const desc = (v: Obj) => (typeof v.description === 'string' && v.description !== '' ? { description: v.description } : {});
  if (isObj(s.apiKeySecurityScheme)) {
    const v = s.apiKeySecurityScheme;
    // 1.0 location 은 자유 문자열, 0.3 in 은 header|query|cookie 뿐 -> 모르면 header (SDK 와 같다)
    const loc = v.location === 'query' || v.location === 'cookie' ? v.location : 'header';
    return { type: 'apiKey', name: v.name, in: loc, ...desc(v) };
  }
  if (isObj(s.httpAuthSecurityScheme)) {
    const v = s.httpAuthSecurityScheme;
    return { type: 'http', scheme: v.scheme, ...(v.bearerFormat ? { bearerFormat: v.bearerFormat } : {}), ...desc(v) };
  }
  if (isObj(s.mtlsSecurityScheme)) return { type: 'mutualTLS', ...desc(s.mtlsSecurityScheme) };
  if (isObj(s.oauth2SecurityScheme)) {
    const v = s.oauth2SecurityScheme;
    return {
      type: 'oauth2',
      flows: flowsToV03(v.flows, `${path}/oauth2SecurityScheme/flows`, w),
      ...(v.oauth2MetadataUrl ? { oauth2MetadataUrl: v.oauth2MetadataUrl } : {}),
      ...desc(v),
    };
  }
  if (isObj(s.openIdConnectSecurityScheme)) {
    const v = s.openIdConnectSecurityScheme;
    return { type: 'openIdConnect', openIdConnectUrl: v.openIdConnectUrl, ...desc(v) };
  }
  return s;
}

function schemesMap(m: unknown, fn: (s: unknown, path: string, w: W) => unknown, w: W): Obj | undefined {
  if (!isObj(m)) return undefined;
  return Object.fromEntries(Object.entries(m).map(([name, s]) => [name, fn(s, `/securitySchemes/${name}`, w)]));
}

/** 0.3 security: [{ name: [scopes] }]  ->  1.0 securityRequirements: [{ schemes: { name: { list: [scopes] } } }] */
function requirementsToV1(sec: unknown): unknown[] | undefined {
  if (!Array.isArray(sec)) return undefined;
  return sec.filter(isObj).map((req) => ({
    schemes: Object.fromEntries(Object.entries(req).map(([name, scopes]) => [name, { list: Array.isArray(scopes) ? [...scopes] : [] }])),
  }));
}

function requirementsToV03(reqs: unknown): unknown[] | undefined {
  if (!Array.isArray(reqs)) return undefined;
  return reqs.filter(isObj).map((req) =>
    Object.fromEntries(
      Object.entries(isObj(req.schemes) ? req.schemes : {}).map(([name, l]) => [name, isObj(l) && Array.isArray(l.list) ? [...l.list] : []]),
    ),
  );
}

// ---------- 0.3(또는 hybrid) -> 1.0 ----------

function v03ToV1Card(card: Obj, w: W, keepInterfaces: boolean): Obj {
  let supportedInterfaces: unknown[];
  if (keepInterfaces && Array.isArray(card.supportedInterfaces)) {
    supportedInterfaces = clone(card.supportedInterfaces);
  } else {
    const primary = {
      url: typeof card.url === 'string' ? card.url : '',
      protocolBinding: typeof card.preferredTransport === 'string' ? card.preferredTransport : 'JSONRPC',
      protocolVersion: normalizeVersion(card.protocolVersion, '/protocolVersion', w),
    };
    const additional = Array.isArray(card.additionalInterfaces)
      ? card.additionalInterfaces.filter(isObj).map((i) => ({ url: i.url, protocolBinding: i.transport, protocolVersion: primary.protocolVersion }))
      : [];
    // 0.3 카드는 같은 주소·전송을 additionalInterfaces 에 한 번 더 적기도 한다 -> 중복 제거
    supportedInterfaces = [primary, ...additional.filter((a) => !(a.url === primary.url && a.protocolBinding === primary.protocolBinding))];
  }

  const caps = isObj(card.capabilities) ? card.capabilities : {};
  const capabilities: Obj = {};
  for (const k of ['streaming', 'pushNotifications', 'extensions']) if (k in caps) capabilities[k] = clone(caps[k]);
  if (typeof card.supportsAuthenticatedExtendedCard === 'boolean') capabilities.extendedAgentCard = card.supportsAuthenticatedExtendedCard;
  for (const k of Object.keys(caps)) if (!['streaming', 'pushNotifications', 'extensions', 'extendedAgentCard'].includes(k)) w.push(makeWarning('DROPPED_FIELD', `/capabilities/${k}`));

  const skills = Array.isArray(card.skills)
    ? card.skills.map((s, i) => {
        if (!isObj(s)) return s;
        const out: Obj = {};
        for (const k of V1_SKILL_KEYS) if (k in s && k !== 'securityRequirements') out[k] = clone(s[k]);
        const reqs = requirementsToV1(s.security);
        if (reqs) out.securityRequirements = reqs;
        for (const k of Object.keys(s)) if (!V1_SKILL_KEYS.includes(k) && k !== 'security') w.push(makeWarning('DROPPED_FIELD', `/skills/${i}/${k}`));
        return out;
      })
    : card.skills;

  const out: Obj = {
    name: card.name,
    description: card.description,
    version: card.version,
    supportedInterfaces,
    capabilities,
    defaultInputModes: clone(card.defaultInputModes),
    defaultOutputModes: clone(card.defaultOutputModes),
    skills,
  };
  if (isObj(card.provider)) out.provider = clone(card.provider);
  const schemes = schemesMap(card.securitySchemes, schemeToV1, w);
  if (schemes) out.securitySchemes = schemes;
  const reqs = requirementsToV1(card.security);
  if (reqs) out.securityRequirements = reqs;
  for (const k of ['documentationUrl', 'iconUrl', 'signatures']) if (k in card) out[k] = clone(card[k]);
  for (const k of Object.keys(card)) {
    if (!V1_CARD_KEYS.includes(k) && !V03_CONSUMED_KEYS.includes(k)) w.push(makeWarning('DROPPED_FIELD', `/${k}`));
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// ---------- 1.0 -> 0.3 ----------

function v1ToV03Card(card: Obj, w: W, rewriting: boolean): Obj {
  const all = listInterfaces({ supportedInterfaces: card.supportedInterfaces });
  const legacy = all.filter((i) => i.version === '0.3');
  let primary = legacy[0];
  if (!primary) {
    if (!rewriting) w.push(makeWarning('NO_V03_INTERFACE', '/supportedInterfaces'));
    primary = all[0] ?? { url: '', binding: 'JSONRPC', version: '0.3' };
  }
  // 0.3 primary 의 protocolVersion 은 원래 인터페이스 값을 쓴다(없으면 "0.3").
  const rawPrimary = Array.isArray(card.supportedInterfaces)
    ? card.supportedInterfaces.find((i) => isObj(i) && i.url === primary!.url && versionFamily(i.protocolVersion) === '0.3')
    : undefined;
  const protocolVersion = isObj(rawPrimary) && typeof rawPrimary.protocolVersion === 'string' ? rawPrimary.protocolVersion : '0.3';

  const caps = isObj(card.capabilities) ? card.capabilities : {};
  const capabilities: Obj = {};
  for (const k of ['streaming', 'pushNotifications', 'extensions']) if (k in caps) capabilities[k] = clone(caps[k]);

  const skills = Array.isArray(card.skills)
    ? card.skills.map((s) => {
        if (!isObj(s)) return s;
        const out: Obj = {};
        for (const [k, v] of Object.entries(s)) if (k !== 'securityRequirements') out[k] = clone(v);
        const sec = requirementsToV03(s.securityRequirements);
        if (sec && sec.length > 0) out.security = sec;
        for (const k of ['examples', 'inputModes', 'outputModes']) if (Array.isArray(out[k]) && (out[k] as unknown[]).length === 0) delete out[k];
        return out;
      })
    : card.skills;

  const out: Obj = {
    name: card.name,
    description: card.description,
    version: card.version,
    url: primary.url,
    preferredTransport: primary.binding || 'JSONRPC',
    protocolVersion,
    capabilities,
    defaultInputModes: clone(card.defaultInputModes),
    defaultOutputModes: clone(card.defaultOutputModes),
    skills,
  };
  const additional = legacy.slice(1).map((i) => ({ url: i.url, transport: i.binding }));
  if (additional.length > 0) out.additionalInterfaces = additional;
  if (isObj(card.provider)) out.provider = clone(card.provider);
  if (typeof card.documentationUrl === 'string' && card.documentationUrl !== '') out.documentationUrl = card.documentationUrl;
  if (typeof card.iconUrl === 'string' && card.iconUrl !== '') out.iconUrl = card.iconUrl;
  if (typeof caps.extendedAgentCard === 'boolean') out.supportsAuthenticatedExtendedCard = caps.extendedAgentCard;
  const schemes = schemesMap(card.securitySchemes, schemeToV03, w);
  if (schemes && Object.keys(schemes).length > 0) out.securitySchemes = schemes;
  const sec = requirementsToV03(card.securityRequirements);
  if (sec && sec.length > 0) out.security = sec;
  if (Array.isArray(card.signatures) && card.signatures.length > 0) out.signatures = clone(card.signatures);
  return out;
}

// ---------- 공개 함수 ----------

function dualInterfaces(url: string): Obj[] {
  return [
    { url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    { url, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
  ];
}

/** 경고 목록에서 같은 (code, path) 는 한 번만. */
function dedupe(w: W): W {
  const seen = new Set<string>();
  return w.filter((x) => {
    const k = `${x.code} ${x.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function convertCard(card: unknown, to: CardTarget, opts: ConvertOptions = {}): ConvertResult {
  const from = detectCardVersion(card);
  if (!isObj(card) || from === 'unknown') {
    throw new TranslationError('Input is not an A2A agent card (no 0.3 url/protocolVersion and no 1.0 supportedInterfaces).');
  }
  if (!['0.3', '1.0', 'hybrid'].includes(to)) throw new TranslationError(`Unknown target "${String(to)}" (use 0.3, 1.0 or hybrid).`);
  const w: W = [];
  const rw = opts.rewriteUrl;

  if (card.url === '') w.push(makeWarning('EMPTY_TOP_LEVEL_URL', '/url'));
  const changesContent = rw !== undefined || !((from === 'v0.3' && to === '0.3') || (from === 'v1.0' && to === '1.0') || (from === 'hybrid' && to === 'hybrid'));
  if (changesContent && Array.isArray(card.signatures) && card.signatures.length > 0) w.push(makeWarning('SIGNATURES_INVALIDATED', '/signatures'));

  let out: Obj;
  if (to === '1.0') {
    out = from === 'v1.0' ? clone(card) : v03ToV1Card(card, w, from === 'hybrid');
    if (rw !== undefined) out.supportedInterfaces = dualInterfaces(rw);
  } else if (to === '0.3') {
    out = from === 'v1.0' ? v1ToV03Card(card, w, rw !== undefined) : clone(card);
    delete out.supportedInterfaces;
    if (rw !== undefined) {
      out.url = rw;
      out.preferredTransport = 'JSONRPC';
      // 덮어쓰기 전에 원래 값을 정규화해, 패치 번호가 있었으면 경고를 남긴다.
      if (typeof out.protocolVersion === 'string') normalizeVersion(out.protocolVersion, '/protocolVersion', w);
      out.protocolVersion = '0.3';
      delete out.additionalInterfaces;
    }
  } else {
    // hybrid = 0.3 카드 + 1.0 supportedInterfaces
    out = from === 'v1.0' ? v1ToV03Card(card, w, true) : clone(card);
    if (rw !== undefined) {
      out.url = rw;
      out.preferredTransport = 'JSONRPC';
      // 덮어쓰기 전에 원래 값을 정규화해, 패치 번호가 있었으면 경고를 남긴다.
      if (typeof out.protocolVersion === 'string') normalizeVersion(out.protocolVersion, '/protocolVersion', w);
      out.protocolVersion = '0.3';
      delete out.additionalInterfaces;
      out.supportedInterfaces = dualInterfaces(rw);
    } else {
      const ifaces = listInterfaces(card);
      const v1 = ifaces.filter((i) => i.version === '1.0');
      const v03 = ifaces.filter((i) => i.version === '0.3');
      const base = (v03[0] ?? v1[0])?.url ?? '';
      if (v1.length === 0 || v03.length === 0) w.push(makeWarning('ASSUMES_DUAL_STACK', '/supportedInterfaces'));
      const v1Items = v1.length > 0 ? v1 : [{ url: base, binding: 'JSONRPC', version: '1.0' as const }];
      const v03Items = v03.length > 0 ? v03 : [{ url: base, binding: 'JSONRPC', version: '0.3' as const }];
      out.supportedInterfaces = [...v1Items, ...v03Items].map((i) => ({ url: i.url, protocolBinding: i.binding || 'JSONRPC', protocolVersion: i.version }));
      out.url = typeof out.url === 'string' && out.url !== '' ? out.url : base;
    }
    if (typeof out.protocolVersion === 'string') out.protocolVersion = normalizeVersion(out.protocolVersion, '/protocolVersion', w);
    w.push(makeWarning('HYBRID_FAILS_STRICT_V1_SCHEMA', '/'));
  }

  if ((to === '0.3' || to === 'hybrid') && out.url === '') w.push(makeWarning('EMPTY_TOP_LEVEL_URL', '/url'));
  return { card: out, warnings: dedupe(w), from };
}
