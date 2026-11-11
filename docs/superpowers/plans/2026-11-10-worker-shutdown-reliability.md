# Worker Shutdown Reliability Implementation Plan

**Goal:** Implement the owner's Worker Shutdown Reliability authorization without C1B, authorization changes, staging, commits, pushes or deployment.

**Architecture:** Retain each worker's current orchestration and durable lease/fence rules. Compare tsx CLI and Node preload with the same instrumented child, then use the demonstrated safe launcher. One memoized pool close stays inside each worker's original shutdown deadline.

**Tech stack:** Node 24.21.0, tsx 4.23.15, Vitest, guarded isolated PostgreSQL 17.

**Spec:** Owner's Worker Shutdown Reliability — Implementation Authorization in this session. Execution is already explicitly authorized; implement directly in this session.

## Constraints and review focus

- Bot/webhook/outbound budgets remain 35/70/30 seconds; exit 0 requires successful cleanup, failures/deadlines exit 1, existing refusals exit 2.
- Stop new claims; finish already-started claims under existing fencing. Never resend an uncertain outbound send.
- Only approved container `al-ict-phase08c-test-pg`, loopback `127.0.0.1:55432`, maintenance `postgres`, fresh guarded scratch names; DATABASE_URL unset for database test commands. No permanent database, credentials or real transport access.
- Check pending preflight/claim, repeated signals, rejected/throwing/hanging close, concurrent load and forced recovery. No generic lifecycle framework or worker build pipeline.

## Tasks

- [x] Instrument `bot-worker/process.test.ts` and `__fixtures__/shutdown-child.ts`: retain parent/application identity, signal send/ack, drain, close, exit and full output on close; handle spawn failures. Compare current launcher and Node preload, including controlled event-loop contention. Preserve all study outcomes.
- [x] Correct `whatsapp/worker/run.ts` and `messaging/worker.ts`; retain bot implementation unless tests expose a gap. Memoize closure, keep the deadline through closure, report failures. Add controlled lifecycle regressions for all three workers, pending operations and claims.
- [x] Update only the three package worker commands and their structural assertions if compatibility is proven. Verify env option with a synthetic temporary file, aliases, cwd and runtime dependency installation. Do not load local application credentials in compatibility tests.
- [x] Run focused unit/process tests first, bounded repeated signal tests under normal/parallel/CPU load, then the normal full unit suite. Retain failed attempts.
- [x] Verify container identity and harness guards before each database command. Run focused worker/recovery tests and full guarded database suite. Add missing real-process bot/outbound recovery and pool-session checks with fake transports.
- [x] Update deployment/testing/blockers documentation with evidence, exact commands, runtime assumptions, supervisor gate and separate provisioning-pool follow-up. Inspect complete diff; run formatting, lint and typecheck. Report every failure and open gate, with exactly one owner-specified verdict.

Implementation and local validation completed; see [the checkpoint record](../../WORKER_SHUTDOWN_RELIABILITY.md). The selected-supervisor and target-installation gates remain open.
