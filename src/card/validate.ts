// 번들 스키마 두 개로 카드를 검증한다.
//   0.3: A2A 레포 v0.3.0 태그의 JSON Schema(draft-07)
//   1.0: a2a-inspector 가 a2a.proto v1.0.1 에서 생성한 스키마(2020-12, additionalProperties:false)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ValidateFunction, ErrorObject } from 'ajv';
import { detectCardVersion, type CardVersion } from './detect.js';

// ajv 는 CommonJS 패키지라 require 로 불러오는 편이 ESM·타입 양쪽에서 가장 덜 헷갈린다.
const require = createRequire(import.meta.url);
const Ajv7 = require('ajv').default as typeof import('ajv').default;
const Ajv2020 = require('ajv/dist/2020.js').default as typeof import('ajv').default;
const addFormats = require('ajv-formats').default as (ajv: unknown) => void;

export interface SchemaResult {
  valid: boolean;
  /** 사람이 읽는 영어 오류(ajv 메시지). */
  errors: string[];
  /** 같은 오류를 구조로: 화면은 keyword 로 각 언어 문장을 고른다. errors 와 순서·개수가 같다. */
  issues: SchemaIssue[];
}

export interface SchemaIssue {
  /** JSON Pointer (예: /capabilities). 루트는 "/". */
  path: string;
  /** JSON Schema 키워드 (additionalProperties, required, type ...). */
  keyword: string;
  /** 키워드별 핵심 값(필드 이름, 허용 형식 등). */
  detail: string;
}

export interface CardValidation {
  detected: CardVersion;
  v03: SchemaResult;
  v10: SchemaResult;
}

let validators: { v03: ValidateFunction; v10: ValidateFunction } | undefined;

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url), 'utf8'));
}

/** 스키마 컴파일은 무거우니 처음 쓸 때 한 번만 한다. */
function getValidators() {
  if (validators) return validators;
  const a7 = new Ajv7({ strict: false, allErrors: true });
  const a20 = new Ajv2020({ strict: false, allErrors: true });
  addFormats(a7);
  addFormats(a20);
  a7.addSchema(loadSchema('a2a-v0.3.json'), 'v03');
  a20.addSchema(loadSchema('a2a-v1.0.json'), 'v10');
  validators = {
    v03: a7.getSchema('v03#/definitions/AgentCard')!,
    v10: a20.getSchema('v10#/$defs/lf.a2a.v1.AgentCard')!,
  };
  return validators;
}

/** 키워드마다 문장에 넣을 핵심 값 하나를 고른다. */
function issueDetail(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case 'additionalProperties':
      return String(p.additionalProperty);
    case 'required':
      return String(p.missingProperty);
    case 'type':
      return String(p.type);
    case 'enum':
      return Array.isArray(p.allowedValues) ? p.allowedValues.map((v) => JSON.stringify(v)).join(', ') : '';
    case 'const':
      return JSON.stringify(p.allowedValue);
    case 'format':
      return String(p.format);
    case 'pattern':
      return String(p.pattern);
    case 'minItems':
      return String(p.limit);
    default:
      return e.keyword;
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): Pick<SchemaResult, 'errors' | 'issues'> {
  const seen = new Map<string, SchemaIssue>();
  for (const e of errors ?? []) {
    const p = e.params as Record<string, unknown>;
    const extra = p.additionalProperty ?? p.missingProperty;
    const text = `${e.instancePath || '/'} ${e.message ?? 'invalid'}${extra ? ` (${String(extra)})` : ''}`;
    if (!seen.has(text)) seen.set(text, { path: e.instancePath || '/', keyword: e.keyword, detail: issueDetail(e) });
    if (seen.size >= 20) break; // 오류 목록이 끝없이 길어지지 않게
  }
  return { errors: [...seen.keys()], issues: [...seen.values()] };
}

export function validateAgainst(card: unknown, version: '0.3' | '1.0'): SchemaResult {
  const fn = getValidators()[version === '0.3' ? 'v03' : 'v10'];
  const valid = fn(card) as boolean;
  return valid ? { valid, errors: [], issues: [] } : { valid, ...formatErrors(fn.errors) };
}

export function validateCard(card: unknown): CardValidation {
  return { detected: detectCardVersion(card), v03: validateAgainst(card, '0.3'), v10: validateAgainst(card, '1.0') };
}
