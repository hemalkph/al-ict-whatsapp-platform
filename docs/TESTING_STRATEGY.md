# Testing Strategy

## Now

Vitest (`npm test`): unit tests next to the code (`*.test.ts`). Baseline: health route, `AppError`, logger.

## Planned

Unit and domain-rule tests; database integration tests; API integration tests; Meta webhook fixture tests (signature, duplicates, out-of-order statuses); authorization and tenant-isolation tests; bot-runtime tests; Playwright E2E; later load tests. Every significant bug fix gets a regression test.

## Authentication and authorization tests (core implemented; provisioning/management tests come with their services)

Unit: permission matrix (every role x permission, explicit expectations), same-origin and redirect-target guards, strict input schemas. Real-PostgreSQL integration: auth table constraints, sign-up disabled over HTTP and server API, provisioning intent uniqueness and cross-organization claim rejection, recovery after a simulated crash between user creation and membership creation, adapter `transaction: true` rollback (no user without credential), email case cannot create duplicate identities, suspended membership denied with a valid session, tenant isolation, privilege-escalation and mass-assignment attempts, database rate limiter (explicitly enabled in tests; it is off outside production). Playwright E2E (login, logout, protected navigation) comes later.

## Staff lifecycle tests

`src/modules/access/staff/*.test.ts`: strict-schema unit tests, plus real-PostgreSQL + real Better Auth tests for create/resume/refuse flows, role and suspension rules, the global session rule, organization-exclusive password reset, mass-assignment rejection, generic-refusal indistinguishability, and concurrency (two- and three-admin races repeated per run). Failure injection uses a second Drizzle instance over the same pool (`serviceDb`) so only the service's own transaction fails.

## Entrypoint tests

`src/proxy.test.ts` and `page-access.test.ts` (DB-free: proxy behavior, redirect decisions, loop simulation over every user state); real-PostgreSQL: `route.db.test.ts` (public route, closed paths, private-provisioner boundary, login/logout, events, proxy vs real access), `password-change.db.test.ts` (forced change, failure ordering and fail-closed retry), `bootstrap.db.test.ts` and `intent-recovery.db.test.ts` (including real CLI runs through `tsx`, with no secrets in output).

## Password-reset concurrency tests

`src/modules/access/staff/reset-password.db.test.ts` (real PostgreSQL + Better Auth): concurrent resets of different users (token ownership verified against each token's verification row), concurrent resets of the same user (both complete; last writer wins), and a failure after the token was issued (token never logged/returned, public reset surface closed, old password valid, retry succeeds). Re-run on every Better Auth upgrade.

## Playwright

`@playwright/test` is installed and configured (`playwright.config.ts`, specs in `./e2e`). There are no E2E specs yet, so CI has no E2E stage and does not install browsers. Add both when real E2E tests exist.

## Requirements

Lint, typecheck, test and build must pass with no `.env`, database or Docker. Database integration tests run on real PostgreSQL via `npm run test:db` (`vitest.db.config.mts`, files `src/**/*.db.test.ts`) and are never part of `npm test`. Each test file creates and drops its own empty database on a **local** server (default `postgresql://postgres:postgres@localhost:5432/postgres`, override with `TEST_DATABASE_ADMIN_URL`; non-local hosts are refused) and migrates it from the committed migration files. Start it with `docker compose up -d`.
