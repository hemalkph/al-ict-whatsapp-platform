# Phase 08E acceptance record (bot runtime)

Phase 08E-9: final acceptance reconciliation, corrected after the independent review of the first draft. This record supports the final independent closure review. It is **not** an approval, a deployment instruction or an activation authorization. All live automation gates remain OFF.

**Baseline.** Branch `Bot-Foundation`, HEAD `cb75952052776aee71d89049aeff306d09d26d6f` (2026-10-26 07:35 +0530), equal to `origin/Bot-Foundation`. This record and the Batch 6 changes listed in section D.7 are uncommitted working-tree changes on that HEAD.

**Sources reconciled:**

| Source                                     | Location                                                                                                                                                                                                             | Notes                                                                                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 08E implementation plan (Revision 3) | `~/Desktop/PHASE_08E_IMPLEMENTATION_PLAN.md` (outside the repository)                                                                                                                                                | C (scope), M (gates), N.1/N.2/N.2a/N.3 (tests and acceptance), O (08D conditions), P (steps and exits), Q (decisions and risks). Carries owner amendment **A-6BOT** (2026-10-26) and the F3 clarification (N.2a F3). |
| Architecture V3.2                          | `~/Desktop/PHASE_08-0_BOT_ENGINE_ARCHITECTURE_PROPOSAL_V3.2.md`                                                                                                                                                      | O.10 regression matrix, O.11 acceptance, P (08E exit, line 1048; 08G exit, line 1054). Not edited.                                                                                                                   |
| ADRs                                       | `docs/adr/0017`–`0020` (unchanged); [ADR 0021](adr/0021-bot-runtime.md) (new)                                                                                                                                        | ADR 0021 records the runtime architecture, gates, condition closure, limitations and phase boundaries.                                                                                                               |
| Earlier 08E records                        | `docs/TESTING_STRATEGY.md`; `docs/PRE_PRODUCTION_BLOCKERS.md`                                                                                                                                                        | 08E-0, 08E-1, 08E-2 acceptance records and 08E-5/08E-6 notes; Phase 08E summary sections added in 08E-9.                                                                                                             |
| Tests and migration                        | `src/modules/bot-runtime/`, `src/modules/bot-worker/`, `src/modules/bots/trigger-match.test.ts`, `src/modules/whatsapp/inbound/trigger-capture.db.test.ts`, `src/db/__tests__/migration-0009-bot-indexes.db.test.ts` | 32 PostgreSQL test files for the runtime, worker, capture and migration 0009 (118 `*.db.test.ts` files in the repository).                                                                                           |

## A. Executive technical summary

Phase 08E built the bot runtime on the approved 08A–08D foundation:

- dormant inbound trigger capture;
- the trigger queue (claim, lease, fenced failure, deferral with refund, wake, six-attempt terminalization);
- the T1 step transaction (H.2 start eligibility, continuation, engine integration, atomic enqueue, terminal notices including first-node END/HANDOVER);
- staff takeover and Stop interplay through a session-scoped suppression primitive;
- the reconciler and sweeper;
- the default-off `bots:worker`.

Batches 1–5 of 08E-9 completed the acceptance tests. Migration 0009 adds two performance-only `bot_sessions` indexes. Batch 6 adds the one missing F8 database case (first-node HANDOVER without a notice), ADR 0021, the `.env.example` gate documentation and this corrected record.

Every runtime guarantee here is a tested property on disposable PostgreSQL 17 with a `FakeTransport`. None has run against Meta or a production database.

| Question                          | Answer                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation completed?         | **Yes**, for the Phase 08E scope as amended by A-6BOT.                                                                                 |
| Acceptance evidence verified?     | **Yes**, with one item awaiting owner validation: the new F8 silent-HANDOVER case passed in Claude-executed runs (section D.7).        |
| Documentation completed?          | **Yes**: ADR 0021, `.env.example`, this record, the blocker and testing-strategy sections, the draft activation checklist (section I). |
| Phase 08E ready for closure?      | **Ready for the final independent closure review.** Closure itself is the reviewer's and the owner's decision.                         |
| Production activation authorized? | **No.** It needs 08F, 08G (including the six-bot requirement), the reviewed activation plan and explicit owner approval.               |

## B. System safety invariants

"Tested" means a deterministic PostgreSQL or unit test, with a mutation control where the plan required one. It is not a production guarantee.

