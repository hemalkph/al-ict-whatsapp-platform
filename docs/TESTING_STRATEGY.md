# Testing Strategy

## Now

Vitest (`npm test`): unit tests next to the code (`*.test.ts`). Baseline: health route, `AppError`, logger.

## Planned

Unit and domain-rule tests; database integration tests; API integration tests; Meta webhook fixture tests (signature, duplicates, out-of-order statuses); authorization and tenant-isolation tests; bot-runtime tests; Playwright E2E; later load tests. Every significant bug fix gets a regression test.

## Authentication and authorization tests (core implemented; provisioning/management tests come with their services)

Unit: permission matrix (every role x permission, explicit expectations), same-origin and redirect-target guards, strict input schemas. Real-PostgreSQL integration: auth table constraints, sign-up disabled over HTTP and server API, provisioning intent uniqueness and cross-organization claim rejection, recovery after a simulated crash between user creation and membership creation, adapter `transaction: true` rollback (no user without credential), email case cannot create duplicate identities, suspended membership denied with a valid session, tenant isolation, privilege-escalation and mass-assignment attempts, database rate limiter (explicitly enabled in tests; it is off outside production). Browser E2E (login, forced password change, logout, redirects, proxy, staff API, same-origin) is implemented: see Browser E2E below.

## Staff lifecycle tests

`src/modules/access/staff/*.test.ts`: strict-schema unit tests, plus real-PostgreSQL + real Better Auth tests for create/resume/refuse flows, role and suspension rules, the global session rule, organization-exclusive password reset, mass-assignment rejection, generic-refusal indistinguishability, and concurrency (two- and three-admin races repeated per run). Failure injection uses a second Drizzle instance over the same pool (`serviceDb`) so only the service's own transaction fails.

## Entrypoint tests

## Staff API route tests

`src/modules/access/staff/staff-api.db.test.ts` (real route handlers, real session cookies, real PostgreSQL + Better Auth): 401/403 matrix per role, forged org/role headers, same-origin matrix on every mutation route, content-type/body validation, list DTO and tenant scoping, create (201, normalized email, generic indistinguishable 409s, mass assignment), role/suspend/reactivate/reset behavior including last-admin races, foreign-vs-missing id indistinguishability, a secrets-in-responses-and-logs regression test and a route-import-boundary test. Kept under `src/modules/access` because lint forbids `src/app` from importing `@/db` helpers.

`src/proxy.test.ts` and `page-access.test.ts` (DB-free: proxy behavior, redirect decisions, loop simulation over every user state); real-PostgreSQL: `route.db.test.ts` (public route, closed paths, private-provisioner boundary, login/logout, events, proxy vs real access), `password-change.db.test.ts` (forced change, failure ordering and fail-closed retry), `bootstrap.db.test.ts` and `intent-recovery.db.test.ts` (including real CLI runs through `tsx`, with no secrets in output).

## Password-reset concurrency tests

