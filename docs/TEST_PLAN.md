# Clodds Test Plan

This plan outlines a phased approach to unit, integration, and end-to-end
testing. It assumes `node:test` with `tsx` (already in `npm test`).

## Goals

- Catch regressions in core logic (config, risk, parsing, rate limits).
- Validate integrations without hitting real external APIs.
- Enable safe CI checks for PRs.

## Test tiers

### Unit tests (fast)

Focus on pure logic with no network/IO:

- Config parsing and env overrides (`src/utils/config.ts`)
- Command parsing (`src/commands/registry.ts`)
- Risk checks (max order size, exposure, stop-loss)
- Market index scoring/filters (`src/market-index`)
- Rate limit helpers (`src/utils/http.ts`, `src/security/rate-limiter.ts`)

Target: 20–40 unit tests, <1s total runtime.

### Integration tests (local services)

Exercise components together with local-only dependencies:

- Database migrations and basic CRUD (use temp state dir)
- WebChat auth + message round-trip (WebSocket)
- Market index sync with mocked HTTP responses
- Webhook signature verification + rate limit

Target: 8–12 tests, <10s total runtime.

### End-to-end tests (optional)

Single “smoke” test that starts the gateway and hits:
- `GET /health`
- `GET /market-index/stats` (when enabled with mocks)

Keep E2E minimal to avoid flakes.

## Test scaffolding

Suggested structure:

```
tests/
  unit/
  integration/
  helpers/
```

Recommended helpers:
- `withTempStateDir()` to isolate DB/credentials/logs
- `mockFetch()` or per-module mocks for external HTTP
- `startGateway()` / `stopGateway()` fixture

## Mocking strategy

- Prefer dependency injection where possible.
- Avoid live API calls; use fixtures stored in `tests/fixtures`.
- For HTTP mocks, use in-process mocks (no new deps) or add `nock` if needed.

## CI targets

Current CI runs:

```
npm run typecheck
npm run test
npm run build
```

Planned improvements:
- Split unit/integration in CI for parallelism
- Upload coverage (optional)

## Known blockers

- None currently.

## Next actions

1. Add market index sync integration test for Kalshi/Manifold (real APIs).
2. Add coverage for `/markets` error cases (empty query, invalid platform).
3. Add integration coverage for `/market-index/search` and `/market-index/stats`.