| #    | Invariant                                                                                                                                                                                                 | Evidence                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| S-1  | Default OFF. With every gate off: no trigger, session or request is written, no worker starts, and no transport call is made (V3.2 O.11).                                                                 | `gates.db.test.ts` row 1; `bot-runtime/config.test.ts`; trigger-capture gate-off SQL equality      |
| S-2  | Three independent processes (P-W capture, P-B bot worker, P-D dispatcher) each read their own environment. Only plan M row 8 (all on) and the narrow row 6 leftover can reach a transport.                | `gates.db.test.ts` rows 1–8 through the production entry points                                    |
| S-3  | The bot runtime never calls a transport and writes `outbound_requests.state` only as `QUEUED → HELD` through the suppression primitives. It is the only production importer of `enqueueAutomatedMessage`. | `bot-runtime/boundaries.test.ts`, `messaging/boundaries.test.ts`, `bot-worker/boundaries.test.ts`  |
| S-4  | At most one transport attempt per request. There is no BOT `SENDING → QUEUED`, and `UNKNOWN_OUTCOME`/`HELD` requests are never re-queued, recreated or resent.                                            | 0008 guard; `terminal-notice.db.test.ts` H; RT7a–e                                                 |
| S-5  | A staff takeover committed before the final pre-HTTP authorization always suppresses BOT output. One committed after it may not (accepted limitation, blocker 42).                                        | `staff-takeover-suppression.db.test.ts` B1–B5 incl. B4 submission; `stop-boundary.db.test.ts` (R5) |
| S-6  | No trigger exceeds six claims or stays `PENDING` past the terminalization window. A successful sixth attempt is never `DEAD`.                                                                             | `trigger-dead.db.test.ts` (R1 a–d, mutations); `trigger-claim.db.test.ts`                          |
| S-7  | No input older than `maxInputAge` (10 min) is deferred or applied, on start or continuation paths, including lock-busy exits.                                                                             | R9, R9b, R9c                                                                                       |
| S-8  | A terminal session transmits at most its one recorded terminal notice. A notice-less END/HANDOVER creates no request.                                                                                     | R8 A–J (section D.3); F8 P3 (section D.7)                                                          |
| S-9  | No acceptance record ends `UNKNOWN_OUTCOME` because of a lock conflict with the reconciler or terminalizer.                                                                                               | `acceptance-pairings.db.test.ts` (both orders, mutations)                                          |
| S-10 | `first_message` is decided by retained eligible inbound history in `(created_at, id)` order plus the all-state session fence, never by provider time.                                                     | `first-message-ordering.db.test.ts` F1–F4; `first-message-trigger.db.test.ts` F6/F8                |
| S-11 | Tenant isolation: runtime queries are organization-scoped, and cross-organization references are rejected by composite foreign keys.                                                                      | `tenant.db.test.ts` (E-TEN)                                                                        |
| S-12 | Capture never loses an inbound message: a recoverable capture error rolls back only its nested savepoint, and a connection loss rolls back and retries the whole event exactly.                           | `trigger-capture.db.test.ts` E-CAPFAIL, C1–C3                                                      |
| S-13 | Tests never touch the permanent database: explicit `TEST_DATABASE_ADMIN_URL` only, `al_ict_test_<12 hex>` names, no `DATABASE_URL` fallback, PostgreSQL 17 check.                                         | `db/__tests__/harness-safety.test.ts`; plan M item 8                                               |

## C. Acceptance traceability matrix

**Evidence base for every row.**

1. The test is committed at `cb75952`, apart from the Batch 6 F8 case, which is uncommitted.
2. **Owner-executed** full isolated PostgreSQL 17 suite: **2,232 passed, 7 skipped, 0 failed**. This result was supplied by the owner in the Batch 6 correction brief; the commit it ran on is not stated in that brief.
3. **Claude-executed** runs in 08E-9 Batch 6:
   - unit and static suite at `cb75952`: **2,449 passed** (109 files);
   - full isolated PostgreSQL suite with the Batch 6 F8 case: **2,233 passed, 7 skipped, 0 failed** (section G).
4. Git checkpoint history and the independent reviews of the checkpoints. Individual 08E-3 to 08E-8 review reports are not stored in the repository; per the independent review of this record's first draft, that absence is not a closure blocker.

The 7 skipped tests are the opt-in EXPLAIN evidence file (`queue-explain.db.test.ts`, run only with `BOT_QUEUE_EXPLAIN=1`).

**Status rule.** VERIFIED means a committed test passed in the full-suite runs above, at a reviewed checkpoint. PARTIALLY VERIFIED means the test passed but is awaiting owner validation. DEFERRED WITH EXPLICIT AUTHORIZATION means the owner moved the item to a named later phase in writing.

### C.1 V3.2 08E exit (V3.2 P, line 1048) and O.11

