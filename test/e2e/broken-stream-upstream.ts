// E2E-only helper: a 0.3 upstream that answers badly (html error, cut stream, hung stream).
// The default suite uses test/helpers/broken-upstream.ts (html mode only, no timers).
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const v03Card = (base: string) => ({
  name: 'broken', description: 'broken upstream', version: '1', protocolVersion: '0.3', url: `${base}/rpc`, preferredTransport: 'JSONRPC',
  capabilities: { streaming: true }, defaultInputModes: ['text'], defaultOutputModes: ['text'], skills: [],
});

export type BrokenMode = 'html' | 'cut-stream' | 'hang';

/** POST 마다 mode 에 따라 엉터리로 답하는 0.3 업스트림. */
export async function brokenUpstream(mode: { value: BrokenMode }, onStreamClosed?: () => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v03Card(base)));
      return;
    }
    req.resume();
    req.on('end', () => {
      if (mode.value === 'html') {
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end('<html>bad gateway</html>');
      } else if (mode.value === 'hang') {
        // 이벤트 하나를 보내고 끝내지 않는 스트림(느린 LLM 에이전트 흉내)
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"jsonrpc":"2.0","id":1,"result":{"kind":"task","id":"t","contextId":"c","status":{"state":"working"}}}\n\n');
        res.on('close', () => onStreamClosed?.());
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"jsonrpc":"2.0","id":1,"result":{"kind":"task","id":"t","contextId":"c","status":{"state":"working"}}}\n\n');
        res.write('data: {"jsonrpc":"2.0","id":1,"res'); // 이벤트 중간에서
        setTimeout(() => res.socket?.destroy(), 20); // 연결을 끊는다
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
