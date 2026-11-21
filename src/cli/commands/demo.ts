// a2a-compat demo: 네트워크 없이 localhost 에서 "프록시 전 FAILS -> 프록시 후 CAN CONNECT" 를 보여 준다.
// 목 에이전트는 실제 HTTP 서버이고, check·proxy 는 실제 에이전트와 똑같은 코드 경로를 탄다.
import { t } from '../../i18n/index.js';
import { checkEndpoint, type CheckReport } from '../../check/matrix.js';
import { createProxy, type ProxyEvent } from '../../proxy/server.js';
import { MOCK_KINDS, startMockAgent, type MockAgent } from '../../mock/agents.js';
import { formatProxyEvent } from './proxy.js';
import { paint, renderMatrix, verdictText, type Ctx } from '../render.js';

function v1Row(report: CheckReport) {
  return report.matrix.find((r) => r.client === 'v1.0')!;
}

export async function runDemo(ctx: Ctx): Promise<number> {
  const L = ctx.lang;
  const mocks: MockAgent[] = [];
  const events: ProxyEvent[] = [];
  let proxy: Awaited<ReturnType<typeof createProxy>> | undefined;
  try {
    ctx.out(paint(ctx, 'bold', t(L, 'demo.title')));
    ctx.out(paint(ctx, 'yellow', t(L, 'demo.mock_note')));

    // 1단계: 목 3종을 띄우고 각각 직접 점검
    ctx.out('', paint(ctx, 'bold', `== ${t(L, 'demo.step1')} ==`));
    const reports: Record<string, CheckReport> = {};
    for (const kind of MOCK_KINDS) {
      const mock = await startMockAgent(kind);
      mocks.push(mock);
      reports[kind] = await checkEndpoint(mock.url, { timeoutMs: 5000 });
      ctx.out('', renderMatrix(ctx, reports[kind]!, t(L, 'check.mock', { kind, url: mock.url })));
    }

    // 2단계: 0.3 목 앞에 프록시를 두고 프록시를 점검
    ctx.out('', paint(ctx, 'bold', `== ${t(L, 'demo.step2')} ==`));
    const legacy = mocks.find((m) => m.kind === 'v0.3')!;
    proxy = await createProxy({ upstream: legacy.url, onEvent: (e) => events.push(e) });
    const viaProxy = await checkEndpoint(proxy.url, { timeoutMs: 5000 });
    ctx.out('', renderMatrix(ctx, viaProxy, `a2a-compat proxy ${proxy.url} -> ${legacy.url}`));

    // 3단계: 1.0 클라이언트처럼 실제 SendMessage 를 보낸다(헤더 1.0, kind 없는 part)
    ctx.out('', paint(ctx, 'bold', `== ${t(L, 'demo.step3')} ==`));
    events.length = 0;
    const res = await fetch(`${proxy.url}/a2a/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: 'demo-1', parts: [{ text: 'hello from a 1.0 client' }] } } }),
    });
    const body = (await res.json()) as { result?: { task?: { status?: { state?: string }; artifacts?: Array<{ parts?: Array<{ text?: string }> }> } } };
    for (const e of events) for (const line of formatProxyEvent(ctx, e)) ctx.out(`  ${line}`);
    const task = body.result?.task;
    ctx.out(t(L, 'demo.send_result', { state: task?.status?.state ?? '?', text: task?.artifacts?.[0]?.parts?.[0]?.text ?? '?' }));

    // 요약: 같은 0.3 에이전트가 프록시 전에는 FAILS, 후에는 CAN CONNECT
    ctx.out('', paint(ctx, 'bold', `== ${t(L, 'demo.summary')} ==`));
    ctx.out(t(L, 'demo.summary.before', { verdict: verdictText(ctx, v1Row(reports['v0.3']!)) }));
    ctx.out(t(L, 'demo.summary.after', { verdict: verdictText(ctx, v1Row(viaProxy)) }));
    ctx.out('', t(L, 'demo.next'));
    return 0;
  } finally {
    await proxy?.close();
    for (const m of mocks) await m.close();
  }
}
