# Changelog

## 0.1.3

- Tests split into three suites: `npm test` (default, what CI runs, 98 tests), `npm run test:e2e` (CLI child processes, local) and `npm run test:interop` (official SDK interoperability, local); `npm run test:all` runs all, `npm run ci:local` mirrors the CI workflow.
- CI: the workflow is now a single job on Node.js 22 (build, then the default suite) with a 15-minute job timeout; the weekly schedule, Node 20/24 matrix and npm debug-log step are removed.
- Error messages for untranslated methods (push notification configs, extended card) and for REST/gRPC-only upstream cards no longer mention internal milestones; the wording now says these are not supported. Translation behavior is unchanged.

## 0.1.2

- CI hardening: minimal workflow permissions, job and step timeouts, Node 20 and 24 matrix without fail-fast, npm debug log on install failure.
- `npm test` runner prints the Node version, applies per-test (2 min) and total (8 min) time limits, and reports a timeout or kill signal instead of hanging.
- No runtime behavior change.

## 0.1.1

- Fix CI: GitHub Actions updated to v6, tests wait for child process `close` instead of `exit`, timers are cleaned up.

## 0.1.0

First release.

- `check`: compatibility matrix for 0.3 and 1.0 clients with fixed cause codes, `--require` for CI, optional `--probe-send`.
- `card validate` / `card convert`: validate against both bundled schemas, convert between 0.3, 1.0 and hybrid cards with fixed warning codes; `--rewrite-url` keeps the `PROTOCOL_VERSION_PATCH` warning.
- `proxy`: local translating JSON-RPC/SSE proxy between A2A 0.3 and 1.0, with agent card rewriting; `--public-url` sets the address written into the translated card (needed when binding `0.0.0.0`). The log counts translated stream events.
- `demo` and three practice mock agents for offline use.
- English and Korean screens (`--lang en|ko`, `A2A_COMPAT_LANG`).
- Library API: `toV1`, `toV03`, `convertCard`, `validateCard`, `checkEndpoint`, `createProxy`, `startMockAgent`.
- `npm test` works on Node.js 20 (test files are listed by `scripts/run-tests.mjs`).
- JSON-RPC binding only; REST, gRPC, push-notification config and the extended card method are not translated yet.
