// part 양방향 변환.
//   0.3: { kind:'text', text } | { kind:'file', file:{ uri|bytes, mimeType, name } } | { kind:'data', data }
//   1.0: { text } | { url|raw, mediaType, filename } | { data }      (kind 판별자가 없다)
// 1.0 필드 이름(url·raw·mediaType·filename)은 번들 1.0 스키마의 lf.a2a.v1.Part 와 같다.
import { isObj, omit, compact, type Obj } from './util.js';

/** 공식 SDK 가 0.3 data part 에 원시값을 감쌀 때 쓰는 표시(metadata.data_part_compat). */
const DATA_PART_COMPAT_FLAG = 'data_part_compat';

export function partToV1(part: unknown): unknown {
  if (!isObj(part) || !('kind' in part)) return part; // 이미 1.0 이거나 알 수 없는 값
  const rest = omit(part, 'kind');

  if (part.kind === 'text') return rest; // { text, metadata? } 만 남는다

  if (part.kind === 'file') {
    const file = isObj(part.file) ? part.file : {};
    const out: Obj = omit(rest, 'file');
    if ('uri' in file) out.url = file.uri;
    if ('bytes' in file) out.raw = file.bytes; // 둘 다 base64 문자열
    if (typeof file.mimeType === 'string') out.mediaType = file.mimeType;
    if (typeof file.name === 'string') out.filename = file.name;
    return out;
  }

  if (part.kind === 'data') {
    // SDK 가 { value: 원시값 } 으로 감싼 data part 는 원래 값으로 되돌린다.
    const meta = isObj(part.metadata) ? { ...part.metadata } : undefined;
    if (meta && meta[DATA_PART_COMPAT_FLAG] === true) {
      const out: Obj = { ...rest };
      if (isObj(part.data) && 'value' in part.data) out.data = part.data.value;
      delete meta[DATA_PART_COMPAT_FLAG];
      if (Object.keys(meta).length > 0) out.metadata = meta;
      else delete out.metadata;
      return out;
    }
    return rest;
  }

  return part; // 모르는 kind: 버리지 않고 그대로 전달
}

export function partToV03(part: unknown): unknown {
  if (!isObj(part) || 'kind' in part) return part; // 이미 0.3 이거나 알 수 없는 값

  if (typeof part.text === 'string') {
    // 0.3 TextPart 에는 mediaType·filename 자리가 없다(공식 SDK 도 버린다).
    return { kind: 'text', ...omit(part, 'mediaType', 'filename') };
  }

  if ('url' in part || 'raw' in part) {
    const file: Obj = 'raw' in part ? { bytes: part.raw } : { uri: part.url };
    if (typeof part.mediaType === 'string' && part.mediaType !== '') file.mimeType = part.mediaType;
    if (typeof part.filename === 'string' && part.filename !== '') file.name = part.filename;
    return compact({ kind: 'file', file, ...omit(part, 'url', 'raw', 'mediaType', 'filename') });
  }

  if ('data' in part) {
    const rest = omit(part, 'mediaType', 'filename');
    if (isObj(part.data)) return { kind: 'data', ...rest };
    // 0.3 DataPart.data 는 객체여야 한다 -> SDK 와 같은 방식으로 감싼다.
    const meta = isObj(part.metadata) ? { ...part.metadata } : {};
    meta[DATA_PART_COMPAT_FLAG] = true;
    return { kind: 'data', ...rest, data: { value: part.data ?? null }, metadata: meta };
  }

  return part; // 모르는 모양: 그대로 전달
}