| ID     | Source                              | Expected behaviour                                                                                                     | Implementation                                                               | Test evidence                                                                                                                            | Checkpoint           | Status                                                                            |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| X-IN   | V3.2 P 08E exit                     | Inbound suite unchanged; gate-off handler SQL byte-identical to pre-08E                                                | `whatsapp/inbound/handler.ts`, `worker/registry.ts`, `db/ops/bot-trigger.ts` | `trigger-capture.db.test.ts` (gate-off equality + mutations); every inbound suite in the full run                                        | `92dc907`, `8321870` | VERIFIED                                                                          |
| X-R1   | V3.2 O.10 R1                        | Six claims ⇒ DEAD; variants a–d; a seventh claim violates the CHECK                                                    | `db/ops/bot-trigger-queue.ts`, `bot-runtime/trigger-queue.ts`                | `trigger-dead.db.test.ts`                                                                                                                | `6772691`            | VERIFIED                                                                          |
| X-R2   | V3.2 O.10 R2                        | Early reply deferred while the request is in flight; applied once after ACCEPTED; variants                             | `bot-runtime/continue.ts`, `apply.ts`, `reconcile.ts`                        | `early-reply.db.test.ts`; `step.db.test.ts` ENG deferred+changed                                                                         | `f242055`, `9493193` | VERIFIED                                                                          |
| X-R4   | V3.2 O.10 R4                        | Restart after handover only under H.2; cases A–G, restart, V2 mutation                                                 | `bot-runtime/eligibility.ts`, `start.ts`                                     | `step.db.test.ts` (A–C; F, G, restart, V2 mutation in Batch 1)                                                                           | `9493193`            | VERIFIED                                                                          |
| X-R6   | V3.2 O.10 R6                        | Suspension within and after 120 s; SENDING recovery; stale and pre-activation triggers                                 | `bot-worker/`, dispatcher (08D)                                              | `bot-worker/r6.db.test.ts`; `terminal-notice.db.test.ts` F/G                                                                             | `06ae5e4`, `45bef5a` | VERIFIED                                                                          |
| X-R7   | V3.2 O.10 R7                        | No session from an input superseded by staff; A–G, both lock orders, restart, V3 mutation                              | `bot-runtime/eligibility.ts`, `db/ops/bot-step.ts`                           | `staff-before-start.db.test.ts`; `step.db.test.ts` (C in full, G, V3 mutation in Batch 1)                                                | `9493193`            | VERIFIED                                                                          |
| X-R8   | V3.2 O.10 R8 "all cases end to end" | At most one recorded terminal notice; A–J                                                                              | `bot-runtime/apply.ts`, `reconcile.ts`, dispatcher                           | Section D.3                                                                                                                              | `45bef5a`            | VERIFIED                                                                          |
| X-R9   | V3.2 O.10 R9; plan R9/R9b/R9c       | No trigger deferred after `maxInputAge`; no continuation exemption; lock-busy freshness                                | `bot-runtime/eligibility.ts`, `continue.ts`, `step.ts`                       | `early-reply.db.test.ts`; `step.db.test.ts` (R9b with exemption mutation; R9c A–D)                                                       | `9493193`            | VERIFIED                                                                          |
| X-R3L  | V3.2 O.10 R3-L (08E pairings)       | Acceptance record vs reconciler and vs terminalizer: no 40P01, ACCEPTED, one call; both orders; lock-timeout mutations | `bot-runtime/reconcile.ts`, terminalizer                                     | `acceptance-pairings.db.test.ts`                                                                                                         | `45bef5a`            | VERIFIED                                                                          |
| X-O4   | V3.2 O.4                            | Pause, drain, resume, retire with the runtime in the loop                                                              | `bot-control/deployments.ts`, runtime                                        | `pause-drain.db.test.ts`                                                                                                                 | `9493193`            | VERIFIED                                                                          |
| X-O5   | V3.2 O.5                            | Send outcomes HELD/REJECTED/UNKNOWN hand over; request untouched; never resent                                         | `bot-runtime/reconcile.ts`                                                   | `reconcile.db.test.ts` (E-REC); `terminal-notice.db.test.ts` H                                                                           | `f242055`, `45bef5a` | VERIFIED                                                                          |
| X-O7   | V3.2 O.7                            | Attempt accounting and terminalization                                                                                 | trigger queue                                                                | `trigger-claim.db.test.ts`, `trigger-dead.db.test.ts`, `backoff.test.ts`                                                                 | `6772691`            | VERIFIED                                                                          |
| X-O8   | V3.2 O.8                            | Deferral and ordering: head-of-line, refund, wake                                                                      | trigger queue, `apply.ts`                                                    | `trigger-claim.db.test.ts`, `early-reply.db.test.ts`, `decision-clock.db.test.ts`, `trigger-drain.db.test.ts`                            | `2dc20de`            | VERIFIED                                                                          |
| X-O11  | V3.2 O.11                           | Acceptance sentences                                                                                                   | —                                                                            | This table and C.2; zero duplicate messages by `closed-loop.db.test.ts`                                                                  | `cf32df7`            | VERIFIED (for the 08E scope)                                                      |
| X-E2E  | Plan N.2 E2E as amended by A-6BOT   | Closed loop for the implemented paths of the approved Student Enquiry bot                                              | `enquiryFlow`, the full runtime path                                         | `closed-loop.db.test.ts` (signed webhook → capture → bot worker → dispatcher → `FakeTransport`; duplicates, crashes, concurrent workers) | `cf32df7`            | VERIFIED                                                                          |
| X-6BOT | V3.2 P 08G; A-6BOT                  | Five additional approved bot definitions and the six-bot closed loop                                                   | Not built (no approved definitions)                                          | —                                                                                                                                        | —                    | **DEFERRED WITH EXPLICIT AUTHORIZATION** to 08G; mandatory before live activation |

### C.2 Plan 08E tests (plan N.1, N.2, N.2a, N.3, M, O)

**N.1 pure suites (no database)**

| ID         | N.1 suite                           | Test evidence                                                                                       | Checkpoint | Status   |
| ---------- | ----------------------------------- | --------------------------------------------------------------------------------------------------- | ---------- | -------- |
| N1-ELIG    | `evaluateStartEligibility`          | `bot-runtime/eligibility.test.ts` (61 tests: rules 1–10, order, rule 7 before rule 5, R4/R7 tables) | `29913a7`+ | VERIFIED |
| N1-MATCH   | Trigger matching (E-KEY)            | `bots/trigger-match.test.ts` (`triggerKey` = `comparisonKey`, keyword never on BUTTON/INTERACTIVE)  | `29913a7`  | VERIFIED |
| N1-INPUT   | Message → `StudentInput`            | `bot-runtime/input.test.ts`                                                                         | `29913a7`+ | VERIFIED |
| N1-SESSION | Session row ↔ `BotSession`          | `bot-runtime/session-row.test.ts` (round trip; inconsistent rows reach `SESSION_INVALID`)           | `29913a7`+ | VERIFIED |
| N1-TAKE    | Takeover classifier                 | `bot-runtime/takeover.test.ts`                                                                      | `29913a7`+ | VERIFIED |
| N1-BACKOFF | Backoff and deferral                | `bot-runtime/backoff.test.ts` (5/15/45/120/300 s ±20 %, 2/4/8/15 s ladder); `trigger-queue.test.ts` | `29913a7`+ | VERIFIED |
| N1-CONFIG  | Config and gate parsing             | `bot-runtime/config.test.ts`, `bot-worker/config.test.ts`, `policy.test.ts`                         | `06ae5e4`+ | VERIFIED |
| N1-STATIC  | Static boundary tests (M items 1–8) | `*/boundaries.test.ts`, `log.test.ts`; 0000–0008 pinned in `migration-0009-bot-indexes.db.test.ts`  | `cb75952`  | VERIFIED |

