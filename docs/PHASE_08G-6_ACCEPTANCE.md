# Phase 08G-6 — Integrated six-bot acceptance

Status: **INTEGRATED POSTGRESQL VALIDATION PASSED — OWNER GIT CHECKPOINT COMMITTED (`0bd24b6` on `origin/Bot-Foundation`; reconciled from Git history in Phase 08G-7A).** SIX-CL-1 to SIX-CL-13: 36 passed, 0
failed, 0 skipped, on one owner-authorized isolated run (section 9). Production activation: **NOT AUTHORIZED.**

Evidence layers: the PostgreSQL closed-loop run is the evidence for the SIX-CL assertions (developer-reported, owner-accepted).
Contract statements in section 3 come from source inspection. No browser rendering, user-visible chronology or real Meta/WhatsApp
delivery is claimed. All six bots remain synthetic test fixtures. No production runtime, schema, migration, messaging or Inbox
code changed; the shared test kit (`bot-runtime/testing.ts`) is unchanged.

## 1. Baseline

| Item       | Result                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Branch     | `Bot-Foundation`                                                                                                              |
| HEAD       | `b4f2df6` = `origin/Bot-Foundation`                                                                                           |
| 08G-1..5   | Committed and pushed: `2423f26` GI, `f0af1f9` CI, `e00b261` PE, `506e664` SR, `b4f2df6` RE                                    |
| Doc status | The "Git checkpoint pending" lines of 08G-2..5 were reconciled to those commits (documentation only; evidence and scope kept) |

Sources: `~/Desktop/PHASE_08G-0_SIX_BOT_DEFINITIONS.md` (sections 3, 4, 12–15), `PHASE_08G-1_APPROVAL_ADDENDUM.md`,
`PHASE_08G-2..5_ACCEPTANCE.md`, `PHASE_08G-4_INBOX_ORDERING_ISSUE_DRAFT.md`, `PRE_PRODUCTION_BLOCKERS.md`, runtime source.

## 2. Owner decisions

**OD-1 — APPROVED: deployment priority as the runtime defines it.** Bot selection (`eligibility.ts`, rule 10) tries ACTIVE
deployments in ascending priority; within one, triggers in array order. The runtime does **not** intrinsically prefer keyword
triggers over `first_message` triggers. Approved configuration (08G-0 section 4): Staff Routing 1, Payment 2, Registration 3,
Class 4, General 5, **Student Enquiry 6 (last)**. No runtime precedence change is authorized. The passing inverted-priority test
(SIX-CL-2) demonstrated the hazard: with Student Enquiry first, it captured every keyword sent as a first message. The
activation-check function used in that test exists only inside the test file. **The automated activation-time priority guard is
NOT IMPLEMENTED: a production-readiness obligation (section 7).**

**OD-2 — GI-CL-14 REMAINS OPEN.** The previously proposed two-hour real-time SEND_BUDGET test is **NOT AUTHORIZED** and was not
implemented or run. Not done: manipulating send counters, backdating rows, changing or disabling rate limits or the hourly cap,
or using inconsistent test and database clocks. The simulator evidence, the unit-level ENG regression (`step.db.test.ts`, seeded
`send_count`) and RE-CL-10's render-failure case are retained as engine-level evidence and **do not** establish the missing
PostgreSQL closed-loop engine-error regression. The passing six-bot suite does not touch it.

**GI-CL-14 — OPEN: PostgreSQL closed-loop engine-error evidence not established.** Any future approach needs a separate
technical assessment and owner authorization.

## 3. Contracts exercised

| Contract           | Source                                    | Relevance                                                                                                         |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Start eligibility  | `bot-runtime/eligibility.ts`              | Live session = continuation; handover → `handover_unresolved`; 30-min cooldown; 3 sessions/contact/24 h           |
| Bot selection      | `eligibility.ts` rule 10, `trigger-match` | Priority order (OD-1); keyword key = NFC, trim, lower-case, whole TEXT message                                    |
| Engine budgets     | `bots/limits.ts`                          | 60 sends/session (GI-CL-14); 1 send/step                                                                          |
| Hourly cap         | `bot-runtime/policy.ts`                   | 30 BOT requests per conversation per rolling hour                                                                 |
| Dispatcher pacing  | `messaging/policy.ts`, `dispatch.ts`      | 1 s per account and per conversation by default; a spaced request stays QUEUED and is not claimed. The kit uses 0 |
| Inbound duplicates | `whatsapp/inbound/handler.ts`             | Existence check before any write                                                                                  |
| Staff timeline     | `inbox/timeline.ts` `listMessages`        | Organization-scoped; ordered by `occurred_at`, then id (P3)                                                       |

