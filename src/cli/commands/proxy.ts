// a2a-compat proxy: 프록시를 띄우고 요청마다 한 줄씩 무엇이 어떻게 바뀌었는지 보여 준다.
import { t } from '../../i18n/index.js';
import { createProxy, type ProxyEvent, type ProxyHandle } from '../../proxy/server.js';
import { MOCK_KINDS, startMockAgent, type MockAgent, type MockKind } from '../../mock/agents.js';
import { headers, seconds, str, usage, type Values } from '../args.js';
import { ExitError, localDetail, paint, unreachableText, type Ctx } from '../render.js';
import { UnreachableError } from '../../check/probe.js';

const other = (v: string | undefined) => (v === '1.0' ? '0.3' : '1.0');

/**
 * 거부·오류의 이유를 화면 언어로. 이벤트의 영어 message 는 라이브러리용이라 화면에 붙이지 않고,
 * 이유 코드로 en.json/ko.json 의 `proxy.reason.<code>` 문장을 고른다.
 * 이유 코드가 없는 이벤트(라이브러리 바깥에서 만든 이벤트)만 message 를 그대로 보여 준다.
 */
function reasonText(L: Ctx['lang'], e: ProxyEvent): string {
  if (e.reason) {
    const detail = typeof e.detail === 'string' ? localDetail(L, e.detail) : (e.detail ?? '?');
    return t(L, `proxy.reason.${e.reason}`, { method: e.method ?? '?', detail });
  }
  return e.message ?? '';
}

export function formatProxyEvent(ctx: Ctx, e: ProxyEvent): string[] {
  const L = ctx.lang;
  const lines: string[] = [];
  switch (e.type) {
    case 'request':
      lines.push(
        e.translated
          ? t(L, 'proxy.log.request', { method: e.method ?? '?', cv: e.clientVersion ?? '?', um: e.upstreamMethod ?? '?', uv: other(e.clientVersion) })
          : t(L, 'proxy.log.passthrough', { method: e.method ?? '?', cv: e.clientVersion ?? '?' }),
      );
      if (e.inferred) lines.push(paint(ctx, 'dim', t(L, 'proxy.log.inferred')));
      break;
    case 'response':
      if (e.code !== undefined) lines.push(t(L, 'proxy.log.response_error', { method: e.method ?? '?', code: e.code }));
      else if (e.events !== undefined)
        // 스트림: "SSE 이벤트 n개" 를 각 언어로 (영어는 단수·복수 구분)
        lines.push(t(L, e.events === 1 ? 'proxy.log.stream_one' : 'proxy.log.stream', { method: e.method ?? '?', count: e.events }));
      else lines.push(t(L, 'proxy.log.response', { method: e.method ?? '?', shape: e.shape ?? '-' }));
      break;
    case 'reject': {
      const why = reasonText(L, e);
      lines.push(paint(ctx, 'yellow', t(L, 'proxy.log.reject', { method: e.method ?? '?', code: e.code ?? '?' })) + (why ? paint(ctx, 'dim', ` — ${why}`) : ''));
      break;
    }
    case 'card':
      lines.push(paint(ctx, 'dim', t(L, 'proxy.log.card', { cv: e.clientVersion ?? '?' })));
      break;
    case 'error':
      lines.push(paint(ctx, 'red', t(L, 'proxy.log.error', { message: reasonText(L, e) })));
      break;
  }
  if (e.body !== undefined) lines.push(paint(ctx, 'dim', `  ${JSON.stringify(e.body)}`));
  return lines;
}

export async function runProxy(ctx: Ctx, _positionals: string[], values: Values): Promise<number> {
  const mockKind = str(values, 'mock-upstream');
  let upstream = str(values, 'upstream');
  if (!upstream && !mockKind) throw usage(ctx, 'err.missing_upstream');
  if (mockKind !== undefined && !MOCK_KINDS.includes(mockKind as MockKind)) throw usage(ctx, 'err.bad_mock', { value: mockKind });
  const upstreamVersion = str(values, 'upstream-version') ?? 'auto';
  if (!['auto', '0.3', '1.0'].includes(upstreamVersion)) throw usage(ctx, 'err.bad_upstream_version', { value: upstreamVersion });
  const listenRaw = str(values, 'listen') ?? '8787';
  const port = Number(listenRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw usage(ctx, 'err.bad_number', { option: '--listen', value: listenRaw });
  const host = str(values, 'host') ?? '127.0.0.1';
  const publicUrl = str(values, 'public-url');
  if (publicUrl !== undefined && !/^https?:\/\/[^\s/]+/.test(publicUrl)) throw usage(ctx, 'err.bad_public_url', { value: publicUrl });
  const timeoutMs = seconds(ctx, values, 'timeout', 120);
  const idleTimeoutMs = seconds(ctx, values, 'idle-timeout', 300);
  const extra = headers(ctx, values);

  let mock: MockAgent | undefined;
  if (mockKind) {
    mock = await startMockAgent(mockKind as MockKind);
    upstream = mock.url;
  }

  let proxy: ProxyHandle;
  try {
    proxy = await createProxy({
      upstream: upstream!,
      upstreamVersion: upstreamVersion as 'auto' | '0.3' | '1.0',
      inferVersion: values['infer-version'] === true,
      host,
      port,
      publicUrl,
      timeoutMs,
      idleTimeoutMs,
      headers: extra,
      logBodies: values['log-bodies'] === true,
      onEvent: (e) => formatProxyEvent(ctx, e).forEach((l) => ctx.out(l)),
    });
  } catch (e) {
    await mock?.close();
    const err = e as NodeJS.ErrnoException;
    // 업스트림 카드 문제는 라이브러리의 영어 message 대신 화면 언어 문장으로
    if (e instanceof UnreachableError) throw new ExitError(unreachableText(ctx.lang, e, upstream ?? ''), 2);
    // 그 밖은 바인딩 실패(EADDRINUSE·EACCES·EADDRNOTAVAIL 등): 코드만 붙인다
    if (typeof err.code === 'string') throw new ExitError(t(ctx.lang, 'err.listen', { host, port, reason: err.code }), 2);
    throw new ExitError(t(ctx.lang, 'err.unreachable', { url: upstream ?? '', reason: err.message }), 2);
  }

  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) ctx.err(paint(ctx, 'yellow', t(ctx.lang, 'proxy.public_warning', { host })));
  // 대기 줄에는 실제 바인딩 주소를, --public-url 은 카드에 알리는 주소로 따로 보여 준다.
  ctx.out(t(ctx.lang, 'proxy.listening', { url: proxy.listenUrl }));
  if (publicUrl !== undefined) ctx.out(t(ctx.lang, 'proxy.public_url', { url: proxy.url }));
  ctx.out(t(ctx.lang, 'proxy.upstream', { url: upstream!, versions: proxy.upstreamVersions.join(' + ') }));
  if (mock) ctx.out(paint(ctx, 'dim', t(ctx.lang, 'proxy.mock_upstream', { kind: mock.kind })));
  ctx.out(t(ctx.lang, 'proxy.hint', { url: proxy.url }));

  // Ctrl+C / SIGTERM 까지 기다렸다가 서버·목·진행 중 요청을 모두 정리한다.
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await proxy.close();
  await mock?.close();
  ctx.out(t(ctx.lang, 'proxy.stopped'));
  return 0;
}