("`29913a7`+" means introduced in 08E-1 and extended at later checkpoints.)

**N.2, N.2a and plan O**

| ID                            | Expected behaviour (short)                                                                                                                                                | Test evidence                                                                                                                                                 | Checkpoint            | Status                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| E-CAP                         | Admission matrix, 20-pending cap, rollback, duplicates, gate off ⇒ no write                                                                                               | `whatsapp/inbound/trigger-capture.db.test.ts`                                                                                                                 | `92dc907`             | VERIFIED                                                                     |
| E-CAPFAIL                     | Capture error never loses the message; connection-termination recovery                                                                                                    | same file, incl. C1–C3                                                                                                                                        | `8321870`             | VERIFIED                                                                     |
| E-CLAIM                       | SKIP LOCKED, head-of-line, `attempts < 6`, lease, fenced T2, refund                                                                                                       | `trigger-claim.db.test.ts`                                                                                                                                    | `6f86cc4`             | VERIFIED                                                                     |
| R-CAP                         | Per-contact session cap serialized across accounts; crash releases the lock                                                                                               | `step.db.test.ts`                                                                                                                                             | `7a218b2`             | VERIFIED                                                                     |
| E-TO                          | `transaction_timeout`, pool settings forwarding, PostgreSQL ≥ 17 preflight                                                                                                | `bot-worker/transaction-bound.db.test.ts`, `worker.db.test.ts`                                                                                                | `f0b0c7d`             | VERIFIED                                                                     |
| E-CLK                         | Decision clock after the last lock; skew recovery                                                                                                                         | `decision-clock.db.test.ts`                                                                                                                                   | `2dc20de`             | VERIFIED                                                                     |
| E-DRAIN                       | End/wake never waits on a held trigger row                                                                                                                                | `trigger-drain.db.test.ts`                                                                                                                                    | `f242055`             | VERIFIED                                                                     |
| E-MISS                        | Missing request ⇒ FAILED / `send_state_missing`                                                                                                                           | `reconcile.db.test.ts`                                                                                                                                        | `f242055`             | VERIFIED                                                                     |
| E-REC                         | N.1 reconciliation table row by row; terminal-notice rows untouched; deadline suppression racing a claim; idle expiry incl. `delivery_failed`; interrupted reconciliation | `reconcile.db.test.ts`; `reconcile-notice.db.test.ts` (authorized notice stays dispatchable)                                                                  | `f242055`             | VERIFIED                                                                     |
| E-FIRST                       | Historical ordering F1–F4; retention F6; interruption F8 P1/P2                                                                                                            | `first-message-ordering.db.test.ts` (Batch 4); `first-message-trigger.db.test.ts`                                                                             | `9a01803`, `8321870`  | VERIFIED                                                                     |
| E-FIRST F8 P3 silent HANDOVER | Committed first-node HANDOVER without a notice consumes the opportunity (plan F8, l.1100)                                                                                 | `first-message-trigger.db.test.ts` P3, fourth case (section D.7)                                                                                              | Batch 6 (uncommitted) | PARTIALLY VERIFIED: passed in Claude-executed runs; owner validation pending |
| E-BTNSTART                    | BUTTON as first eligible message; an ignored pre-resolution BUTTON stays history                                                                                          | `button-start-eligibility.db.test.ts`                                                                                                                         | `9493193`             | VERIFIED                                                                     |
| E-REF                         | Referral needs exact org/message/contact attribution                                                                                                                      | `step.db.test.ts`; `closed-loop.db.test.ts` R1/R2                                                                                                             | `7a218b2`, `cf32df7`  | VERIFIED                                                                     |
| E-HOURLY                      | Rolling 60-minute window; replay not counted; `created_at` is the transaction start                                                                                       | `step.db.test.ts` (C-4 block; AC-5 in Batch 1); `step.test.ts`                                                                                                | `9493193`             | VERIFIED                                                                     |
| ENG                           | Every `StepResult` shape maps to rows the guards accept                                                                                                                   | `step.db.test.ts` ENG                                                                                                                                         | `9493193`             | VERIFIED                                                                     |
| R3-S-A                        | Terminalizer suppression: witness P0–P5 before FETCH, production P6/P7 skip, legacy 40P01                                                                                 | `session-suppression.db.test.ts`                                                                                                                              | `6772691`             | VERIFIED                                                                     |
| R3-S-B                        | Genuine staff takeover B1–B5, incl. B4 for assignment and STAFF submission                                                                                                | `staff-takeover-suppression.db.test.ts`                                                                                                                       | `45bef5a`             | VERIFIED                                                                     |
| R3-S-C                        | Deadline suppression C1–C3                                                                                                                                                | `deadline-suppression.db.test.ts`                                                                                                                             | `f242055`             | VERIFIED                                                                     |
| R3-O / R3-P                   | Operation-specific orders; lock-order pairings, no 40P01                                                                                                                  | `session-suppression.db.test.ts`; `lock-order.db.test.ts`; `review-conditions.db.test.ts`                                                                     | `f242055`             | VERIFIED                                                                     |
| R5                            | Stop before claim / before final read / after final read                                                                                                                  | `stop-boundary.db.test.ts`                                                                                                                                    | `6772691`             | VERIFIED                                                                     |
| E-CTL                         | `control_seq` equals the number of allocations                                                                                                                            | `control-sequence.db.test.ts`                                                                                                                                 | `cf32df7`             | VERIFIED                                                                     |
| E-TEN                         | Tenant isolation across capture, claim, step, reconcile, suppression                                                                                                      | `tenant.db.test.ts`                                                                                                                                           | `cf32df7`             | VERIFIED                                                                     |
| E-GATE                        | Three-process gate matrix, rows 1–8                                                                                                                                       | `gates.db.test.ts`; `config.test.ts`                                                                                                                          | `c40d64e`             | VERIFIED                                                                     |
| O-4 / L.2                     | Index decision from representative EXPLAIN evidence                                                                                                                       | `queue-explain.db.test.ts` (opt-in); saved comparison logs are held outside the repository                                                                    | `00e4f83`             | VERIFIED                                                                     |
| MIG-0009                      | Two approved indexes; 0000–0008 unchanged; upgrade keeps every row; identical reads                                                                                       | `migration-0009-bot-indexes.db.test.ts`                                                                                                                       | `cb75952`             | VERIFIED                                                                     |
| COND-1..3                     | 08D-T1/T2/T3 closed before the 08E exit                                                                                                                                   | `outbound-schema.db.test.ts` 14/14; `dispatch.db.test.ts` RT7 6/6; `inbox-interactive.db.test.ts` 45/45                                                       | `ee34e4f`             | VERIFIED (**CLOSED**)                                                        |
| RT7 + 08E                     | Plan O item 2: wrapper COMMIT coverage, extended through the 08E pairings                                                                                                 | RT7a–e (record wrapper, unchanged by 08E) + R3-L (`acceptance-pairings.db.test.ts`). The plan does not require a COMMIT failure injected inside each pairing. | `ee34e4f`, `45bef5a`  | VERIFIED                                                                     |
| DOC-9                         | ADR 0021, blocker rows, TESTING_STRATEGY section, draft activation plan, conditions table, `.env.example`                                                                 | [ADR 0021](adr/0021-bot-runtime.md); `.env.example`; this record; blocker and testing sections                                                                | Batch 6 (uncommitted) | Completed; under closure review                                              |

