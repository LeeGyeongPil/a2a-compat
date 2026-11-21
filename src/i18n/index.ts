// 화면 언어 결정과 메시지 조회. 문구는 en.json / ko.json 한 곳에만 둔다.
// 우선순위: --lang > A2A_COMPAT_LANG > LC_ALL > LC_MESSAGES > LANG. 한국어가 아니면 영어.
import { readFileSync } from 'node:fs';

export type Lang = 'en' | 'ko';

const catalogs: Partial<Record<Lang, Record<string, string>>> = {};

export function catalog(lang: Lang): Record<string, string> {
  if (!catalogs[lang]) {
    catalogs[lang] = JSON.parse(readFileSync(new URL(`./${lang}.json`, import.meta.url), 'utf8')) as Record<string, string>;
  }
  return catalogs[lang]!;
}

function normalize(v: string | undefined): Lang | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (s === '' || s === 'c' || s === 'posix') return undefined;
  return s.startsWith('ko') ? 'ko' : 'en';
}

export function resolveLang(flag?: string, env: NodeJS.ProcessEnv = process.env): Lang {
  if (flag !== undefined) {
    // 잘못된 값이면 영어(사용법 오류로 멈추지 않는다)
    return normalize(flag) ?? 'en';
  }
  for (const v of [env.A2A_COMPAT_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const l = normalize(v);
    if (l) return l;
  }
  return 'en';
}

/** 메시지 조회. {name} 자리를 vars 로 채운다. 키가 없으면 영어 → 키 이름 순으로 대신한다. */
export function t(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  const raw = catalog(lang)[key] ?? catalog('en')[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function has(lang: Lang, key: string): boolean {
  return key in catalog(lang);
}
