// AC-10: CI 는 작고 로컬에서 그대로 재현된다.
//  1. .github/workflows/ci.yml 의 단계 = scripts/ci.mjs 의 STEPS (이름·명령·순서)
//  2. 워크플로는 단일 job, Node 22 하나, 캐시·매트릭스·schedule 없음
//  3. 기본 스위트(test/*.test.ts)에는 흔들릴 수 있는 요소(자식 프로세스, 시그널, 타이머, 공식 SDK, 고정 포트)가 없다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers/common.js';

const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

/** ci.yml 에서 `- name: X` 바로 다음 `run: Y` 쌍을 순서대로 뽑는다. */
function workflowSteps(text: string): Array<{ name: string; cmd: string }> {
  const out: Array<{ name: string; cmd: string }> = [];
  const re = /^\s*- name: (.+)\n\s+run: (.+)$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ name: m[1]!.trim(), cmd: m[2]!.trim() });
  return out;
}

test('ci.yml run steps are identical to STEPS in scripts/ci.mjs (names, commands, order)', async () => {
  const mod: { STEPS: Array<{ name: string; cmd: string }> } = await import(join(ROOT, 'scripts', 'ci.mjs'));
  assert.equal(mod.STEPS.length, 4);
  assert.deepEqual(workflowSteps(workflow), mod.STEPS);
  assert.deepEqual(mod.STEPS.map((s) => s.name), ['Show versions', 'Install (npm ci)', 'Build', 'Test (default suite)']);
  assert.deepEqual(mod.STEPS.map((s) => s.cmd), ['node -v && npm -v', 'npm ci --no-audit --no-fund', 'npm run build', 'npm test']);
});

test('ci.yml stays minimal: one job, Node 22 only, @v6 actions, no matrix/cache/schedule', () => {
  const jobs = /^jobs:\n((?: {2,}.*\n?)+)/m.exec(workflow)?.[1] ?? '';
  assert.equal((jobs.match(/^ {2}[\w-]+:\s*$/gm) ?? []).length, 1, 'exactly one job');
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.deepEqual(workflow.match(/node-version: .+/g), ['node-version: "22"']);
  assert.deepEqual(workflow.match(/uses: .+/g), ['uses: actions/checkout@v6', 'uses: actions/setup-node@v6']);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  for (const forbidden of ['matrix', 'cache:', 'schedule', 'cron']) {
    assert.ok(!workflow.includes(forbidden), `ci.yml must not contain "${forbidden}"`);
  }
});

/** 줄 주석(` // …`)과 블록 주석을 지운다. 문자열 안의 `http://` 는 앞에 공백이 없어 남는다. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ['child process spawn', /\bspawn\s*\(/],
  ['kill()', /\.kill\s*\(/],
  ['SIGINT/SIGTERM', /\bSIG(INT|TERM)\b/],
  ['setTimeout/setInterval', /\bset(Timeout|Interval)\s*\(/],
  ['localhost literal', /localhost/],
  ['official SDK or express import', /(['"`])(a2a-v1|a2a-v03|express)(\/[^'"`]*)?\1/],
  ['listen on a fixed or variable port', /\.listen\s*\(\s*(?!0\s*[,)])/],
];

test('default suite files contain no spawn/kill/signals/timers/localhost/SDK/express/fixed ports', () => {
  const dir = join(ROOT, 'test');
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts') && f !== 'ci-parity.test.ts');
  assert.ok(files.length >= 8, `expected the default suite files, got ${files.join(', ')}`);
  // Helpers imported by the default suite (./helpers/*) are scanned too; the e2e-only helpers are not imported here.
  const helpers = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/from\s+'\.\/helpers\/([\w.-]+?)\.js'/g)) helpers.add(`${m[1]}.ts`);
  }
  for (const h of ['broken-upstream.ts', 'common.ts', 'expected.ts']) assert.ok(helpers.has(h), `expected the default suite to import helpers/${h}`);
  const targets = [...files.map((f) => ({ label: f, path: join(dir, f) })), ...[...helpers].map((h) => ({ label: `helpers/${h}`, path: join(dir, 'helpers', h) }))];
  const problems: string[] = [];
  for (const t of targets) {
    const code = stripComments(readFileSync(t.path, 'utf8'));
    for (const [what, re] of FORBIDDEN) if (re.test(code)) problems.push(`${t.label}: ${what} — move this to test/e2e or test/interop`);
  }
  assert.deepEqual(problems, []);
});

test('the e2e and interop suites exist so no test was dropped', () => {
  for (const sub of ['e2e', 'interop']) {
    const files = readdirSync(join(ROOT, 'test', sub)).filter((f) => f.endsWith('.test.ts'));
    assert.ok(files.length >= 1, `test/${sub} has no test files`);
  }
});