## D. Completed tests and evidence

### D.1 Batch 1: runtime acceptance (`9493193`)

- **`step.db.test.ts` "Phase 08E-9 Batch 1":**
  - R4 F, G, restart and the V2-restart mutation;
  - R7 C in full, G and the V3-rules mutation;
  - R9b stale repeat with the continuation-exemption mutation;
  - E-HOURLY AC-5 (`created_at` is the transaction start; insert-time mutation);
  - ENG result shapes.
- **New files:** `button-start-eligibility.db.test.ts` (E-BTNSTART) and `pause-drain.db.test.ts` (V3.2 O.4).
- **Limit:** where the 30-minute cooldown must pass, a disclosed logical clock advances input time and decision clock together (plan N.2a). Control sequences, record order and database-stamped times stay real.

### D.2 Batch 2: E-GATE three-process matrix (`c40d64e`)

`gates.db.test.ts` runs every plan M row with an explicit environment object per process, through the production entry points of the webhook worker, bot worker and outbound worker. Each row permits exactly the expected subset of {trigger insert, worker start, enqueue, BOT claim, transport call}. Limit: a `FakeTransport` stands in for Meta, and elapsed time is an explicit clock.

### D.3 Batch 3: STAFF B4, R3-L orders, R8 F/G/H/J (`45bef5a`)

- **B4.** A test-only pausing database (`src/db/__tests__/pausing-database.ts`, owner-authorized) parks the real dispatcher claim immediately before its bot-rule read while it holds R. The real STAFF submission then commits; the claim resumes and holds R `staff_took_over`, with zero BOT calls. A negative control parks after the read and is refused at final authorization. The wrapper only delays sending a statement; it never changes text, parameters or results, and the dispatcher is unchanged.
- **R3-L second order.** The acceptance record is parked after its request-row update while the reconciler or terminalizer takes the conversation. Result: no 40P01, ACCEPTED, one call. A 1 s `lock_timeout` mutation yields the false `UNKNOWN_OUTCOME`.
- **R8 F/G/H/J** (`terminal-notice.db.test.ts`), with runtime-created notices only.
- **R8 cases elsewhere:**
  - A/B in `step.db.test.ts` and `reconcile-notice.db.test.ts`;
  - C is fixture-only by design (V3.2), covered in `reconcile-notice.db.test.ts` and the 08D dispatcher tests;
  - D/E in `reconcile-notice.db.test.ts`;
  - I in `step.db.test.ts`, plus the F8 P3 cases.

