// 테스트 공통 도우미: 레포 루트, fixture 읽기, CLI 자식 프로세스 실행, SSE 받기.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 컴파일된 위치: dist-test/test/helpers/common.js -> 레포 루트는 세 단계 위
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CLI = join(ROOT, 'dist', 'cli', 'main.js');

export function fixture<T = any>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', rel), 'utf8')) as T;
}

export function fixturePath(rel: string): string {
  return join(ROOT, 'test', 'fixtures', rel);
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** CLI 를 자식 프로세스로 실행한다. 언어 관련 환경 변수는 기본으로 비워 둔다(테스트가 직접 정함). */
export function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<CliResult> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !['A2A_COMPAT_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG'].includes(k)) base[k] = v;
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) base[k] = v;
  base.NO_COLOR = '1';
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: base, cwd: ROOT, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

export async function rpc(url: string, method: string, params: unknown, header?: string): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (header) headers['A2A-Version'] = header;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) });
  return res.json();
}

/** SSE 응답을 끝까지 읽어 data 줄의 JSON 들을 돌려준다. */
export async function sse(url: string, method: string, params: unknown, header?: string): Promise<{ contentType: string; events: any[] }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (header) headers['A2A-Version'] = header;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method, params }) });
  const text = await res.text();
  const events = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)));
  return { contentType: res.headers.get('content-type') ?? '', events };
}

/** 실행마다 달라지는 값(id·시간)을 자리표시자로 바꿔 두 응답의 모양을 비교할 수 있게 한다. */
export function normalizeIds<T>(value: T): T {
  const KEYS = new Set(['id', 'contextId', 'taskId', 'messageId', 'timestamp']);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, KEYS.has(k) && (typeof x === 'string' || typeof x === 'number') ? `<${k}>` : walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

export const msgV1 = (text = 'hi') => ({ message: { role: 'ROLE_USER', messageId: `m-${Math.random().toString(36).slice(2)}`, parts: [{ text }] } });
export const msgV03 = (text = 'hi') => ({ message: { kind: 'message', role: 'user', messageId: `m-${Math.random().toString(36).slice(2)}`, parts: [{ kind: 'text', text }] } });