## 4. Implementation

- `src/modules/bot-runtime/closed-loop-six-bot.db.test.ts` (PostgreSQL closed loop; 36 cases, **passed on the authorized
  isolated run**, section 9). A local `sixBotWorld(order)` helper: `closedLoopKit.world()` deploys the first flow at priority 1, then
  `publishedBot` + `activateDeployment` add the other five at 2..6 on the same account. Fresh students share the world.
  Prompt ids and wamids come from captured FakeTransport payloads.
- `src/modules/bots/six-bot.test.ts` (database-free, SIX-CL-3).

### 4.1 Matrix and actual counts

| ID        | Cases   | What is asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SIX-CL-1  | 7       | (1) Six deployments ACTIVE on one account and organization, priorities 1..6 in the approved order, six distinct bots and versions, each pinned version's stored triggers equal its fixture, no session yet. (5) Every keyword of each keyword bot, as a FIRST message, starts that bot on its pinned version and deployment (exactly one session; the bot's welcome is the first send), not Student Enquiry. (1) A plain first message starts Student Enquiry (language menu).                                                                                                                                                    |
| SIX-CL-2  | 3       | (1) Fallback is first-message only: with Staff Routing alone, a plain first message is `no_trigger_match`; after the other five are deployed a later plain message is `no_trigger_match` (no change), `pay` starts Payment, and a fresh student's plain first message starts Student Enquiry. (1) **Inverted order** (Student Enquiry 1, test-only): each keyword bot's keyword as a first message starts Student Enquiry; zero sessions on any keyword bot. (1) A test-only `activationOrderViolations` check returns nothing for the approved order and `student_enquiry precedes <bot>` for all five under the inverted order. |
| SIX-CL-3  | 2 + 1 U | (1) `  PAY  `, `Join`, `STAFF`, `Classes`, `  iNfO` as first messages start their bots. (1) Near-misses (`pay now`, `info?`, `staffs`, `registering`, `class info`) as first messages fall back to Student Enquiry; none reaches a keyword bot. (U) All six flows' keywords unique under `comparisonKey` (17 keys); only Student Enquiry has `first_message`/`referral_source`, and it is last in the approved order.                                                                                                                                                                                                             |
| SIX-CL-4  | 4       | Same session, one session, no other bot: `pay` at SE's BUTTONS → `wrong_kind`; `register` at GI's LIST → `wrong_kind`; `pay` at RE's integer QUESTION → `answer_invalid`, `reg_name` unchanged; **`staff` at RE's free-text name QUESTION is accepted as `reg_name = "staff"`** and the year is asked (runtime property L5).                                                                                                                                                                                                                                                                                                      |
| SIX-CL-5  | 3       | After SR handover (`student_requested`): the other four openers, `hi`, a plain message → IGNORED `handover_unresolved`, counts and session unchanged. After RE "Yes, hand over" (`needs_staff`): same. Staff assignment of a live SE session: the next message is IGNORED `session_ended`, session HANDED_OVER `staff_assigned`; later keywords → `handover_unresolved`.                                                                                                                                                                                                                                                          |
| SIX-CL-6  | 2       | After GI END and after RE Cancel (END): every opener, `hi`/`menu` and a plain message → IGNORED `cooldown`; nothing else changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| SIX-CL-7  | 1       | Two organizations with six bots each; the same phone number writes to both accounts in one settle. One session each (Payment in A, Registration in B); two contacts with that `wa_id`, one per organization; `messages`, `outbound_requests`, `bot_triggers`, `bot_sessions` of each conversation carry only its organization and account; provider calls per `phone_number_id` go only to that account.                                                                                                                                                                                                                          |
| SIX-CL-8  | 3       | GI version switched mid-session: the live GI session keeps v1 text, the live RE session is unaffected, a new GI student gets v2 on the same deployment. Pause CI: its live session drains to COMPLETED; CI PAUSED, the other five ACTIVE and each still starts. With CI paused, `classes`/`class` as a first message fall back to Student Enquiry.                                                                                                                                                                                                                                                                                |
| SIX-CL-9  | 2       | Six students, one per bot, openers and taps delivered together each round and settled together (once with one bot worker, once with two workers claiming triggers concurrently): each reaches its expected terminal state; per session `bot_step_seq` contiguous, all BOT/ACCEPTED/attempt 1, terminal notice is the last step; wamids match the captured sends and are unique across all six; every provider call went to its own student from the account; every trigger PROCESSED.                                                                                                                                             |
| SIX-CL-10 | 3       | (1) **Production pacing**: the imported defaults (asserted 1 000 ms each) passed explicitly; one paced pass sends 1 of the 6 queued first prompts, 5 stay QUEUED (none HELD or dropped); then a bounded real-clock loop (100 ms poll, 15 s cap, about 5 s expected) drains them, each pass adding at most one ACCEPTED on the account; all six ACCEPTED, attempt 1; consecutive `send_started_at` ≥ 1 000 ms. (1) Bot dispatch gate off: nothing claimed, six QUEUED, attempt 0, no call. (1) Live send off (real `MetaTransport`): HTTP seam never called, six HELD `live_send_disabled`.                                        |
| SIX-CL-11 | 2       | One handover per bot (SR category, PE "I have paid", RE summary + "Yes, hand over", GI "Other question", CI "Class not listed", SE "Talk to a person"): the real staff `listMessages()` returns exactly one OUTBOUND message with that bot's notice text, and for RE exactly one INTERACTIVE summary containing every rendered line. Found by content, not position. Staff of another organization get an error (not found) for all six conversations; the owning staff can read them.                                                                                                                                            |
| SIX-CL-12 | 3       | `pay` delivered twice (same bytes) and re-serialized (same wamid), then once more after the start: 1 message, 1 trigger, 1 session, 2 requests, 2 calls. RE "Yes, hand over" delivered three times: one handover, one notice, one inbound row, one INPUT_ACCEPTED. The original `staff` keyword redelivered after a handover changes nothing.                                                                                                                                                                                                                                                                                     |
| SIX-CL-13 | 1       | Org A: staff take over Payment (`staff_assigned`, no further call), Stop General Information (`operator_stop`, no further call), Pause Class Information (drains to COMPLETED); Registration and Staff Routing students complete normally; GI and CI PAUSED, the other four ACTIVE. Org B: an archived contact's next tap causes no further call and leaves the session not waiting; an untouched student completes; after the account is disabled a new keyword starts and sends nothing. Org B's deployments stay ACTIVE and org A's account stays ACTIVE.                                                                      |