### D.4 Batch 4: historical first-message ordering F1–F4 (`9a01803`)

`first-message-ordering.db.test.ts` covers F1, F2 with its media-only companion, F3-1a/1b, F3-2, F3-3, F3-4a/4b, and the F4 mutations: each mutation fails as required.

**Approved F3 clarification**, as implemented and recorded in the test header:

- A captured, unlocked loser is ended `IGNORED/session_ended` by J.4a sibling cleanup.
- A surviving loser with a real input time is `stale_trigger` after the cooldown, because freshness precedes cooldown.
- Historical rejection (`no_trigger_match`) after the cooldown is shown with the disclosed logical-clock fixture.

**Limits:**

- The fixture proves eligibility correctness, not production reachability.
- The interleaving in which a locked loser survives cleanup is a source-level analysis, not a reproduced result.
- This file calls `ingestVerifiedDelivery` directly; the HTTP route and signature check are exercised in `closed-loop.db.test.ts`.

### D.5 Batch 5: O-4 EXPLAIN evidence (`00e4f83`)

`queue-explain.db.test.ts` (opt-in) captures the production statements and runs them before and after two candidate `bot_sessions` indexes. EXPLAIN ANALYZE is used only for reviewed lock-free SELECTs inside READ ONLY transactions.

Limits:

- The dataset is synthetic.
- History is seeded in replica mode; foreign keys are re-verified afterwards and control sequences are synthetic.
- The test asserts no timing.
- The comparison logs are held outside the repository.

### D.6 Migration 0009 (`cb75952`) and Phase 08D conditions

`migration-0009-bot-indexes.db.test.ts` checks:

- 0000–0008 are pinned byte-for-byte;
- 0009 is additive only;
- a fresh migration produces both index definitions;
- an upgrade from 0008 with representative sessions keeps every row, index, constraint and trigger;
- reads return identical results with and without the indexes;
- the indexes are used.

| 08D condition (plan O) | Status     | Evidence                                                                          |
| ---------------------- | ---------- | --------------------------------------------------------------------------------- |
| 1. 0008 raw-SQL tests  | **CLOSED** | `bot-control/outbound-schema.db.test.ts` 14/14 (owner-reported, 08E-0)            |
| 2. RT7 COMMIT stage    | **CLOSED** | `bot-control/dispatch.db.test.ts` RT7a–e + fence loss 6/6 (owner-reported, 08E-0) |
| 3. Inbox interactive   | **CLOSED** | `bot-control/inbox-interactive.db.test.ts` 45/45 (owner-reported, 08E-0)          |

### D.7 Batch 6: F8 first-node HANDOVER without a notice (uncommitted)

**Change.** One more case in the existing parameterized P3 table of `src/modules/bot-runtime/first-message-trigger.db.test.ts`. The `handoverFirstFlow` test helper gains an optional `message` parameter (`null` gives a HANDOVER with no message); its default and its existing callers are unchanged. Two assertions were added to every P3 case, and no existing assertion was removed:

- for a HANDOVER, the exact `HANDED_OVER` event (`code needs_staff`, `step_seq 1`, no message);
- after the start, a real `sweepOnce` pass leaves the request count and the session row unchanged.

No production file changed.

**What the new case proves, on the real T1 start path and the real database guards:**

- The first eligible message starts the session (`PROCESSED session_started`, `started_by_message_id` = A).
- The session commits `HANDED_OVER` with `end_reason flow_handover`, `handover_reason needs_staff`, `step_seq 1` and `terminal_notice_step_seq` NULL.
- Control sequence: `started_control_seq` = before + 1, then `handover_control_seq` = before + 2 = the conversation's `control_seq`. No request allocation sits between them.
- Events: exactly one, `HANDED_OVER` with code `needs_staff`.
- Zero BOT outbound requests, and a later real reconciliation sweep creates none and leaves the session row unchanged.
- After the real staff resolution (control sequence + 1) and the 31-minute logical cooldown, a fresh, fully eligible B observed after every control event gets `firstInRecordHistory false` and `noPreviousSessionStart false`. B is `IGNORED no_trigger_match`, and sessions, requests, events and control sequence are byte-identical before and after.
- **Positive control:** with both first-message predicates removed (test-only seam), an identical B2 starts a second session sequenced after the resolution. Firstness alone stops B.

**Results (Claude-executed, 2026-10-26, disposable PostgreSQL 17.11):** focused file 10/10 passed, including all four P3 cases. Full suite: 2,233 passed, 7 skipped, 0 failed. Owner validation is pending.

## E. Approved architectural and acceptance decisions

