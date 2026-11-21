// 터미널 출력: 표와 색. 색은 TTY 이고 NO_COLOR 가 없을 때만 쓴다.
import type { Lang } from '../i18n/index.js';
import { t } from '../i18n/index.js';
import type { CheckReport, MatrixRow } from '../check/matrix.js';
import type { SchemaResult } from '../card/validate.js';

export interface Ctx {
  lang: Lang;
  out: (...lines: string[]) => void;
  err: (s: string) => void;
  color: boolean;
}

/** 사용법 오류·입력 없음·연결 불가 -> 종료 코드 2 */
export class ExitError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
    this.name = 'ExitError';
  }
}

/** 한글 등 전각 문자는 터미널에서 두 칸을 차지한다. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - displayWidth(s.replace(ANSI, ''))));

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth((r[i] ?? '').replace(ANSI, '')))));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i]!))).join('  ').trimEnd();
  return [line(headers), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

export function paint(ctx: Ctx, color: 'green' | 'red' | 'yellow' | 'dim' | 'bold', s: string): string {
  if (!ctx.color) return s;
  const code = { green: 32, red: 31, yellow: 33, dim: 2, bold: 1 }[color];
  return `\x1b[${code}m${s}\x1b[0m`;
}

export function verdictText(ctx: Ctx, row: MatrixRow): string {
  const text = t(ctx.lang, `verdict.${row.verdict}`);
  return paint(ctx, row.verdict === 'CAN_CONNECT' ? 'green' : 'red', text);
}

function schemaWord(ctx: Ctx, ok: boolean, r: SchemaResult): string {
  if (!ok) return t(ctx.lang, 'check.schema.unavailable');
  return t(ctx.lang, r.valid ? 'check.schema.valid' : 'check.schema.invalid');
}

/**
 * 연결 실패의 기술 값을 화면 언어로. 영어 낱말로 된 값(timed out 등)만 옮기고,
 * ECONNREFUSED·HTTP 404 같은 코드는 그대로 둔다(검색할 수 있게).
 */
export function localDetail(lang: Lang, detail: string | undefined): string {
  if (detail === undefined || detail === 'unknown error') return t(lang, 'detail.unknown');
  if (detail === 'timed out') return t(lang, 'detail.timed_out');
  if (detail === 'response is not JSON') return t(lang, 'detail.not_json');
  // Node fetch(undici) 가 영어 문장으로 주는 흔한 값
  if (detail === 'bad port') return t(lang, 'detail.bad_port');
  if (detail === 'fetch failed') return t(lang, 'detail.fetch_failed');
  return detail;
}

/** 카드를 못 읽었거나 JSON-RPC 주소가 없을 때의 오류 문장(라이브러리의 영어 message 대신). */
export function unreachableText(lang: Lang, e: { kind: string; cardUrl?: string; detail?: string }, fallbackUrl: string): string {
  const url = e.cardUrl ?? fallbackUrl;
  if (e.kind === 'no_jsonrpc_endpoint') return t(lang, 'err.no_jsonrpc_endpoint', { url });
  return t(lang, 'err.card_unreadable', { url, reason: localDetail(lang, e.detail) });
}

/** 원인 해설 한 줄. -32601 로 가려진 헤더 누락은 따로 설명한다. */
export function causeText(lang: Lang, row: MatrixRow): string {
  if (!row.cause) return '';
  const key = row.cause === 'missing_version_header' && row.observedCode === -32601 ? 'cause.missing_version_header.masked' : `cause.${row.cause}`;
  return t(lang, key, { code: row.observedCode ?? '-', message: row.observedMessage ?? '-' });
}

export function renderMatrix(ctx: Ctx, report: CheckReport, title: string): string {
  const L = ctx.lang;
  // 같은 설명을 가진 행은 첫 행의 번호를 함께 쓴다(각주 중복 방지).
  const noteOf = new Map<string, number>();
  const noteNo = report.matrix.map((r, i) => {
    if (!r.cause) return 0;
    const text = causeText(L, r);
    if (!noteOf.has(text)) noteOf.set(text, i + 1);
    return noteOf.get(text)!;
  });
  const rows = report.matrix.map((r, i) => [
    t(L, `client.${r.client}`),
    t(L, `card.${r.card}`),
    r.call === 'rejected' ? t(L, 'call.rejected', { code: r.observedCode ?? '?' }) : t(L, `call.${r.call}`),
    verdictText(ctx, r),
    r.cause ? `[${noteNo[i]}] ${r.cause}` : '',
  ]);
  const head = [t(L, 'matrix.col.client'), t(L, 'matrix.col.card'), t(L, 'matrix.col.call'), t(L, 'matrix.col.verdict'), t(L, 'matrix.col.cause')];
  const lines = [paint(ctx, 'bold', t(L, 'matrix.title', { target: title })), table(head, rows)];

  const causes = report.matrix.map((r, i) => ({ r, i })).filter(({ r }) => r.cause);
  if (causes.length > 0) {
    lines.push('', t(L, 'check.causes'));
    const seen = new Set<string>();
    for (const { r, i } of causes) {
      if (noteNo[i] !== i + 1) continue; // 앞 행과 같은 설명
      lines.push(`  [${i + 1}] ${causeText(L, r)}`);
      if (!seen.has(r.cause!)) lines.push(paint(ctx, 'dim', `      → ${t(L, `fix.${r.cause}`)}`));
      seen.add(r.cause!);
    }
  }
  const c0 = report.cards.noHeader;
  const c1 = report.cards.v10;
  lines.push(
    '',
    t(L, 'check.cards', { detected: c0.ok ? c0.detected : '-', v03: schemaWord(ctx, c0.ok, c0.v03), v10: schemaWord(ctx, c0.ok, c0.v10) }),
    t(L, 'check.cards10', { detected: c1.ok ? c1.detected : '-', v03: schemaWord(ctx, c1.ok, c1.v03), v10: schemaWord(ctx, c1.ok, c1.v10) }),
    t(L, report.varyOnVersion ? 'check.vary.yes' : 'check.vary.no'),
  );
  return lines.join('\n');
}
