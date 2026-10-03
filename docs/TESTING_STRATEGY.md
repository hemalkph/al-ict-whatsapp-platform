# Testing Strategy

## Now

Vitest (`npm test`): unit tests next to the code (`*.test.ts`). Baseline: health route, `AppError`, logger.

## Planned

Unit and domain-rule tests; database integration tests; API integration tests; Meta webhook fixture tests (signature, duplicates, out-of-order statuses); authorization and tenant-isolation tests; bot-runtime tests; Playwright E2E; later load tests. Every significant bug fix gets a regression test.

## Playwright

`@playwright/test` is installed and configured (`playwright.config.ts`, specs in `./e2e`). There are no E2E specs yet, so CI has no E2E stage and does not install browsers. Add both when real E2E tests exist.

## Requirements

Lint, typecheck, test and build must pass with no `.env`, database or Docker.