| Decision                                                                                       | Source                                              | Status                                                                          |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| O-1 keyword: whole-message `triggerKey` equality; referral via recorded attribution            | Plan owner decisions                                | OWNER APPROVED 2026-10-20                                                       |
| O-1b / C-1 / C-2 `first_message`: first eligible TEXT/INTERACTIVE/BUTTON ever                  | Plan owner decisions                                | OWNER APPROVED 2026-10-20                                                       |
| C-3 referral: exact org + message; contact agreement as validity check                         | Plan owner decisions, AC-7                          | OWNER APPROVED 2026-10-20                                                       |
| C-4 hourly cap: new BOT requests in (clock − 60 min, clock], any state, replay not counted     | Plan owner decisions, AC-5/AC-6                     | OWNER APPROVED 2026-10-20                                                       |
| O-3 limits: cooldown 30 min; 3 sessions/contact/24 h; `maxInputAge` 10 min; 30 BOT msgs/conv/h | Plan owner decisions                                | OWNER APPROVED 2026-10-20                                                       |
| O-2 capture gate in the webhook worker's own environment                                       | TESTING_STRATEGY 08E-2                              | OWNER APPROVED                                                                  |
| D.4a durable first-message fence                                                               | Plan D.4a                                           | Implemented; F1–F4 accepted with Batch 4                                        |
| F3 acceptance clarification                                                                    | Plan N.2a F3 (line 1095)                            | Owner-approved; preserved by A-6BOT                                             |
| **A-6BOT:** six-bot acceptance assigned to 08G; 08E covers the Student Enquiry bot's paths     | Plan owner decisions, N.2 E2E, P 08E-8 (2026-10-26) | **OWNER APPROVED 2026-10-26**; six-bot remains mandatory before live activation |
| Test-only pausing database for B4 / R3-L second order                                          | `pausing-database.ts` header                        | Owner-authorized (Batch 3)                                                      |
| EXPLAIN safety rules                                                                           | `queue-explain.db.test.ts` header                   | Owner decision (Batch 5)                                                        |
| O-4: migration 0009 with exactly two indexes                                                   | Plan L.2                                            | Approved and committed; **not applied anywhere persistent**                     |
| Q-I2..Q-I7, Q-T1..Q-T5                                                                         | Plan Q.1 C                                          | Reviewer-resolved; unchanged                                                    |
| Phase 08D Stop/acceptance P2                                                                   | ADR 0020                                            | CLOSED, preserved                                                               |

**Exact plan wording of A-6BOT** (owner-decisions section): "For Phase 08E, closed-loop acceptance covers the implemented paths of the approved Student Enquiry bot (`enquiryFlow`). The five additional bot definitions and the six-bot closed-loop verification belong to Phase 08G and remain **mandatory before live activation**; they are neither deleted nor waived. This amends only the six-bot requirement in N.2 E2E and the corresponding 08E-8 exit scope, consistent with V3.2 P (08G). All other Phase 08E acceptance criteria are unchanged, including the F3 clarification in N.2a. This amendment authorizes no production activation or deployment."

## F. Known P3 risks and deferred work

### F.1 Confirmed nonblocking findings

| #    | Finding                                                                                                                                                                                               | Evidence                                                   | Disposition                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P3-1 | `bots.trigger_capture_failed` is logged for a capture attempt whose whole transaction is then rolled back, so the log names a message that never committed. The retry stores the message and trigger. | `trigger-capture.db.test.ts` C1 (pinned observation)       | Observability defect, nonblocking. Monitoring must account for it.                       |
| P3-2 | RT7e: the zero-row fallback can log `outbound.unknown_outcome/accepted_but_not_recorded` although ACCEPTED committed.                                                                                 | `bot-control/dispatch.db.test.ts` RT7e                     | Observability defect, nonblocking. A logging fix needs separate authorization.           |
| P3-3 | HELD event codes differ by path: the bare hold code (reconciler) versus `send_held_<code>` (continuation).                                                                                            | TESTING_STRATEGY 08E-5/08E-6 notes                         | Consistency issue, nonblocking.                                                          |
| P3-4 | Message-header retention (F6) is enforced by a source scan, not a database constraint.                                                                                                                | `bot-runtime/boundaries.test.ts` H5                        | Limited evidence. Future retention keeps headers or adds a reviewed durable replacement. |
| P3-5 | Legacy deadlock controls use the server's `deadlock_timeout` (1 s observed; the role may set 500 ms).                                                                                                 | `review-conditions.db.test.ts` (logged in the Batch 6 run) | Coverage unchanged.                                                                      |

### F.2 Test-environment observations

| #   | Observation                                                                                                                                        | Disposition                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| O-a | Harness timing variability on long runs; samples taken across host sleep are invalid.                                                              | Nonblocking test-reliability observation. No host sleep occurred during the Batch 6 full run (`pmset` log).                                         |
| O-b | Worker shutdown observations.                                                                                                                      | The bounded-shutdown regressions in `bot-worker/worker.db.test.ts` and `run.test.ts` stand. An unspecified observation does not establish a defect. |
| O-c | Leftover `al_ict_test_*` scratch databases on the isolated server: 7 before and 7 after the Batch 6 full run. The harness drops its own databases. | Isolated-environment housekeeping only, never `al_ict_whatsapp`. Not deleted without owner approval.                                                |
| O-d | Fixture limits: logical clock, synthetic SKIP LOCKED locker (F3-4), pausing database, replica-mode EXPLAIN seed.                                   | Disclosed in each test header. They prove the stated property, not production reachability.                                                         |

### F.3 Accepted or theoretical risks

- Post-final-authorization window (blocker 42).
- A capture failure omits a trigger permanently. The alert is a pre-activation requirement.
- Trigger-row volume grows until the 08F retention job exists.
- The T1 20 s guard plus the 25 s bound is arithmetic, not measured under load.
- Acceptance-record latency behind a conversation-lock holder.
- Real Meta interactive behaviour is unverified.
- Migration 0009 is a production maintenance risk (section H).

### F.4 Deferred to later phases (explicitly assigned)

