# Testing Strategy

## Now

Vitest (`npm test`): unit tests next to the code (`*.test.ts`). Baseline: health route, `AppError`, logger.

## Planned

Unit and domain-rule tests; database integration tests; API integration tests; Meta webhook fixture tests (signature, duplicates, out-of-order statuses); authorization and tenant-isolation tests; bot-runtime tests; Playwright E2E; later load tests. Every significant bug fix gets a regression test.

## Authentication and authorization tests (core implemented; provisioning/management tests come with their services)

Unit: permission matrix (every role x permission, explicit expectations), same-origin and redirect-target guards, strict input schemas. Real-PostgreSQL integration: auth table constraints, sign-up disabled over HTTP and server API, provisioning intent uniqueness and cross-organization claim rejection, recovery after a simulated crash between user creation and membership creation, adapter `transaction: true` rollback (no user without credential), email case cannot create duplicate identities, suspended membership denied with a valid session, tenant isolation, privilege-escalation and mass-assignment attempts, database rate limiter (explicitly enabled in tests; it is off outside production). Playwright E2E (login, logout, protected navigation) comes later.

## Playwright

`@playwright/test` is installed and configured (`playwright.config.ts`, specs in `./e2e`). There are no E2E specs yet, so CI has no E2E stage and does not install browsers. Add both when real E2E tests exist.

## Requirements

Lint, typecheck, test and build must pass with no `.env`, database or Docker. Database integration tests run on real PostgreSQL via `npm run test:db` (`vitest.db.config.mts`, files `src/**/*.db.test.ts`) and are never part of `npm test`. Each test file creates and drops its own empty database on a **local** server (default `postgresql://postgres:postgres@localhost:5432/postgres`, override with `TEST_DATABASE_ADMIN_URL`; non-local hosts are refused) and migrates it from the committed migration files. Start it with `docker compose up -d`.
