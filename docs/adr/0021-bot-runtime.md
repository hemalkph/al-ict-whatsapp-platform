# ADR 0021: Bot runtime: trigger queue, step transaction, reconciliation and the bot worker (Phase 08E)

- **Status:** Implemented in Phase 08E (`29913a7` to `cb75952`, branch `Bot-Foundation`), with live automation **not authorized**. Final independent closure review is pending; see [PHASE_08E_ACCEPTANCE.md](../PHASE_08E_ACCEPTANCE.md). Every gate defaults OFF.
- **Context:** Phase 08-0 architecture V3.2 (sections F–L, N, O.10, O.11); the Phase 08E implementation plan, Revision 3 with its owner decisions (O-1, O-1b, O-2, O-3, O-4, C-1 to C-4), the F3 acceptance clarification and amendment A-6BOT (`~/Desktop/PHASE_08E_IMPLEMENTATION_PLAN.md`, outside the repository); ADRs [0017](0017-bot-flow-contract.md), [0018](0018-bot-execution-engine.md), [0019](0019-bot-persistence.md) and [0020](0020-bot-outbound-dispatch.md), which this ADR does not change.

Every statement below describes the code at `cb75952` and is pinned by the named tests on disposable PostgreSQL 17 with a `FakeTransport`. None of it has run against Meta or a production database.

## Decision

### 1. Shape: three processes, one database

| Process                                                  | Code                                                                                        | Role                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| P-W webhook worker (`npm run whatsapp:worker`)           | `whatsapp/inbound/handler.ts`, `whatsapp/worker/registry.ts`, `db/ops/bot-trigger.ts`       | Captures a trigger row inside the inbound transaction (dormant unless its own gate is on).                                |
| P-B bot worker (`npm run bots:worker`)                   | `bot-worker/` (run, loops, compose), `bot-runtime/` (step, trigger-queue, reconcile, apply) | Claims triggers, runs the step transaction (T1), records failures (T2), terminalizes, reconciles and sweeps. Never sends. |
| P-D outbound worker (`npm run whatsapp:outbound-worker`) | `messaging/dispatch.ts`, `messaging/bot-authorization.ts` (08D, unchanged)                  | The only sender. Claims BOT rows only with its own `BOTS_RUNTIME_ENABLED`.                                                |

`bot-runtime/outbound.ts` is the only production importer of `enqueueAutomatedMessage`. The runtime imports no transport, never writes `outbound_requests.state` except `QUEUED → HELD` through the suppression primitive, and never calls Meta (`bot-runtime/boundaries.test.ts`, `messaging/boundaries.test.ts`).

### 2. Trigger capture (08E-2)

- Inside the inbound savepoint, after activity, reopening and attribution, so the conversation row lock is already held. Admission is a filter only: type `TEXT`, `INTERACTIVE` or `BUTTON`; an `ACTIVE` deployment for the account or a live session of an `ACTIVE`/`PAUSED` deployment; fewer than 20 `PENDING` triggers in the conversation.
- `observed_control_seq` is read after the activity update; `input_occurred_at` is the effective activity time; `enqueued_at` is `clock_timestamp()`.
- A recoverable capture SQL error rolls back a **nested** savepoint, logs `bots.trigger_capture_failed` (ids and a code only) and keeps the message. The omitted trigger is permanent: duplicate delivery does not repair it and there is no backfill. A connection loss rolls back the whole event, which is retried exactly (C1–C3).
- With the gate off, the handler's SQL is byte-identical to the pre-08E handler (statement-equality test against `29913a7`, with mutation controls).

Tests: `whatsapp/inbound/trigger-capture.db.test.ts` (E-CAP, E-CAPFAIL, C1–C3).

### 3. Trigger queue: claim, fences and terminalization (08E-3)

