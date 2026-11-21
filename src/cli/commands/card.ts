// a2a-compat card validate | convert
import { readFile, writeFile } from 'node:fs/promises';
import { has, t } from '../../i18n/index.js';
import { convertCard, type CardTarget } from '../../card/convert.js';
import { validateCard } from '../../card/validate.js';
import { cardUrlFor, describeFetchError } from '../../check/probe.js';
import { TranslationError } from '../../errors.js';
import { headers, seconds, str, usage, type Values } from '../args.js';
import { ExitError, localDetail, paint, type Ctx } from '../render.js';

/** 파일 경로 또는 URL 에서 카드 JSON 을 읽는다. 없거나 깨졌으면 종료 코드 2. */
async function loadCard(ctx: Ctx, input: string, values: Values): Promise<unknown> {
  let text: string;
  if (/^https?:\/\//i.test(input)) {
    const url = cardUrlFor(input);
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', ...headers(ctx, values) }, signal: AbortSignal.timeout(seconds(ctx, values, 'timeout', 10)) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (e) {
      if (e instanceof ExitError) throw e;
      throw new ExitError(t(ctx.lang, 'err.unreachable', { url, reason: localDetail(ctx.lang, describeFetchError(e)) }), 2);
    }
  } else {
    try {
      text = await readFile(input, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const key = code === 'EISDIR' ? 'err.is_directory' : code === 'EACCES' || code === 'EPERM' ? 'err.file_unreadable' : 'err.file_not_found';
      throw new ExitError(t(ctx.lang, key, { path: input }), 2);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ExitError(t(ctx.lang, 'err.not_json', { path: input }), 2);
  }
}

async function runValidate(ctx: Ctx, input: string, values: Values): Promise<number> {
  const card = await loadCard(ctx, input, values);
  const result = validateCard(card);
  // 판별된 버전의 스키마를 통과하면 0 (이중 카드는 0.3 스키마 기준)
  const ok = result.detected === 'v1.0' ? result.v10.valid : result.detected === 'unknown' ? false : result.v03.valid;
  if (values.json === true) {
    ctx.out(JSON.stringify({ input, ...result, ok }, null, 2));
    return ok ? 0 : 1;
  }
  const L = ctx.lang;
  ctx.out(t(L, 'card.validate.detected', { detected: result.detected }));
  for (const [schema, r] of [['0.3', result.v03], ['1.0', result.v10]] as const) {
    const word = t(L, r.valid ? 'check.schema.valid' : 'check.schema.invalid');
    ctx.out(t(L, 'card.validate.schema', { schema, result: paint(ctx, r.valid ? 'green' : 'red', word) }));
    // 스키마 오류는 키워드별 문장(en.json/ko.json)으로. 모르는 키워드는 schema.issue.other.
    for (const i of r.issues) {
      const key = has(L, `schema.issue.${i.keyword}`) ? `schema.issue.${i.keyword}` : 'schema.issue.other';
      ctx.out(paint(ctx, 'dim', `    ${t(L, key, { path: i.path, detail: i.detail })}`));
    }
  }
  if (result.detected === 'hybrid') ctx.out(t(L, 'card.validate.hint.hybrid'));
  return ok ? 0 : 1;
}

async function runConvert(ctx: Ctx, input: string, values: Values): Promise<number> {
  const to = str(values, 'to');
  if (to === undefined) throw usage(ctx, 'err.missing_to');
  if (!['0.3', '1.0', 'hybrid'].includes(to)) throw usage(ctx, 'err.bad_to', { value: to });
  const card = await loadCard(ctx, input, values);

  let result;
  try {
    result = convertCard(card, to as CardTarget, { rewriteUrl: str(values, 'rewrite-url') });
  } catch (e) {
    if (e instanceof TranslationError) throw new ExitError(t(ctx.lang, 'err.not_card', { path: input }), 2);
    throw e;
  }

  // 경고는 stderr — stdout 의 카드 JSON 을 파이프로 그대로 쓸 수 있게
  for (const w of result.warnings) {
    const message = t(ctx.lang, `warning.${w.code}`);
    ctx.err(paint(ctx, w.severity === 'lossy' ? 'yellow' : 'dim', t(ctx.lang, 'warning.line', { code: w.code, path: w.path, message })));
  }
  const json = JSON.stringify(result.card, null, 2);
  const outFile = str(values, 'out');
  if (outFile) {
    await writeFile(outFile, `${json}\n`, 'utf8');
    ctx.err(t(ctx.lang, 'card.wrote', { file: outFile, to, count: result.warnings.length }));
  } else {
    ctx.out(json);
  }

  const lossy = result.warnings.filter((w) => w.severity === 'lossy').length;
  if (values.strict === true && lossy > 0) {
    ctx.err(t(ctx.lang, 'card.strict_failed', { count: lossy }));
    return 1;
  }
  return 0;
}

export async function runCard(ctx: Ctx, positionals: string[], values: Values): Promise<number> {
  const [sub, input] = positionals;
  if (sub !== 'validate' && sub !== 'convert') throw usage(ctx, 'err.unknown_command', { command: `card ${sub ?? ''}`.trim() });
  if (!input) throw usage(ctx, 'err.missing_input');
  return sub === 'validate' ? runValidate(ctx, input, values) : runConvert(ctx, input, values);
}