**Totals: 36 PostgreSQL cases + 1 database-free case.** The plan estimated about 42. It changed for these reasons: SIX-CL-2's
"keyword as first message" cases are SIX-CL-1's per-bot cases, not repeated; SIX-CL-7's separate cross-organization refusal case
is SIX-CL-11's second case; the near-miss interactive-title case is covered by `trigger-match.test.ts` (an interactive message
never matches a keyword) and is not repeated.

### 4.2 Fixture state set by SQL (existing precedent, not counters)

SIX-CL-13 sets `contacts.archived_at` and `whatsapp_accounts.status = 'DISABLED'` directly, as `early-reply`, `reconcile-notice`
and `closedLoopKit.world()` already do. No send counter, rate limit, timestamp or clock is changed anywhere.

### 4.3 Pacing boundary

- `closedLoopKit` dispatches with zero spacing, so every other case says nothing about pacing.
- The pacing case uses the real defaults, the real clock and no `settle()`: a spaced request stays QUEUED without being claimed,
  so a settle round could quiesce with work left.
- Proven (run passed; measurements in section 9.3): **account** spacing for six conversations on one account. **Not separately observable here**: conversation
  spacing (one account, both defaults 1 s); it is covered by `messaging/dispatch.db.test.ts` ("an account is paced").