- **Claim (T0)** is one committed statement: `PENDING`, `attempts < 6`, due, no live claim (or the 60 s lease expired), and head of line for its conversation by `(input_occurred_at, id)`; `FOR UPDATE SKIP LOCKED`; it increments `attempts` and sets a fresh `claim_token` and `claimed_at`. A claimed row stays `PENDING`, so head-of-line holds across workers.
- **Fences.** Every later write to a claimed trigger matches `organization_id`, `id`, `status = 'PENDING'` and the exact `claim_token`. A stale worker changes nothing; zero rows means "lost the claim".
- **T1 start guard.** T1 starts only within 20 s of the claim, so a healthy T1 (bounded at 25 s) ends before the 60 s lease.
- **T2** records a thrown T1 on a fresh connection: claim cleared, backoff 5 s, 15 s, 45 s, 2 min, 5 min (±20 %), `last_error_code`.
- **Deferral** clears the claim, refunds the attempt once and advances along the 2/4/8/15 s ladder (`deferrals ≤ 1000`).
- **Terminalization.** A trigger with `attempts = 6` and no live claim becomes `DEAD attempts_exhausted`; when a live session exists the terminalizer hands it over (`system_handover` / `bot_error`) and holds its `QUEUED` request through the session-scoped suppression, in one transaction. A sixth attempt that is still running holds its row and is skipped; a successful sixth attempt is never `DEAD`.

Tests: `trigger-claim.db.test.ts` (E-CLAIM), `trigger-dead.db.test.ts` (R1 a–d with mutations), `trigger-queue.test.ts`, `backoff.test.ts`.

### 4. The step transaction (T1) and its lock order (08E-4)

One transaction per claimed trigger, `lock_timeout` 5 s (`SET LOCAL`), in this order (`bot-runtime/step.ts`, `db/ops/bot-step.ts`):

1. trigger row `FOR UPDATE` (exact claim token, start guard);
2. conversation advisory **try**-lock;
3. contact advisory **try**-lock (start path only, serializing the per-contact session cap);
4. deployment(s) `FOR SHARE` in id order;
5. conversation `FOR UPDATE`;
6. live session `FOR UPDATE` (re-read);
7. account `FOR SHARE`;
8. the **decision clock**: `clock_timestamp()` read after the last blocking lock. Runtime SQL never uses `now()`, `current_timestamp` or `transaction_timestamp()` (static test).

A busy try-lock never waits: a stale input is finished `IGNORED stale_trigger` and a fresh one is deferred, both under the claim fence (plan K.1a). Nothing holding a conversation lock waits for a trigger row: wake and end use `FOR UPDATE SKIP LOCKED` (J.4a). Request rows are never locked except through the suppression primitive. The reconciler and the terminalizer take the same order from the trigger or advisory lock onward, so they meet T1 at the first shared lock and cannot form a cycle.

