#!/usr/bin/env node
// a2a-compat CLI 진입점: 인자 해석 -> 하위 명령 -> 종료 코드(0 정상, 1 점검·엄격 실패, 2 사용법·입력·연결 오류).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolveLang, t, type Lang } from '../i18n/index.js';
import { runCard } from './commands/card.js';
import { runCheck } from './commands/check.js';
import { runDemo } from './commands/demo.js';
import { runProxy } from './commands/proxy.js';
import { ExitError, type Ctx } from './render.js';
import type { Values } from './args.js';

const OPTIONS = {
  lang: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  require: { type: 'string' },
  'probe-send': { type: 'boolean' },
  mock: { type: 'string' },
  timeout: { type: 'string' },
  header: { type: 'string', multiple: true },
  to: { type: 'string' },
  out: { type: 'string' },
  strict: { type: 'boolean' },
  'rewrite-url': { type: 'string' },
  upstream: { type: 'string' },
  'mock-upstream': { type: 'string' },
  listen: { type: 'string' },
  host: { type: 'string' },
  'public-url': { type: 'string' },
  'upstream-version': { type: 'string' },
  'infer-version': { type: 'boolean' },
  'idle-timeout': { type: 'string' },
  'log-bodies': { type: 'boolean' },
} as const;

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/** parseArgs 가 실패해도 오류 문구 언어를 정할 수 있게 --lang 만 먼저 찾는다. */
function preScanLang(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--lang') return argv[i + 1];
    if (a.startsWith('--lang=')) return a.slice(7);
  }
  return undefined;
}

/** 읽는 쪽이 먼저 닫힌 파이프(`| head`)에서 스택 트레이스 없이 조용히 끝낸다. */
export function exitQuietlyOnEpipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
      throw e;
    });
  }
}

export async function main(argv: string[]): Promise<number> {
  exitQuietlyOnEpipe();
  const lang: Lang = resolveLang(preScanLang(argv));
  const ctx: Ctx = {
    lang,
    out: (...lines) => process.stdout.write(lines.map((s) => `${s}\n`).join('')),
    err: (s) => process.stderr.write(`${s}\n`),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  };

  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      throw new ExitError(t(lang, 'err.usage', { message: (e as Error).message }), 2);
    }
    const values = parsed.values as Values;
    const [command, ...rest] = parsed.positionals;

    if (values.version) {
      ctx.out(packageVersion());
      return 0;
    }
    if (values.help || !command) {
      const key = command && ['check', 'card', 'proxy', 'demo'].includes(command) ? `help.${command}` : 'help.main';
      ctx.out(t(lang, key));
      return command || values.help ? 0 : 2;
    }

    switch (command) {
      case 'check':
        return await runCheck(ctx, rest, values);
      case 'card':
        return await runCard(ctx, rest, values);
      case 'proxy':
        return await runProxy(ctx, rest, values);
      case 'demo':
        return await runDemo(ctx);
      default:
        throw new ExitError(t(lang, 'err.usage', { message: t(lang, 'err.unknown_command', { command }) }), 2);
    }
  } catch (e) {
    if (e instanceof ExitError) {
      ctx.err(e.message);
      return e.exitCode;
    }
    ctx.err(String((e as Error)?.stack ?? e));
    return 2;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