- The hourly cap is not reachable in integrated real time; covered by `step.db.test.ts` C-4.

## 5. Reused evidence (not repeated)

| Topic                                                         | Existing evidence                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Every bot's paths, invalid input, idle reconciliation, safety | GI-CL, CI-CL-1..8, PE-CL-1..9, SR-CL-1..8, RE-CL-1..12; SE `closed-loop.db.test.ts` paths 1–6 |
| Pairwise keyword uniqueness                                   | Five `cross-bot keyword uniqueness` blocks in `bots/*.test.ts`                                |
| Takeover orderings, Stop, Pause                               | SE H1–H4, GI-CL-8a/8b/9, `staff-*`, `stop-boundary`, `pause-drain`                            |
| Duplicates, worker crash and recovery                         | SE A–G                                                                                        |
| Cooldown expiry, session cap, staleness                       | `eligibility.test.ts`, `step.db.test.ts`                                                      |
| Hourly cap                                                    | `step.db.test.ts` C-4                                                                         |
| Conversation pacing                                           | `messaging/dispatch.db.test.ts`                                                               |
| Capture gate (`BOTS_RUNTIME_ENABLED` off)                     | `gates.db.test.ts` (the kit's capture is always on)                                           |
| Engine-error mapping                                          | `step.db.test.ts` ENG and RE-CL-10 (**do not** close GI-CL-14)                                |
| Retention redaction                                           | GI-CL-13, RE-CL-11                                                                            |
| First-message and control-sequence ordering                   | `first-message-*.db.test.ts`, `control-sequence.db.test.ts`                                   |

## 6. Assumptions confirmed by the PostgreSQL run

All nine held; each is asserted by a case that passed.

1. Stored version `config.triggers` equal the fixtures' triggers (SIX-CL-1).
2. After a staff assignment ends a live session, a later keyword is `handover_unresolved` (the handover sequence is after the
   assignment's), not `staff_engaged` or `conversation_assigned` (SIX-CL-5).
3. A typed keyword at an integer QUESTION is recorded as `INPUT_REJECTED answer_invalid` (SIX-CL-4).
4. Six concurrent first messages are all ingested by one `webhookPass()` and all six requests are QUEUED after one
   `triggerPass()` (SIX-CL-10).
5. `send_started_at` is taken from the same clock reading as the pacing check, so the ≥ 1 000 ms gap is exact (SIX-CL-10).
6. Another organization's `listMessages()` rejects (not found) rather than returning an empty page (SIX-CL-11).
7. A tap from a contact archived mid-session causes no send and ends the session's waiting state (SIX-CL-13); the exact end
   reason is not asserted.
8. A disabled account's inbound event does not create a session; the webhook pass outcome itself is not asserted (SIX-CL-13).
9. Two bot workers' concurrent trigger passes complete without `settle()` failure (SIX-CL-9).

## 7. Production-readiness obligations (all OPEN; a passing six-bot suite closes none)

1. **GI-CL-14** — OPEN: PostgreSQL closed-loop engine-error evidence not established (OD-2).
2. **Inbox timestamp-ordering P3** — open; integrated browser verification needed before production readiness; the owner
   must still choose fix or accepted limitation.
3. **Automated deployment-priority activation guard** — none exists (OD-1); an inverted order silently routes keyword first
   messages to Student Enquiry (SIX-CL-2). Not implemented in this pass.
4. **Conversation-message retention policy** — unresolved (D-15; blockers 43, 45).
5. **Retention scheduling and operational verification** — `bots:retention` is operator-invoked, not scheduled (blocker 78).
6. **Real owner-approved bot content and Registration business data** — all six flows are synthetic (D-1, D-4..D-10, D-16).
7. **Integrated browser acceptance** — six-bot Inbox E2E (A-BRW-1/2, A-HND-1, A-RED-2), including timeline chronology.
8. **Real Meta verification** — owner-run (A-MET-1).

Product consequence recorded (not a defect): when a keyword bot is paused, its keyword as a first message starts Student
Enquiry (SIX-CL-8).

## 8. Verification boundaries

| Layer                  | Proves                                                                                                                 | Does not prove                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Database-free          | Six-set keyword uniqueness; only the last bot has implicit triggers                                                    | Anything persisted                                           |
| PostgreSQL closed loop | Bot selection, sessions and state, messages and requests, staff-scoped retrieval, gates, pacing, FakeTransport effects | Rendering, user-visible chronology, delivery, Meta behaviour |
| Browser E2E (future)   | Inbox rendering, chronology as staff see it, staff-facing presentation, UI states                                      | External delivery                                            |
| Real Meta (owner-run)  | External WhatsApp delivery, Meta-specific behaviour, real credentials and gates                                        | Production readiness on its own                              |

The PostgreSQL suite is not browser or Meta acceptance.

## 9. PostgreSQL validation (owner-authorized, one run, no retries)

### 9.1 Execution evidence (developer-reported, owner-accepted)

| Item      | Result                                                                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command   | `npx vitest run --config vitest.db.config.mts src/modules/bot-runtime/closed-loop-six-bot.db.test.ts --reporter=verbose`                                                                                                      |
| Attempt   | First and only authorized execution; no retry                                                                                                                                                                                 |
| Result    | **36 passed, 0 failed, 0 skipped**; exit code 0; Vitest duration 18.58 s; wall clock about 19 s (2026-10-31 11:26:24–11:26:43 +0530)                                                                                          |
| Server    | Isolated PostgreSQL 17.11 (`server_version_num` 170011), container `al-ict-phase08c-test-pg` (image `postgres:17`), bound only to `127.0.0.1:55432`, maintenance database `postgres`                                          |
| Harness   | Existing `createTestDatabase` (fresh `al_ict_test_<12hex>`, refuses `al_ict_whatsapp`, no FORCE drop), `closedLoopKit`, FakeTransport                                                                                         |
| Safety    | `TEST_DATABASE_ADMIN_URL` built in memory from the container's own credentials, passed inline, never printed or stored; `DATABASE_URL` and all bot, outbound, live-send, Meta, Graph and WhatsApp variables unset; host awake |
| Messaging | FakeTransport only, plus the real `MetaTransport` with its HTTP seam replaced by a test double (never called); no real Meta, Graph or WhatsApp network request                                                                |
| Cleanup   | Every database created by the run was dropped; no remaining disposable database, client session, Vitest, test-worker or application-worker process; output contains no credentials or connection strings                      |
| Source    | No source, test, runtime or migration change during the run; Git unchanged                                                                                                                                                    |

Protected scratch databases, identical names and OIDs before and after: `al_ict_test_270a70c6ec2d` (12374812),
`al_ict_test_38a045daa70d` (12365026), `al_ict_test_863638504a9b` (9984683), `al_ict_test_99a775ee2ef5` (3466016),
`al_ict_test_bcd1bc4ed7a6` (3405653), `al_ict_test_c8ff805d659a` (3405651), `al_ict_test_f045c40f31fd` (3466049).

The database-free SIX-CL-3 case (`src/modules/bots/six-bot.test.ts`) passed earlier in the unit suite (2,860/2,860).

### 9.2 Per-scenario results

| Scenario  | Passed |
| --------- | -----: |
| SIX-CL-1  |      7 |
| SIX-CL-2  |      3 |
| SIX-CL-3  |      2 |
| SIX-CL-4  |      4 |
| SIX-CL-5  |      3 |
| SIX-CL-6  |      2 |
| SIX-CL-7  |      1 |
| SIX-CL-8  |      3 |
| SIX-CL-9  |      2 |
| SIX-CL-10 |      3 |
| SIX-CL-11 |      2 |
| SIX-CL-12 |      3 |
| SIX-CL-13 |      1 |
| **Total** | **36** |

### 9.3 Real send pacing (SIX-CL-10, first case)

- **Configuration:** production-equivalent pacing. The imported `DEFAULT_ACCOUNT_MIN_INTERVAL_MS` and
  `DEFAULT_CONVERSATION_MIN_INTERVAL_MS` were asserted to be 1,000 ms and passed explicitly. The kit's zero spacing was not used,
  and dispatch was driven pass by pass on the real clock without `settle()`.
- **Results:**
  - The first paced pass left 1 ACCEPTED and 5 QUEUED, none HELD.
  - Each later pass added at most one ACCEPTED.
  - Final state: **6 ACCEPTED** (attempt 1, no hold reason), **0 QUEUED, 0 HELD**; 6 FakeTransport calls.
  - The **five consecutive `send_started_at` gaps were each asserted to be ≥ 1,000 ms.** This matches the code: a request is
    skipped while another send on the account started within the interval, and the gaps are measured on those stored values.
- **Duration:** about **5.39 s** for the whole scenario, inside its 15 s bound.
- **Not emitted by the test:** the individual interval values and the number of dispatch passes.
- **Not verified by this case:** the separate hourly cap, per-conversation spacing as a distinct condition, or any other
  production pacing behaviour.

### 9.4 Integrated outcomes verified on PostgreSQL

- All six synthetic bot versions were published and deployed together on one account, priorities 1–6 in the approved order.
- All 16 approved keyword routes, and the Student Enquiry first-message fallback, selected the intended bot.
- Every session was pinned to its correct bot, version and deployment, including across a mid-session version change.
- Inverted priority (Student Enquiry first) caused Student Enquiry to capture keyword first messages; the test-only check flagged
  it.
- Active sessions never switched bots. Keywords at button and list prompts were `wrong_kind`, at the integer question
  `answer_invalid`. `staff` at the free-text name question was stored as the name, and Staff Routing did not start.
- Pausing Class Information drained its live session and left the other five starting. While it was paused, its keyword sent as a
  first message started Student Enquiry.
- Unresolved handover (`handover_unresolved`, `session_ended` after staff assignment) and the 30-minute cooldown prevented
  unintended new sessions.
- Cross-organization isolation held, including the same phone number in two organizations. Concurrent execution passed with one
  and with two bot workers, with no duplicate sessions and unique message ids.
- Staff-scoped `listMessages()` returned each handover notice and Registration's rendered summary, matched by content, not order.
  Staff of another organization were refused.
- The disabled bot dispatch gate claimed nothing, and the disabled live-send gate HELD all six requests (`live_send_disabled`), so
  no actual send occurred. Takeover, Stop, Pause, an archived contact and a disabled account each affected only their target.
- No lead, registration or production operation resulted from any case. The flows are enquiry-only (V3.2 C.9), and no lead or
  registration path exists in them.

## 10. Status

| Item                        | State                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| SIX-CL-1..13 (36 cases)     | **PASSED** (36/0/0, one run)                                                             |
| SIX-CL-3 database-free case | Passed (unit suite)                                                                      |
| OD-1                        | Approved; activation-time priority guard **NOT IMPLEMENTED**                             |
| OD-2 / GI-CL-14             | **OPEN**; two-hour real-time test **NOT AUTHORIZED**                                     |
| Obligations 1–8 (section 7) | **Open**                                                                                 |
| Bot content                 | Synthetic test fixtures only                                                             |
| Milestone                   | **INTEGRATED POSTGRESQL VALIDATION PASSED — OWNER GIT CHECKPOINT COMMITTED (`0bd24b6`)** |
| Production activation       | **NOT AUTHORIZED**                                                                       |

Any further database run needs separate owner authorization.

**Reconciliation note (Phase 08G-7A, documentation only).** The checkpoint lines above were changed from "PENDING" to the
verified commit `0bd24b6`; the baseline table (section 1) still records the HEAD at the time of writing (`b4f2df6`). The run
results of section 9 are unchanged and apply to `closed-loop-six-bot.db.test.ts` as committed in `0bd24b6`. Phase 08G-7A
(uncommitted) changes that file: SIX-CL-2's inverted world is now written by test-only SQL, because the new production
routing guard refuses it, and its third case uses the production rule. That changed version was validated separately in the
owner-authorized 08G-7A isolated run (SIX-CL-2: 3 selected, 3 passed; `PHASE_08G-7_READINESS_AUDIT.md`, section 10.7); the
36/36 above is not that evidence.