Inside T1, freshness (`maxInputAge` 10 min) is checked before any deferral, for start and continuation alike. Start eligibility is the pure `evaluateStartEligibility` (H.2 as corrected in V3.1, with the owner-approved limits: cooldown 30 min, 3 sessions per contact per 24 h across accounts, 30 BOT requests per conversation per rolling hour by `created_at`, replays not counted). Matching uses `bots/trigger-match.ts` (`triggerKey` equals the validator's `comparisonKey`). `first_message` reads retained eligible inbound history in `(created_at, id)` order **and** an all-state session-history fence under the conversation lock (plan D.4a). Provider time never decides it.

The session row is written before the enqueue, and both are in one commit. A post-enqueue clock skew greater than 2 s rolls back and re-decides the trigger alone.

Tests: `step.db.test.ts` (R4, R7, R9b, R9c, R-CAP, E-HOURLY, ENG, E-REF), `staff-before-start.db.test.ts`, `decision-clock.db.test.ts` (E-CLK), `lock-order.db.test.ts` (R3-P), `first-message-ordering.db.test.ts` and `first-message-trigger.db.test.ts` (E-FIRST F1–F4, F6, F8), `button-start-eligibility.db.test.ts`, and the pure suites `eligibility.test.ts`, `input.test.ts`, `session-row.test.ts`, `takeover.test.ts`, `step.test.ts`.

### 5. Control sequences

The 0007/0008 allocator stamps `control_seq` under the conversation row lock on every outbound request, conversation event and session start or handover (`started_control_seq`, `handover_control_seq`). The runtime compares these numbers, never timestamps, to decide whether staff acted after a session started or after an input was captured. `conversations.control_seq` equals the number of allocations across mixed staff and bot writers (`control-sequence.db.test.ts`, E-CTL).

### 6. Stop and staff takeover

- **Staff takeover in the step.** Under the T1 locks, a staff event sequenced after the session started ends it before any bot output: an assignment or staff reply hands it over (`staff_*`), a resolution completes it `conversation_resolved`, with precedence assignment, then reply, then resolution or other status (plan I.1). A live session of a stopped deployment is handed over `deployment_stopped` first.
- **Session-scoped suppression** (`bot-control/suppression.ts`, `suppressSessionQueuedRequests`) is the 08D two-statement shape restricted to one session: candidates `FOR UPDATE OF r SKIP LOCKED`, then hold only the rows this transaction locked. It never waits on a request a dispatcher holds; a skipped request is left to the dispatcher's own rules (staff fence, epoch, deadline).
- **Dispatcher.** The 08D claim and final pre-HTTP authorization hold any BOT request once a staff control event is sequenced after the session started (`staff_took_over`), once the epoch changed (`bot_epoch_superseded`), or once the session was suppressed (`bot_output_suppressed`).

Tests: `staff-takeover-suppression.db.test.ts` (R3-S-B B1–B5, including B4 for the real STAFF submission through the test-only pausing database), `session-suppression.db.test.ts` (R3-S-A, R3-O: witness P0–P5 captured before the candidate FETCH, production P6/P7 skip, legacy 40P01 control), `deadline-suppression.db.test.ts` (R3-S-C), `stop-boundary.db.test.ts` (R5), `staff-concurrency.db.test.ts`, `pause-drain.db.test.ts` (O.4).

### 7. Terminal notices

- The engine marks an END or HANDOVER message as the terminal notice (ADR 0018). The runtime enqueues it and records `terminal_notice_step_seq` **in the same commit** that makes the session terminal, including a first-node END or HANDOVER.
- An END or HANDOVER **without** a message ends the session with no request and `terminal_notice_step_seq` NULL. A notice the enqueue refuses (for example an archived contact) does the same and records `TERMINAL_NOTICE_NOT_QUEUED`.
- The dispatcher's terminal branch sends only the step equal to `terminal_notice_step_seq`, subject to every other rule. The reconciler never touches a terminal session or its notice, except that a notice it has just authorized is exempt from its own post-apply hold (the 08E-6 review correction).
- A committed first-node END or HANDOVER, with or without a notice, consumes the conversation's `first_message` opportunity.

Tests: `terminal-notice.db.test.ts` (R8 F, G, H, J), `step.db.test.ts` (R8 A, B, I), `reconcile-notice.db.test.ts` (A, B, D, E and the exemption mutation), `early-reply.db.test.ts` (refused notices), `first-message-trigger.db.test.ts` P3 (END with and without, HANDOVER with and without a notice).

### 8. Reconciliation, committed and unknown outcomes

The reconciler is the only path from a request's final state to the session (`bot-runtime/reconcile.ts`). Per live candidate, one transaction: conversation advisory try-lock (busy: skip until a later sweep), deployment `FOR SHARE`, conversation `FOR UPDATE`, session `FOR UPDATE`, decision clock, plain re-reads, one transition:

| Latest request                        | Transition                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `ACCEPTED`                            | engine `send_result ACCEPTED` (next prompt or step; deferred triggers woken)          |
| `HELD`, `REJECTED`, `UNKNOWN_OUTCOME` | `HANDED_OVER` `send_held`, `send_rejected`, `send_outcome_unknown`; request untouched |
| `QUEUED` past deadline + 30 s         | hold `bot_send_deadline`; if held, engine `send_result HELD`; if skipped, nothing     |
| `SENDING` past `send_wait_expires_at` | `HANDED_OVER send_outcome_unresolved`; request untouched                              |
| no request for the step               | `FAILED` / `error`, `ERROR send_state_missing`                                        |

Only the dispatcher's acceptance record makes a request `ACCEPTED`. `UNKNOWN_OUTCOME` and `HELD` are never re-queued, recreated or resent, and BOT `SENDING → QUEUED` is forbidden by the 0008 guard. The record path keeps no short `lock_timeout`: waiting behind a reconciler or terminalizer is latency, never a false `UNKNOWN_OUTCOME` (R3-L). A COMMIT-stage error on the record is never retried; when acceptance did not commit, the fenced fallback is `UNKNOWN_OUTCOME accepted_but_not_recorded`; when it did, `ACCEPTED` and its wamid survive (RT7a–e).

Tests: `reconcile.db.test.ts` (E-REC row by row, E-MISS, interrupted reconciliation), `acceptance-pairings.db.test.ts` (R3-L, both orders, lock-timeout mutations), `early-reply.db.test.ts` (R2, R9), `trigger-drain.db.test.ts` (E-DRAIN), `bot-control/dispatch.db.test.ts` (RT7a–e).

### 9. Recovery and the transaction bound

- Every bot-worker connection carries `transaction_timeout` 25 s, `idle_in_transaction_session_timeout` 10 s and `statement_timeout` 15 s as startup parameters; the preflight refuses PostgreSQL below 17, a pool whose settings did not apply, and an unmigrated schema. A terminated transaction rolls back and releases its locks; dead connections are evicted.
- Crash points: before T0 commits, nothing is consumed; after T0, the 60 s lease makes the trigger reclaimable; inside T1, everything rolls back; a lost T2 leaves the claim to the lease; after six attempts, terminalization.
- Shutdown stops claiming and sweeping, waits up to the transaction bound plus 10 s, closes the pool, and otherwise exits non-zero (the server rolls back; leases recover claims).

Tests: `bot-worker/transaction-bound.db.test.ts` (E-TO), `bot-worker/worker.db.test.ts` (start, preflight, killed connections, shutdown), `bot-worker/r6.db.test.ts` (R6), `trigger-dead.db.test.ts`, `reconcile.db.test.ts`, `first-message-trigger.db.test.ts` (F8 P1/P2).

### 10. Gates

Every gate is "exactly the string `true`"; anything else is off; nothing defaults on.

| Gate                         | Read by                                | Effect                                                                              |
| ---------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `BOTS_RUNTIME_ENABLED`       | P-W                                    | builds the dormant capture dependency                                               |
| `BOTS_RUNTIME_ENABLED`       | P-B (with `WHATSAPP_OUTBOUND_ENABLED`) | the bot worker may start; `enqueueAutomatedMessage` refuses unless both are on      |
| `BOTS_RUNTIME_ENABLED`       | P-D                                    | the dispatcher may claim BOT rows                                                   |
| `WHATSAPP_OUTBOUND_ENABLED`  | P-B, P-D, web app                      | bot worker start (P-B); outbound worker start (P-D); staff queuing in the API (08D) |
| `WHATSAPP_LIVE_SEND_ENABLED` | P-D only                               | real HTTP to Meta, re-checked at the call                                           |

A bot message can reach Meta only when all three gates are on in P-D (plan M row 8), or in the narrow row 6 case of a `QUEUED` BOT request left from an earlier run and still inside its 120 s deadline. With every gate off, nothing is written by bot code and no transport is called. The web app, the build and migrations never start a worker; only the npm scripts and isolated tests do. See `.env.example`.

Tests: `gates.db.test.ts` (E-GATE rows 1–8 through the production entry points), `bot-runtime/config.test.ts`, `bot-worker/config.test.ts`, `bot-worker/run.test.ts`.

### 11. Migration 0009 (decision O-4)

Two performance-only indexes justified by the Batch 5 EXPLAIN evidence (`queue-explain.db.test.ts`): `bot_sessions_conversation_idx (organization_id, conversation_id)` and `bot_sessions_contact_started_idx (organization_id, contact_id, started_at)`. Plain `CREATE INDEX` in the migration transaction (SHARE lock: session writes wait until commit) with `SET LOCAL lock_timeout = '5s'`, which bounds lock acquisition, not the build. Migrations 0000–0008 are unchanged and pinned (`migration-0009-bot-indexes.db.test.ts`). Applying 0009 to any persistent database needs a separately approved maintenance window.

## Condition closure

| Condition                                       | Status                    | Evidence                                                                                                |
| ----------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| 08D-T1 migration 0008 raw-SQL constraints       | **CLOSED** (08E-0)        | `bot-control/outbound-schema.db.test.ts`, 14/14, owner-reported                                         |
| 08D-T2 acceptance wrapper at COMMIT (RT7)       | **CLOSED** (08E-0)        | `bot-control/dispatch.db.test.ts` RT7a–e + fence loss, 6/6, owner-reported; 08E pairings in R3-L        |
| 08D-T3 Inbox interactive rendering              | **CLOSED** (08E-0)        | `bot-control/inbox-interactive.db.test.ts`, 45/45, owner-reported; browser-level check in 08F           |
| Phase 08D Stop/acceptance P2                    | **CLOSED** (preserved)    | ADR 0020                                                                                                |
| 08E-2 capture connection-termination regression | Covered                   | `trigger-capture.db.test.ts` C1–C3 (`8321870`)                                                          |
| 08E-1 EXPLAIN / O-4 deferral                    | Covered                   | `queue-explain.db.test.ts` (`00e4f83`); migration 0009 (`cb75952`)                                      |
| STAFF submission B4                             | Covered                   | `staff-takeover-suppression.db.test.ts` (`45bef5a`)                                                     |
| Plan F8 first-node HANDOVER without a notice    | Covered                   | `first-message-trigger.db.test.ts` P3, fourth case (Phase 08E-9 Batch 6)                                |
| Six-bot closed loop                             | **Moved to 08G** (A-6BOT) | 08E covers the Student Enquiry bot's paths (`closed-loop.db.test.ts`); mandatory before live activation |

## Accepted limitations

1. **Post-final-authorization window** (V3.2 I.4, blocker 42): a Stop or takeover committed after the dispatcher's final read may not prevent that one transmission, and an attempt already begun cannot be recalled (`staff-takeover-suppression.db.test.ts` B5, `reconcile-notice.db.test.ts`).
2. A staff reply and a bot message submitted at nearly the same instant can both reach the student.
3. The acceptance record can wait behind a conversation-lock holder for up to the T1 bound: latency, not correctness.
4. One database role: "only the runtime enqueues" and similar rules are enforced by application code and static tests.
5. The BOT dispatch deadline and window use the application clock, like staff messaging.
6. A capture failure permanently omits that message's trigger; staff answer it from the Inbox.
7. Trigger rows grow with inbound volume until the 08F retention job exists.
8. The 20 s start guard plus 25 s bound is arithmetic, not measured under production load.

## Known P3 findings (nonblocking)

- `bots.trigger_capture_failed` can be logged for an attempt whose whole transaction later rolled back (`trigger-capture.db.test.ts` C1). Monitoring must not read it as proof of a stored message without a trigger.
- RT7e: the zero-row fallback can log `outbound.unknown_outcome/accepted_but_not_recorded` although `ACCEPTED` committed.
- HELD event codes differ by path: the reconciler records the bare hold code, the continuation path `send_held_<code>`.
- First-message message-header retention is pinned by a source scan (`bot-runtime/boundaries.test.ts` H5), not by a database constraint. Future retention must keep the headers or add a reviewed durable replacement first.
- Test fixtures (logical clock, synthetic SKIP LOCKED locker, pausing database, replica-mode EXPLAIN seed) prove the stated properties, not production reachability; each is disclosed in its test header.

## Phase boundaries

- **08E (this ADR):** capture, queue, step, eligibility, terminal notices, takeover and Stop interplay, reconciliation, the bot worker, migration 0009, and closed-loop acceptance of the approved Student Enquiry bot.
- **08F:** read-only Inbox indicator and filter (including notice warnings), operator listings, the `bots:retention` job, trigger-row retention, BOT hold-reason wording, interactive labeling, browser-level interactive rendering.
- **08G:** the five additional bot definitions and the six-bot closed loop (mandatory before live activation, amendment A-6BOT), combined stop/takeover/pause/suspension scenarios, security and privacy review, the reviewed activation plan, Meta interactive verification.

## Activation restrictions

Nothing in Phase 08E authorizes activation. Before any real account runs a bot: Phase 08E closure, 08F and 08G complete, approved definitions with closed-loop evidence for every deployed bot, migrations 0007–0009 applied in an approved window, worker supervision, an alert on capture failures, a rehearsed Stop procedure, a separately authorized live Meta test, and the owner's explicit written approval. The draft checklist is in [PHASE_08E_ACCEPTANCE.md](../PHASE_08E_ACCEPTANCE.md) section I, marked NOT AUTHORIZED.

## Consequences

- The runtime adds no new lock architecture: it reuses the 08D suppression shape and the V3.2 lock order, and every new wait edge is a try-lock or `SKIP LOCKED`.
- Correctness depends on PostgreSQL 17 (`transaction_timeout`); the worker refuses older servers.
- ADRs 0017–0020 are unchanged; their accepted statuses stand.
