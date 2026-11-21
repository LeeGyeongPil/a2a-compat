// 인자 해석 도우미(node:util parseArgs 결과를 검사해 의미 있는 값으로 바꾼다).
import { t } from '../i18n/index.js';
import { ExitError, type Ctx } from './render.js';

export type Values = Record<string, string | boolean | string[] | undefined>;

export function str(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === 'string' ? v : undefined;
}

export function usage(ctx: Ctx, key: string, vars: Record<string, string | number> = {}): ExitError {
  return new ExitError(t(ctx.lang, 'err.usage', { message: t(ctx.lang, key, vars) }), 2);
}

/** 초 단위 옵션 -> ms. */
export function seconds(ctx: Ctx, values: Values, name: string, fallbackSec: number): number {
  const raw = str(values, name);
  if (raw === undefined) return fallbackSec * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw usage(ctx, 'err.bad_number', { option: `--${name}`, value: raw });
  return Math.round(n * 1000);
}

/** --header 'Name: value' (여러 번) -> 객체. */
export function headers(ctx: Ctx, values: Values): Record<string, string> {
  const list = values.header;
  const items = Array.isArray(list) ? list : typeof list === 'string' ? [list] : [];
  const out: Record<string, string> = {};
  for (const h of items) {
    const i = h.indexOf(':');
    if (i <= 0) throw usage(ctx, 'err.bad_header', { value: h.replace(/:.*/, ': ...') });
    out[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return out;
}
