// Test helper: a 0.3 upstream that answers every POST with an HTML 502 page.
// Stream cut/hang modes (which need timers) live in test/e2e/broken-stream-upstream.ts.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const v03Card = (base: string) => ({
  name: 'broken', description: 'broken upstream', version: '1', protocolVersion: '0.3', url: `${base}/rpc`, preferredTransport: 'JSONRPC',
  capabilities: { streaming: true }, defaultInputModes: ['text'], defaultOutputModes: ['text'], skills: [],
});

export type BrokenMode = 'html';

/** Serves a card on GET and an HTML 502 on POST. */
export async function brokenUpstream(_mode: { value: BrokenMode }): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v03Card(base)));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html>bad gateway</html>');
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