`src/modules/access/staff/reset-password.db.test.ts` (real PostgreSQL + Better Auth): concurrent resets of different users (token ownership verified against each token's verification row), concurrent resets of the same user (both complete; last writer wins), and a failure after the token was issued (token never logged/returned, public reset surface closed, old password valid, retry succeeds). Re-run on every Better Auth upgrade.

## Browser E2E (Playwright, Chromium)

`npm run test:e2e` (never `playwright test` directly: the config refuses to start without the values the orchestrator provides). `scripts/e2e.ts` owns one run:

1. Creates a dedicated database `al_ict_e2e_<random>` on a **local** server (same harness and host guard as the DB tests; `TEST_DATABASE_ADMIN_URL` overrides the default) and migrates it from the committed migrations. It never reads `DATABASE_URL`, so a developer's application database cannot be reached.
2. Seeds the minimum identities (`e2e/support/identities.ts`): the first admin through the real bootstrap workflow (so it must change its password), everything else through the private provisioning instance plus a membership row (the integration tests' `provisionUser` pattern).
3. Builds the app (skipped with `E2E_SKIP_BUILD=1`, which CI uses after its own build step) and serves the **production build** with `NODE_ENV=production` through `e2e/server.mjs`. Production requires an https `BETTER_AUTH_URL` and `next start` has no https option, so the same build is served over HTTPS by Next's documented custom-server API with a throwaway self-signed certificate (created with `openssl` in a temp directory and deleted afterwards). The browser therefore also exercises `Secure` / `__Secure-` cookies.
4. Runs Playwright (config: `playwright.config.ts`, specs in `e2e/`), then scans the application server's output for errors and fails the run on any.
5. Drops the database in `finally` (also after failures and Ctrl-C). A database that cannot be dropped (a leaked connection) is reported loudly and fails the run.

The auth secret is a test-only constant inside `scripts/e2e.ts`; the fake passwords live in `e2e/support/identities.ts`. Neither protects anything outside a database that exists for one run.

**Coverage (36 tests, deliberately focused; the 300+ DB/integration tests cover the permutations):** logged-out redirect with a safe `next`; invalid login (generic message, no session, no enumeration); first login to forced password change with every other page and the staff API blocked; the change form (wrong current password, mismatch, too short, server-side rule); successful change (gate cleared, replacement cookie, reload, other sessions revoked, old password dead, new one works); logout (database session deleted, stale cookie useless); 19 hostile `?next=` values plus a valid internal path; the proxy versus real authorization (no cookie, forged cookie, revoked cookie); the staff API from a signed-in browser (ADMIN create/role/suspend/reactivate, STAFF read-only, VIEWER denied, forged `x-organization-id`/`x-role`, mass assignment, foreign id = 404, no secrets in bodies); same-origin (correct origin accepted; foreign, `null`, malformed, missing and `cross-site` evidence rejected with the real session; a real cross-site browser request carries no cookie and gets 401); login rate limiting reaching 429 in the UI.

**Design notes and things learned while building it**

- **Client IP.** Next's server adds `x-forwarded-for` from the socket address, so every browser here arrives from one IP and the database limiter correctly trips after five logins. Each test therefore presents its own deterministic client IP header (the integration tests' `uniqueIp()` technique); application proxy-header trust is unchanged. The rate-limit test uses one fixed IP on purpose. It proves the limiter is wired into the production build and that the UI reports it. It does **not** prove client-IP trust: the header is supplied by the test, which is exactly the property that makes production IP propagation a deployment blocker (see `PRE_PRODUCTION_BLOCKERS.md`).
- **Cross-site proof.** A page on a public origin cannot call a loopback server (Chromium's private-network-access rules block it before the application sees it), which would prove nothing. The test uses `https://localhost:PORT` against `https://127.0.0.1:PORT`: different sites, so SameSite=Lax keeps the host-only session cookie off the request.
- **No retries.** Tests change real state (passwords, sessions, memberships) in one database, so a retry would run against already-changed data and could only hide a deterministic bug. Files own distinct identities and run in parallel; tests inside a file run in order (the first-login flow is an intentional serial suite).
- **Artifacts.** `test-results/`, `playwright-report/` and `e2e-output/` are git-ignored. Traces and screenshots are kept for failures only. A trace contains request bodies and cookies: the fake test password and the session of a database dropped right after the run. Verified by inspecting a real failure trace: it contains neither `BETTER_AUTH_SECRET`, nor database credentials, nor the database name. CI uploads artifacts on failure only, for 7 days.
- Every test fails on an uncaught page exception or an unexpected browser console error.

## Requirements

Lint, typecheck, test and build must pass with no `.env`, database or Docker. Database integration tests run on real PostgreSQL via `npm run test:db` (`vitest.db.config.mts`, files `src/**/*.db.test.ts`) and are never part of `npm test`. Each test file creates and drops its own empty database on a **local** server (default `postgresql://postgres:postgres@localhost:5432/postgres`, override with `TEST_DATABASE_ADMIN_URL`; non-local hosts are refused) and migrates it from the committed migration files. Start it with `docker compose up -d`.
