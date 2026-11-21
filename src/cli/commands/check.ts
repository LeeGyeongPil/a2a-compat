// a2a-compat check: 행렬 출력, --require 판정, --json.
import { t } from '../../i18n/index.js';
import { checkEndpoint, failedRequirements } from '../../check/matrix.js';
import { UnreachableError } from '../../check/probe.js';
import { MOCK_KINDS, startMockAgent, type MockAgent, type MockKind } from '../../mock/agents.js';
import { headers, seconds, str, usage, type Values } from '../args.js';
import { ExitError, renderMatrix, unreachableText, type Ctx } from '../render.js';

function parseRequire(ctx: Ctx, raw: string | undefined): Array<'0.3' | '1.0'> {
  if (raw === undefined) return [];
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const out: Array<'0.3' | '1.0'> = [];
  for (const i of items) {
    const v = i === '0.3' || i === '0.3.0' ? '0.3' : i === '1' || i === '1.0' ? '1.0' : undefined;
    if (!v) throw usage(ctx, 'err.bad_require', { value: raw });
    if (!out.includes(v)) out.push(v);
  }
  if (out.length === 0) throw usage(ctx, 'err.bad_require', { value: raw });
  return out;
}

export async function runCheck(ctx: Ctx, positionals: string[], values: Values): Promise<number> {
  const required = parseRequire(ctx, str(values, 'require'));
  const timeoutMs = seconds(ctx, values, 'timeout', 10);
  const extraHeaders = headers(ctx, values);
  const mockKind = str(values, 'mock');

  let mock: MockAgent | undefined;
  let target: string;
  let title: string;
  if (mockKind !== undefined) {
    if (!MOCK_KINDS.includes(mockKind as MockKind)) throw usage(ctx, 'err.bad_mock', { value: mockKind });
    mock = await startMockAgent(mockKind as MockKind);
    target = mock.url;
    title = t(ctx.lang, 'check.mock', { kind: mockKind, url: mock.url });
  } else {
    if (!positionals[0]) throw usage(ctx, 'err.missing_url');
    target = positionals[0];
    title = target;
  }

  try {
    const report = await checkEndpoint(target, { timeoutMs, probeSend: values['probe-send'] === true, headers: extraHeaders });
    const failed = failedRequirements(report, required);
    if (values.json === true) {
      // --json 의 키·원인 코드는 화면 언어와 무관하게 영어 고정
      ctx.out(JSON.stringify({ ...report, ...(mock ? { mock: mock.kind } : {}), requirements: { required, failed } }, null, 2));
    } else {
      ctx.out(renderMatrix(ctx, report, title));
      if (required.length > 0) {
        ctx.out('');
        ctx.out(failed.length > 0 ? t(ctx.lang, 'check.require.failed', { list: failed.join(', ') }) : t(ctx.lang, 'check.require.ok', { list: required.join(', ') }));
      }
      ctx.out('');
      ctx.out(t(ctx.lang, 'check.basis'));
    }
    return failed.length > 0 ? 1 : 0;
  } catch (e) {
    if (e instanceof UnreachableError) throw new ExitError(unreachableText(ctx.lang, e, target), 2);
    throw e;
  } finally {
    await mock?.close();
  }
}