- **08F:**
  - Inbox indicator and filter;
  - operator listings;
  - `bots:retention` and trigger-row retention;
  - hold-reason wording and interactive labeling;
  - browser-level interactive rendering.
- **08G:**
  - the five additional bot definitions and the six-bot closed loop (A-6BOT; mandatory before live activation);
  - combined stop, takeover, pause and suspension scenarios;
  - security and privacy review;
  - the reviewed activation plan;
  - Meta interactive verification.
- **Optional hardening (no phase requirement):** a test that terminates the terminalizer's own backend while it holds its locks. The reconciler equivalent exists (`reconcile.db.test.ts`), and the terminalizer runs in one transaction.

## G. Remaining obligations

| #   | Item                                                                                                                             | Classification                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| G-1 | Six-bot closed loop                                                                                                              | **DEFERRED WITH EXPLICIT AUTHORIZATION** (A-6BOT) to 08G; mandatory before live activation. Not a Phase 08E blocker. |
| G-2 | Owner validation of the Batch 6 F8 silent-HANDOVER case (section D.7)                                                            | Required for closure. The test exists and passed in Claude-executed runs.                                            |
| G-3 | Final independent closure review of the Batch 6 changes (this record, ADR 0021, `.env.example`, the F8 case, the plan amendment) | Required for closure.                                                                                                |
| G-4 | Commit and push of the Batch 6 changes                                                                                           | Owner-authorized step after review. Not performed here.                                                              |

Removed after independent review of the first draft:

- A combined COMMIT-failure/pairing test is not a plan requirement; RT7a–e plus R3-L satisfy plan O item 2.
- "P5/P6" are the I.5.1 suppression probes, already exercised in `session-suppression.db.test.ts`; there is no separate interruption requirement.
- Missing repository-local review reports for 08E-3 to 08E-8 are not a closure blocker.

## H. Migration 0009 and operational restrictions

- **Indexes:**
  - `bot_sessions_conversation_idx (organization_id, conversation_id)`: conversation history reads (cooldown, latest handover, last consumed input, `first_message` fence);
  - `bot_sessions_contact_started_idx (organization_id, contact_id, started_at)`: the per-contact session cap.
  - Additive only.
- **Locks.** Plain `CREATE INDEX` inside the migration transaction (`CONCURRENTLY` is impossible there). Each build holds a SHARE lock on `bot_sessions`: reads continue, but session INSERT/UPDATE/DELETE wait until commit.
- **Lock acquisition.** `SET LOCAL lock_timeout = '5s'` makes the migration fail rather than queue behind live traffic. It bounds each lock wait, **not** the build. On timeout the transaction rolls back and nothing is applied.
- **Build duration.** Unknown for production: neither the production `bot_sessions` size nor the production PostgreSQL version is recorded in the repository.
- **Transactional behaviour.** Both indexes and the journal entry commit together or not at all. 0009 requires 0007 and 0008.
- **Maintenance window.** Applying 0009 to any persistent database needs a **separately approved** window and operator.
- **Prohibition.** Do not apply 0009 to `al_ict_whatsapp` or any production database without explicit owner authorization. Nothing here authorizes it.

## I. Draft activation-readiness checklist: NOT AUTHORIZED

**This checklist authorizes nothing.** It is the 08E-9 draft required by plan M. The final operational activation plan belongs to 08G. No gate may be changed, no worker started and no deployment activated on the basis of this list.

- [ ] Phase 08E closed after the final independent closure review.
- [ ] Phase 08F delivered: Inbox indicator, operator listings, `bots:retention`, trigger-row retention running with the approved period.
- [ ] Phase 08G passed, including the five additional approved bot definitions and the six-bot closed loop (A-6BOT).
- [ ] Approved definitions and closed-loop evidence for every bot to be deployed.
- [ ] Migrations 0007, 0008 and 0009 applied in an approved window, with preflight and a rollback plan.
- [ ] Production PostgreSQL ≥ 17 confirmed; worker pool settings verified (J.6).
- [ ] Alert on any non-zero `bots.trigger_capture_failed` rate, accounting for P3-1.
- [ ] Supervision, restart and shutdown procedure for `bots:worker` and the outbound worker.
- [ ] Stop / Emergency Stop procedure rehearsed, including "Stop before re-enabling dispatch" (V3.2 F.5).
- [ ] Gate order agreed per process (P-W, P-B, P-D) and per account. Rollback is gates OFF plus Stop.
- [ ] Meta interactive-message and window behaviour verified by a separately authorized live test.
- [ ] The owner's explicit, written activation approval.

## J. Closure assessment

- **Implementation:** complete for the Phase 08E scope as amended by A-6BOT.
- **Acceptance evidence:** every mandatory Phase 08E criterion maps to a committed test that passed in the full-suite runs. The one exception is the new F8 silent-HANDOVER case, which passed in Claude-executed runs and awaits owner validation (G-2).
- **Documentation:** the mandatory 08E-9 deliverables now exist: ADR 0021, `.env.example`, this record with its conditions table and draft activation checklist, and the blocker and testing-strategy sections. They await the closure review (G-3).
- **Phase 08E closure:** **READY FOR FINAL INDEPENDENT CLOSURE REVIEW.** Closure follows that review, the owner's validation of the F8 case and the owner's checkpoint. It does not follow from this record alone.
- **Production activation:** **not authorized** and not ready. All gates remain OFF.
