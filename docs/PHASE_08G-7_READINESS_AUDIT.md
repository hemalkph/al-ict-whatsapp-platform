# Phase 08G-7 — Production readiness audit and closure plan

Status: **DRAFT; OWNER-REVIEWED. PHASE 08G-7A ACCEPTANCE DOCUMENTED — OWNER GIT CHECKPOINT PENDING** (guard and GI-CL-14a
implemented, independently reviewed, isolated PostgreSQL validation passed; uncommitted; section 10.7). Phase 08G-7 as a whole
and production readiness are **NOT** complete. The audit itself (sections 1–9) was read-only. No production code, test, migration or earlier milestone record was
changed. No database was connected to and no SQL was run. No browser, Playwright, worker, Meta or WhatsApp call was made. Retention
was not run, nothing was scheduled, and no secret was read. Production activation: **NOT AUTHORIZED.**

## 1. Baseline (verified 2026-10-31)

| Item                    | Result                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                  | `Bot-Foundation`                                                                                                                        |
| HEAD                    | `0bd24b6` "Validate integrated six-bot routing and runtime boundaries"                                                                  |
| `origin/Bot-Foundation` | `0bd24b6` (the local remote-tracking ref; **no `git fetch` was run**, so the remote itself was not re-queried)                          |
| Working tree            | Clean before this draft                                                                                                                 |
| 08G checkpoints         | `2423f26` GI (08G-1), `f0af1f9` CI (08G-2), `e00b261` PE (08G-3), `506e664` SR (08G-4), `b4f2df6` RE (08G-5), `0bd24b6` six-bot (08G-6) |

**Outdated wording in the 08G-6 record (corrected in 08G-7A, see section 10).** `PHASE_08G-6_ACCEPTANCE.md` was committed in `0bd24b6`, but it
still reads "OWNER GIT CHECKPOINT PENDING" on line 3 and in the status table on line 248. Its baseline table on line 16 gives
HEAD `b4f2df6`, which was correct when it was written. The owner approved reconciling them (OD-DOC); 08G-7A changed them to `0bd24b6` and added a visible reconciliation note.

**Superseded wording on record.** `PHASE_08G-1_APPROVAL_ADDENDUM.md` (correction 2) still contains an earlier Registration cancel
text. `PHASE_08G-5_ACCEPTANCE.md` section 3 records the later approved wording, and the fixture uses that later wording. Both texts
remain on record. The owner should confirm the 08G-5 text is final (checklist item RE-7).

## 2. Executive verdict

**The platform is NOT production-ready for bot activation.** The six bots work together correctly as synthetic fixtures on
isolated PostgreSQL (08G-6, 36/36). Four obligations still block activation, and none of them can be closed by adding more tests
of the existing kind:

1. **G7-3:** nothing in production code stops a deployment priority order that sends keyword traffic to the wrong bot.
2. **G7-4:** the Registration and Student Enquiry personal data stays in message history, outbound payloads and raw webhook bodies
   with no retention limit. Redacting the session variables does not remove it.
3. **G7-5:** session redaction and trigger deletion run only when someone runs them by hand. Nothing schedules or monitors them.
4. **G7-6:** all six flows contain only synthetic content.

G7-7 (browser) and G7-8 (real Meta) are missing verification layers that are also needed before activation. G7-1 needs a small
additional test plus an owner decision to accept the remaining risk. G7-2 is a P3 display defect: it needs browser confirmation
and then an owner choice between fixing it and accepting it as a limitation.

## 3. Eight-gate status matrix

| Gate | Subject                          | Kind                                               | Severity | Blocks activation                                   | Status                                                                                                              |
| ---- | -------------------------------- | -------------------------------------------------- | -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| G7-1 | GI-CL-14 engine-error evidence   | Missing test evidence                              | P3       | Only until the owner accepts the risk (OD-G7-1)     | OPEN (supplementary GI-CL-14a passed; GI-CL-14 open)                                                                |
| G7-2 | Inbox timestamp ordering         | Technical defect, impact not yet seen in a browser | P3       | No, if the owner accepts it after the browser check | OPEN                                                                                                                |
| G7-3 | Deployment-priority guard        | Configuration hazard, no enforcement               | **P1**   | **Yes**                                             | IMPLEMENTED — INDEPENDENTLY REVIEWED — ISOLATED POSTGRESQL VALIDATION PASSED (operational conditions, section 10.7) |
| G7-4 | Message retention policy         | Privacy-policy decision                            | **P1**   | **Yes**                                             | OPEN (inventory drafted)                                                                                            |
| G7-5 | Retention scheduling / operation | Operational procedure missing                      | **P1**   | **Yes**                                             | OPEN                                                                                                                |
| G7-6 | Real bot content and data        | Business data missing                              | **P1**   | **Yes**                                             | OPEN                                                                                                                |
| G7-7 | Integrated browser E2E           | Missing test evidence                              | P2       | **Yes**                                             | OPEN                                                                                                                |
| G7-8 | Real Meta integration            | Missing provider evidence                          | **P1**   | **Yes**                                             | OPEN                                                                                                                |

Severity: P1 = activating could misroute students, expose personal data or fail silently. P2 = staff could be misled, or a
verification layer is missing. P3 = cosmetic or narrow.

## 4. Findings

### G7-1 — GI-CL-14 engine-error evidence

**Established (with evidence):**

| Layer                   | Evidence                                                                                                                                         | What it proves                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure engine             | `bots/engine.ts:436` (`sendCount >= sendsPerSession` → `fail("SEND_BUDGET")`), `:501` (notice skipped); `engine.test.ts:1062`, `:1236`           | The 60-send budget is enforced and the error is shaped correctly                                                                                                                          |
| Simulator               | `general-info.test.ts` ("an internal engine error ends as engine_error…")                                                                        | The GI flow's engine-error termination contract                                                                                                                                           |
| PostgreSQL, step level  | `bot-runtime/step.db.test.ts:2669-2770` (ENG). Real runtime and real database guards; `send_count` **seeded to 60** on an otherwise real session | SEND_BUDGET → HANDED_OVER `engine_error`, `end_reason = error`, no terminal notice, no new request, `ERROR:send_budget`, input consumed once. Also the noticeSkipped SEND_BUDGET END path |
| PostgreSQL, closed loop | RE-CL-10 renderer-error regression (08G-5)                                                                                                       | The closed-loop kit maps an engine error (`render_rejected`) to `engine_error` with no extra request or call                                                                              |
| Hourly cap              | `step.db.test.ts:1513` (C-4): the 31st BOT request in an hour is refused and the session is handed over (`send_refused`)                         | Within one rolling hour, a session hits the 30-request cap before it can reach 60 sends                                                                                                   |

**Missing:** no closed-loop run has made `send_count` reach 60 through real sends. **No closed-loop test asserts `send_count` at
all** (grep of `closed-loop*.db.test.ts`). So the seeded value in ENG is assumed to match what real sends would produce, but no
integrated test checks that.

**Reachability in production.** Reaching SEND_BUDGET needs at least 60 BOT requests in one session. With no more than 30 per rolling
hour (anything more is handed over), the session must last over an hour, and the student must answer each prompt within the
30-minute idle timeout. GI makes 3 sends per topic cycle, so that is about 20 cycles. This is possible but unlikely. If it happens,
the failure is safe: the session is handed over to staff and nothing is sent.

**Safe, bounded options (no clock, counter or rate-limit change):**

- **(a) Recommended: GI-CL-14a counter-accumulation check.** Add one closed-loop case that drives GI through K real cycles (K = 9
  gives 27 sends, under the hourly cap) on the real clock. After each step, assert that `bot_sessions.send_count` equals the
  number of BOT `outbound_requests` for the session. That proves the counter the ENG test seeds is the counter real sends
  increase. ENG already covers the hand-over once it reaches 60. Expected cost is under 30 s per run.
- (b) A logical-clock extension of the kit (08G-1 addendum, GI-CL-14 row). This is a large change. It would need to shift the
  clocks of dispatch, staleness, expiry and the hourly window together. Not recommended.
- (c) Lowering the budget in a test, or seeding the counter in the closed loop. **Not acceptable**: this is the counter and limit
  manipulation OD-2 rules out.
- The two-hour real-time run stays **not authorized**.

**Owner decision OD-G7-1:** accept the following as closing GI-CL-14: ENG (seeded, PostgreSQL) + RE-CL-10 + simulator + GI-CL-14a.
The remaining risk would be stated as: "the 60th send is never reached organically in an integrated test; the composition rests
on the counter-accumulation proof." Consequence if not accepted: GI-CL-14 stays open, and only option (b) remains.

**Acceptance:** GI-CL-14a passes once on the isolated server, and the owner records OD-G7-1.

### G7-2 — Inbox timestamp ordering (P3)

**Confirmed from source (a data-layer defect):**

- Inbound `occurred_at` is the provider's timestamp in whole seconds (`whatsapp/time.ts` `parseProviderTimestamp`, `seconds *
1000`), so it is always `.000`.
- Outbound `occurred_at` is the server clock in milliseconds at enqueue time (`messaging/enqueue.ts:183`).
- The server order is `occurred_at DESC, id DESC` (`inbox/timeline.ts:94`), and the keyset cursor is `(occurred_at, id)`
  (`:93`), served by `messages_timeline_idx`.
- The tie-break `id` is `gen_random_uuid()` (`_shared.ts:14`, migration 0000). It is stable but **random**, not chronological.
- Client polling merge (`inbox/merge.ts` `mergeMessages`) sorts new messages by `occurredAt` only, with **no `id` tie-break**.
  For equal timestamps, a live poll can therefore show an order that differs from the order after a reload. This is a second,
  smaller inconsistency.
- The runtime reads the stored inbound time: `eligibility.ts:134` (`inputOccurredAtMs <= L.createdAtMs`) and `:158`, plus
  staleness. **Changing what `occurred_at` stores would change bot behaviour**, not only the display.

**User-visible risk:** a reply recorded in the same wall-clock second as the prompt it answers, with the prompt's enqueue time
having milliseconds above `.000`, sorts before that prompt. Clock skew makes this more likely: when the server clock runs ahead of
Meta's, outbound times are stamped later. A person rarely answers within the same second, so typical traffic should be affected
rarely. Skew and automated clients make it more frequent. **No browser reproduction exists.**

**Browser verification plan (part of G7-7):** seed two conversations by SQL, the way `e2e/support/bot-fixtures.ts` does:

- (i) an OUTBOUND prompt at `T.700` and an INBOUND reply at `T.000` with `reply_to_wamid` = the prompt;
- (ii) the same pair with equal timestamps.

Then assert three things: the rendered order after a full load, the order after a poll merge, and the order across a page
boundary (load-more with exactly one page plus the pair split by the cursor). Record what staff see. This confirms or rules out
misleading chronology without any production change.

**Candidate solutions (for evaluation only, none implemented):**

| Option                                                                                                                                            | Pagination / cursor                              | Historical rows                                      | Stability                                                                                  | Runtime impact                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| A. Accept and document the limitation                                                                                                             | None                                             | None                                                 | Unchanged                                                                                  | None                                       |
| B. Client-only causal adjustment: show an inbound reply after the message its `reply_to_wamid` names, when both are loaded and in the same second | None (server order unchanged)                    | None                                                 | Deterministic. Covers only replies that carry a context, and only inside the loaded window | None                                       |
| C. Server sort `(occurred_at, created_at, id)`                                                                                                    | Cursor format and index change (migration)       | Existing rows keep their `created_at`                | Better within a second, but `created_at` is the processing time (webhook-worker delay)     | None, if `occurred_at` is untouched        |
| D. Add a separate `display_at` column (server arrival time, single clock)                                                                         | New index, cursor change, migration and backfill | A backfill is needed and is approximate for old rows | Single clock. A late webhook retry would sort at its arrival time                          | None, if the runtime keeps `occurred_at`   |
| E. Clamp or rewrite `occurred_at`                                                                                                                 | Changes cursors                                  | Rewrites provider facts                              | —                                                                                          | **Changes runtime eligibility. Rejected.** |

In every option, the client merge should tie-break on `id` like the server does. That is a one-line client fix and needs separate
authorization. Recommendation: first the browser check. If it reproduces, B plus the tie-break is the smallest fix, with no schema
change. If it does not reproduce, choose A.

**Owner decision OD-G7-2:** after the browser check, choose A or B (or C/D, which need a migration review).

### G7-3 — Deployment-priority activation guard (P1)

**Paths inspected** (`bot-control/deployments.ts`). The only production writers of deployment state are `activateDeployment`,
`changeDeploymentVersion`, `pauseDeployment`, `resumeDeployment`, `stopActiveSessions`, `retireDeployment` and `emergencyStop`.
The operator CLI reaches them through `bots:admin` (`operator.ts:47`, `activate … --priority <1-1000>`). There is no HTTP route for
bots. The database enforces only uniqueness: one priority and one deployment per bot, per account, among non-RETIRED deployments
(`0007:256-257`). **No priority-update operation exists.** To correct an order, a deployment must be retired, which hands its live
sessions over, and then re-activated.

**Three paths can create the hazard, not one:**

1. `activateDeployment` with an implicit-trigger bot (`first_message`/`referral_source`) at a lower priority number than a
   keyword-only bot.
2. `resumeDeployment` of a deployment whose priority is already wrong. Eligibility considers only ACTIVE deployments
   (`eligibility.ts:163`), so a wrong order can sit unnoticed while a deployment is PAUSED and take effect on resume.
3. `changeDeploymentVersion` to a version whose triggers add `first_message`, on a deployment that sits before keyword bots. The
   priority never changes on this path, but the hazard does. **This path is not mentioned in the 08G-6 record.**

A related hazard is not covered by any check: if two deployments on one account share a keyword, the higher-priority one silently
takes all of it. The six-bot set is unique (SIX-CL-3), but the uniqueness is checked only inside each flow's validator, not at
deployment time.

**Test-only checker versus enforcement.** `activationOrderViolations` (`closed-loop-six-bot.db.test.ts:112`) is a pure function
inside a test file. It proves the rule can be expressed, and it enforces nothing.

**Proposed smallest reliable enforcement (not authorized):**

- Move the pure rule into `src/modules/bots` (production, pure, database-free).
- Call it from `activateDeployment`, `resumeDeployment` and `changeDeploymentVersion`, inside their existing transactions. Evaluate
  it over **all non-RETIRED deployments of the account**, using each one's pinned version triggers and the proposed change.
- Refuse with a new `BotControlError` code, for example `PRIORITY_ORDER_UNSUPPORTED`, naming the conflicting bot keys. Do not
  reorder automatically.
- **Concurrency:** today `lockBot` locks only the bot. Two activations on one account could each pass the check against the
  other's uncommitted state. The guard must serialize per account, for example with `SELECT … FOR UPDATE` on the
  `whatsapp_accounts` row. That lock must be placed in the L.2 lock order and reviewed against `concurrency.db.test.ts`.
- **Optional (owner decision):** include the cross-deployment keyword-collision check in the same guard.
- **Tests:** a pure unit test of the rule. PostgreSQL tests: each of the three paths refused with the inverted order and allowed
  with the approved order; concurrent activations on one account (exactly one succeeds); an existing approved six-bot world
  unaffected. SIX-CL-2's inverted-order case would need the order set by SQL or an explicit test-only bypass. The owner decides
  which; a bypass must not exist in production code.

**Acceptance:** every path that can make a deployment ACTIVE, or change its triggers, refuses an unsupported order, and this is
proven on PostgreSQL, including the concurrent case.

### G7-4 — Conversation-message retention policy (P1, privacy decision)

**What the code does today:**

| Data                                                                                                                                                   | Where                                                        | Retention behaviour                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session variables (`reg_name`, `al_year`, `class_pref`, SE `student_name`, `grade`, `wants_call`), `awaiting`, `awaiting_token`, `last_consumed_token` | `bot_sessions`                                               | **Redacted** (cleared) 30 days after `ended_at` by `redact_expired_bot_sessions` (`0007:510`), but only when `bots:retention --apply` runs. 30 days is the "owner-approved **development** default" (`0007:400-402`), hard-coded in SQL. Changing it needs a migration |
| Session row (lifecycle, node, counters, ids, timestamps)                                                                                               | `bot_sessions`                                               | **Kept forever.** The guard refuses DELETE (`0007:417-418`)                                                                                                                                                                                                            |
| Session events (kind, code, message id, step)                                                                                                          | `bot_session_events`                                         | **Kept forever**, append-only (`0007:545`). No text                                                                                                                                                                                                                    |
| Deployment events                                                                                                                                      | `bot_deployment_events`                                      | Kept forever, append-only. Contains no personal data                                                                                                                                                                                                                   |
| Triggers (message id, times, codes, no text)                                                                                                           | `bot_triggers`                                               | **Deleted** when terminal and 14 days past `processed_at` (`db/ops/bot-trigger-retention.ts`, D-1), only when the job runs                                                                                                                                             |
| **Inbound message text** (for example the name a student types at `ask_name`, the year, any unsolicited message)                                       | `messages.body/content`                                      | **Kept forever.** No job                                                                                                                                                                                                                                               |
| **Outbound rendered text**, including the Registration confirmation summary "Name: … A/L year: … Class: …"                                             | `messages.content`                                           | **Kept forever.** No job                                                                                                                                                                                                                                               |
| The same outbound text plus the recipient identifier                                                                                                   | `outbound_requests.payload`                                  | **Kept forever** (blocker 43)                                                                                                                                                                                                                                          |
| Raw webhook bytes and event payloads (the inbound name again)                                                                                          | `webhook_requests.raw_body`, events                          | **Kept forever** (blocker 9). Held and DEAD events must be exempt from any future deletion                                                                                                                                                                             |
| Notes, conversation events, read state                                                                                                                 | `conversation_notes`, `conversation_events`, `message_reads` | **Kept forever.** Notes and history are append-only by trigger (blocker 45)                                                                                                                                                                                            |
| Lead history and attribution evidence                                                                                                                  | `lead_*`                                                     | Kept forever. Immutable by trigger (blockers 60, 65)                                                                                                                                                                                                                   |

**The key fact:** redacting the session variables **does not** remove any of the Registration personal data from the platform. The
name, year and class still exist in at least four places: the inbound message, the rendered outbound summary, the outbound payload,
and the raw webhook body. GI-CL-13 and RE-CL-11 prove the redaction and nothing more.

**Owner decisions needed (OD-G7-4). No period is proposed here:**

1. Retention period for message bodies (inbound and outbound), and whether Registration enquiry conversations get a shorter period.
2. Whether expiry means deleting rows or redacting body/content in place. Redaction keeps the evidence headers that 08E requires:
   message identity, direction, type and `created_at` for first-message history (`PRE_PRODUCTION_BLOCKERS.md`, 08E-0 note).
3. Retention period for `outbound_requests.payload` (it can be shorter than the message, once the request is terminal).
4. Retention period for raw webhook bodies, with the exemption for held, DEAD and unfinished events.
5. Notes, conversation events and read state: period and erasure route (this needs a reviewed migration that deliberately lifts
   the append-only trigger).
6. Whether 30 days stays the production session-redaction period (it is a SQL function; changing it is a migration).
7. Whether to support erasure requests from a student, and how. Today nothing can erase personal data from the application.
8. Whether the Registration consent text ("Your answers are used only for this enquiry and are seen by our staff") matches the
   chosen policy. If retention is long, that text may need to say so.

**Acceptance:** a written, owner-approved retention schedule covering every row of the table above, and consent wording consistent
with it. Implementation of any new deletion or redaction job is a separate, reviewed milestone.

### G7-5 — Retention scheduling and operations (P1)

**Current state:** `bots:retention` (`scripts/bots-retention.ts`, `bot-control/retention.ts`) runs only when invoked. It is a dry
run by default and applies only with `--apply`. It has no schedule, no HTTP route and no membership. It uses one connection with
`lock_timeout` 5 s and `statement_timeout` 60 s. It works in batches of 500, up to 20 batches per organization per part, and
reports `sessionsRemaining`/`triggersRemaining` when its budget ran out. Exit codes: 0 OK, 1 partial failure, 2 usage error. It
prints one JSON document on stdout and writes the `bots.sessions_redacted` / `bots.triggers_deleted` log events to stderr.

**Not present anywhere in the repository:** a cron or scheduler definition (CI runs tests only; `docker-compose.yml` defines only
PostgreSQL; `DEPLOYMENT.md` leaves the host undecided), supervision, alerting, retained run reports, or a runbook section for
missed or failed runs. **No production run has ever happened.**

**Minimum operational controls (proposed, not configured):**

1. A daily scheduled `node --import tsx scripts/bots-retention.ts --apply`, run directly rather than through `npm` (blocker 26
   pattern), under a dedicated database role.
2. An alert on any non-zero exit or `ok: false`. Also alert when `sessionsRemaining` or `triggersRemaining` stays true on two
   consecutive runs, since that means the backlog exceeds the budget.
3. Keep every JSON report as audit evidence, with a retention period of its own. Reports contain only organization ids, counts and
   SQLSTATEs.
4. Before the first `--apply`: one owner-reviewed dry run on the production database, with its counts recorded.
5. A runbook entry covering the schedule, how to verify a run, how to read a partial failure, the behaviour during a migration
   (stop the job, because its `lock_timeout` ends a batch), and who is notified.
6. The same scheduling decision should also cover `leads:reconcile` (blocker 67), and later the message retention jobs from G7-4.

**Acceptance:** the schedule exists on the chosen host; a dry run and a first apply are recorded; an alert is proven by one
deliberately induced failure in a non-production environment; the runbook entry is reviewed.

### G7-6 — Real bot content and business data (P1)

Every value below is synthetic or a placeholder (`src/modules/bots/testing.ts`). Nothing may be published until the owner supplies
or approves each item. Nothing here is invented.

| #    | Bot                  | Item to supply or approve                                                                                                                                                                                                                                                     |
| ---- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SE-1 | Student Enquiry      | `enquiryFlow` predates 08G and is **not marked synthetic**, yet all of it is test data: the welcome texts in three languages, the menu, the `https://example.org/classes` link, "Our fee list is shared by staff", "We will contact you", "Goodbye!"                          |
| SE-2 | Student Enquiry      | It asks "Which grade are you in?" (integer 1–13) and stores `student_name` (sensitive), `grade` and `wants_call`. Decide whether Student Enquiry collects any personal data at all, or sends "I want to join" to Registration Enquiry (whose consent screen SE does not have) |
| SE-3 | Student Enquiry      | Greeting keywords (`hi`, `menu`, `ආයුබෝවන්`, `வணக்கம்`) and the first-message / referral catch-all                                                                                                                                                                            |
| GI-1 | General Information  | The real FAQ topics (at most 4 here, within the LIST limit of 10 rows including "Other question" and "Talk to staff"; title ≤ 24, description ≤ 72) and their answers (≤ 1024 each)                                                                                           |
| GI-2 | General Information  | Welcome text and the keywords `info`, `faq`                                                                                                                                                                                                                                   |
| CI-1 | Class Information    | The real classes (names, schedules, format, where or how to join)                                                                                                                                                                                                             |
| CI-2 | Class Information    | Approved joining links, if any (link policy: which domains may appear)                                                                                                                                                                                                        |
| PE-1 | Payment Enquiry      | "How to pay" instructions (D-9) and payment dates (D-10). Keep the "never send card numbers, PINs, passwords or OTP codes" warning, or replace it with approved wording                                                                                                       |
| PE-2 | Payment Enquiry      | Confirm the enquiry-only boundary: "I have paid" and "Payment problem" always hand over                                                                                                                                                                                       |
| SR-1 | Staff Routing        | Confirm the five generic categories (D-12) and the handover wording, including "I can't say how soon"; any staffed hours or response-time statement                                                                                                                           |
| HO-1 | All                  | The shared handover texts (`to_staff`, `needs_staff`, `invalid_to_staff`, `error_to_staff`) and END "Thank you. This enquiry is complete."                                                                                                                                    |
| RE-1 | Registration Enquiry | Supported A/L years (D-16). The fixture uses 2101–2103                                                                                                                                                                                                                        |
| RE-2 | Registration Enquiry | The real class list (row title ≤ 24, stored `class_pref` ≤ 40)                                                                                                                                                                                                                |
| RE-3 | Registration Enquiry | Consent wording, checked against the G7-4 policy                                                                                                                                                                                                                              |
| RE-4 | Registration Enquiry | The confirmation-summary layout and the "not a confirmed registration" handover wording                                                                                                                                                                                       |
| RE-5 | Registration Enquiry | Name bounds (2–80, links rejected)                                                                                                                                                                                                                                            |
| RE-6 | Registration Enquiry | Keywords `register`, `registration`, `join`                                                                                                                                                                                                                                   |
| RE-7 | Registration Enquiry | Confirm the final cancel wording (08G-5 text versus the superseded addendum text)                                                                                                                                                                                             |
| ALL  | All                  | Sinhala and Tamil versions of every keyword bot, if wanted. Today only Student Enquiry is trilingual. Plus the deployment order (OD-1 approved) and which bots are deployed on which account                                                                                  |

**Process (proposed):** real content goes into new flow definitions, never into the fixtures. Each definition passes the validator,
the claim scanners (`registrationClaimViolations`, `paymentClaimViolations`) and cross-bot keyword uniqueness. The owner signs off
the rendered text.

**Acceptance:** six owner-signed definitions, each validated and passing a database-free simulation of its golden paths, with no
`[TEST]`, `SYNTHETIC` or `example.` strings in them.

### G7-7 — Integrated browser E2E (P2)

**Existing:** `e2e/inbox-bot.spec.ts` (08F, the `chromium-bots` project, `npm run test:e2e:bots`). Its bot history is written by
plain SQL (`e2e/support/bot-fixtures.ts`), every gate is off, and nothing can send. It passed 11/11 once (2026-10-27). It covers
bot indicators, Bot attention, the VIEWER boundary, cross-organization isolation, session details including the redaction marker,
interactive rendering, terminal notice warnings, and a check that browsing sent nothing. **It does not use the six real flow
fixtures or their rendered texts**, and it does not test chronology.

**Known harness blocker:** in the ordinary combined run (2026-10-28: 180 passed, 1 failed, 10 not run), the bot STAFF user failed
to sign in, because `auth.spec.ts` changes the admin password whose hash the bot fixture copied. The fix (copy `INBOX_USERS.viewer`'s
hash) was validated without a database but **not in a browser**. The owner deferred it. A first ordinary-mode run is needed before
relying on the combined suite.

**Proposed six-bot browser acceptance (A-BRW-1/2, A-HND-1, A-RED-2):** extend the SQL fixtures so they write each bot's real rendered
outbound texts (taken from the six fixtures), together with the student replies. Then assert:

1. Staff timeline per bot: welcome, list or buttons rendered as interactive, the student selection, and the notice, in the expected
   order.
2. Handover notices: one per bot, the text matched exactly, and the indicator shows the reason.
3. Registration: the summary renders every line; after redaction the session panel shows the redaction marker while the summary
   message stays visible (it shows staff what redaction does **not** remove; ties to G7-4).
4. Session states: live, completed, handed over, failed, idle-completed.
5. Controls: staff takeover by reply or assignment visibly ends the session. Pause, Stop and Emergency Stop are CLI-only, so assert
   their effect on screen, not a control.
6. The G7-2 ordering scenarios (section G7-2).
7. Phone-size layout and a VIEWER pass for each of the above.

**Acceptance:** the bots-only run and one ordinary-mode run both pass, each once and owner-authorized, on a disposable database, with
the server-log check unchanged.

### G7-8 — Real Meta integration (P1)

**Covered by FakeTransport, or by MetaTransport with its HTTP seam stubbed:** payload construction for text, template and
interactive messages (`messaging/meta-transport.ts:195`, `interactive.ts`), the success and error response mapping, UNKNOWN_OUTCOME
on any ambiguous outcome, the single attempt (loopback sockets, `network.test.ts`), the gates (live-send off → HELD
`live_send_disabled`, SIX-CL-10), pacing, and the inbound signature over the exact bytes (E2E, synthetic).

**Never verified against Meta:**

- delivery of interactive button and list messages as rendered (no evidence row covers the interactive request shape);
- the `button_reply` / `list_reply` webhook shapes and ids coming back from a real tap;
- real `sent` / `delivered` / `read` statuses (blocker 25);
- the wire form of Sinhala and Tamil (blocker 10);
- the throttle contract (blocker 41) and the real limits (blocker 37);
- BSUID `recipient` (blocker 32; the gate stays off);
- reactions and the service window (blocker 15);
- the identity-change event (blocker 8).

**Controlled verification plan (owner-run; each step needs explicit live-send approval):**

- Prerequisites: a Meta **test** number and WABA (not the production number); one owner-controlled test recipient handset; a
  token kept in the operator's secret store (never in the repository, logs or CI); a dedicated non-production database; the
  account set ACTIVE only for the window; `WHATSAPP_OUTBOUND_ENABLED` and the live gate enabled only for the window; the bot
  runtime enabled only for that account.
- Steps, each with an expected effect:
  1. A staff text with Sinhala and Tamil: ACCEPTED, then a `sent`/`delivered` status linked to the request.
  2. Student Enquiry `hi` from the handset: the language BUTTONS arrive, a tap returns `button_reply` with the expected id, and the
     session advances.
  3. A LIST bot (`info`): the list arrives, the selection returns `list_reply`.
  4. A handover notice arrives.
  5. Registration end to end, with the summary.
  6. A read receipt.
- Rollback and stop conditions: any response that is not an expected shape, any UNKNOWN_OUTCOME, any message to anyone other than
  the test handset, or any status not linked to its request → Emergency Stop, then disable the account, then turn the gates off and
  stop the workers. Keep the evidence (sanitized responses and statuses) in an owner-held folder. Revoke or rotate the token
  afterwards if the owner policy requires it.
- Out of scope: BSUID `recipient`, templates outside the window, throttling (do not provoke it).

**Acceptance:** an owner-signed evidence record for steps 1–6, with each previously unverified shape compared against the parser's
assumptions, and every finding filed.

## 5. Defects versus evidence gaps

- **Confirmed defects (from source):**
  - G7-2: mixed timestamp precision with a random-UUID tie-break; client merge without a tie-break.
  - G7-3: no production enforcement on three paths, no per-account serialization for such a guard, and no keyword-collision check
    at deployment.
- **Configuration hazards:**
  - G7-3: inverted order; resume of a wrong order; a version change that adds a catch-all.
  - SIX-CL-8: a paused keyword bot's keyword falls back to Student Enquiry. This is a recorded product consequence.
- **Privacy-policy decisions:**
  - G7-4: all eight items.
  - SE-2: whether Student Enquiry collects personal data.
  - RE-3: consent wording.
- **Missing test evidence:**
  - G7-1: no `send_count` accumulation check;
  - G7-7: no six-bot browser run, and the ordinary-mode auth fix not yet seen working in a browser;
  - G7-8: no real provider evidence.
- **Incomplete operational procedures:** G7-5 (schedule, alerts, runbook), the bots worker supervision (blocker 76), and the
  `bots.trigger_capture_failed` alert (blocker 77).

## 6. Owner decisions

| ID       | Decision                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| OD-G7-1  | Accept the GI-CL-14 closure composition (G7-1 option a) and its stated residual risk                          |
| OD-G7-2  | After the browser check: accepted limitation (A) or client causal adjustment (B); C/D need a migration review |
| OD-G7-3a | Authorize the production priority guard (three paths, account lock)                                           |
| OD-G7-3b | Include the cross-deployment keyword-collision check in it, or not                                            |
| OD-G7-3c | How SIX-CL-2's inverted case is constructed once the guard exists (SQL setup versus a test-only bypass)       |
| OD-G7-4  | The retention schedule, items 1–8                                                                             |
| OD-G7-5  | Scheduler host, alert recipient, report retention                                                             |
| OD-G7-6  | Content checklist SE-1..ALL                                                                                   |
| OD-G7-7  | Authorize the G7-7 browser runs and fixture extension                                                         |
| OD-G7-8  | Meta test assets, live-send windows, evidence location                                                        |
| OD-DOC   | Reconcile the 08G-6 "checkpoint pending" lines (documentation only), or leave them as they are                |

## 7. Ordered closure checkpoints

Work marked **[independent]** can start once authorized. Work marked **[owner data]** waits for the owner.

| Order | Checkpoint                                                                                           | Depends on                                                                  | Kind                            |
| ----- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------- |
| 1     | **G7-3** priority guard: pure rule in `bots`, enforcement in the three services, account lock, tests | OD-G7-3a/b/c                                                                | [independent]                   |
| 2     | **G7-1** GI-CL-14a counter-accumulation case, one isolated run                                       | OD-G7-1 (to close)                                                          | [independent]                   |
| 3     | **G7-4** retention schedule decided; consent wording aligned                                         | OD-G7-4                                                                     | [owner data]                    |
| 4     | **G7-5** retention operations: host, schedule, alerts, runbook, first dry run                        | OD-G7-5, the deployment milestone                                           | [owner data]                    |
| 5     | **G7-6** real content: six definitions, validated and owner-signed                                   | OD-G7-6, item 3 (RE-3)                                                      | [owner data]                    |
| 6     | **G7-7** browser: verify the ordinary-mode auth fix, six-bot browser spec incl. the G7-2 scenarios   | item 5 for real texts (synthetic texts are acceptable for the harness part) | [independent] then [owner data] |
| 7     | **G7-2** decision and, if B, the client fix                                                          | item 6                                                                      | owner choice                    |
| 8     | **G7-8** controlled Meta verification                                                                | items 1, 5, 6; OD-G7-8                                                      | owner-run                       |
| 9     | Message-retention jobs from G7-4 (separate milestone)                                                | item 3                                                                      | later                           |

Not repeated: the SIX-CL, GI/CI/PE/SR/RE-CL and SE closed-loop suites. Each new test above fills a specific gap named in section 4.

## 8. Final production-activation criteria

Activation may be requested only when **all** of the following hold:

1. G7-3 enforcement is merged, its PostgreSQL tests (including the concurrent case) passed, and the approved order is configured.
2. GI-CL-14 is closed under OD-G7-1, or the owner explicitly accepts that it remains open.
3. The retention schedule (G7-4) is owner-approved, and the consent wording is consistent with it.
4. `bots:retention` is scheduled, alerting, and has a recorded dry run and apply on the target database (G7-5).
5. Six owner-signed real definitions are published. No fixture is published.
6. The six-bot browser acceptance passed, and the G7-2 decision is recorded.
7. The Meta verification evidence is signed off.
8. The existing blockers that apply to bots are resolved or accepted by the owner: 26, 38 and 76 (worker supervision), 75
   (migrations 0007–0009 on the target database, in a maintenance window), 77 (capture alert), 80 (the activation plan).
9. The owner gives explicit, written activation approval.

## 9. Changes proposed but not authorized

- Production: the priority guard in `bot-control/deployments.ts` and a pure rule in `src/modules/bots`; the `id` tie-break in
  `inbox/merge.ts`; Inbox option B (if chosen); retention jobs for messages, payloads, raw bodies and notes (after G7-4).
- Tests: GI-CL-14a; G7-3 unit and PostgreSQL tests; six-bot browser spec and fixture extension; G7-2 browser scenarios.
- Operations: scheduler, alerts, runbook entries.
- Documentation: reconciling the 08G-6 status lines (OD-DOC).

None of these changes was made.

## 10. Phase 08G-7A implementation status (2026-10-31)

### 10.1 Owner decisions recorded for 08G-7A

| ID       | Decision                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| OD-G7-3a | **Approved:** production guard on Activate, Resume and Change Version, with account-scoped serialization               |
| OD-G7-3b | **Approved:** the guard also refuses overlapping normalized keywords across concurrently eligible (ACTIVE) deployments |
| OD-G7-3c | **Resolved:** no production bypass; SIX-CL-2's inverted world is written by test-only SQL inside its own test file     |
| OD-G7-1  | **Not accepted as closure.** GI-CL-14a was approved as supplementary evidence; **GI-CL-14 stays OPEN**                 |
| OD-DOC   | **Approved:** reconcile the 08G-6 checkpoint wording to `0bd24b6`                                                      |
| OD-G7-4  | Pending. The read-only inventory is in `PHASE_08G-7_DATA_LIFECYCLE_INVENTORY.md`                                       |

### 10.2 Activation routing guard (G7-3)

- **Rule (pure):** `routingConflicts` in `src/modules/bots/trigger-match.ts`, exported from `@/modules/bots`. Over one
  account's ACTIVE deployments, in ascending priority, it reports two kinds of conflict:
  - `catch_all_first`: a deployment with `first_message` or `referral_source` precedes one with keywords;
  - `shared_keyword`: two deployments have a keyword with equal `triggerKey` (the validator's NFC, trim, lower-case key).

  Catch-alls among themselves are not conflicts.

- **Enforcement points:** `bot-control/deployments.ts`, in the three operations below. Pause, Stop, Emergency Stop and Retire
  only remove deployments from the ACTIVE set and are unchanged.

  | Operation                 | Lock                                                     | Check                    |
  | ------------------------- | -------------------------------------------------------- | ------------------------ |
  | `activateDeployment`      | Routing lock before `lockBot`                            | After the insert         |
  | `resumeDeployment`        | Routing lock via `lockForAdmin(…, true)`, before the bot | After the status update  |
  | `changeDeploymentVersion` | Routing lock via `lockForAdmin(…, true)`, before the bot | After the version update |

  Each check, `assertSupportedRouting`, re-reads the account's ACTIVE set in the same transaction. Pinned versions are validated
  as the runtime does: an invalid version has no triggers. Any conflict throws `ROUTING_CONFLICT` (HTTP 409). The message is
  fixed. The reason lists bot keys only, never keywords, for example `student_enquiry precedes payment_enquiry`. The
  transaction then rolls back, leaving no row, event or audit line.

- **Order of refusals:** the insert runs first, so the existing `DEPLOYMENT_EXISTS` and `PRIORITY_TAKEN` keep their codes.
- **Concurrency:** `pg_advisory_xact_lock(hashtextextended('bot-routing:<org>:<account>', 0))`. The key comes from
  `routingLockKey`, which **lower-cases both UUIDs** (P2 correction after the independent review). The activation schema
  accepts any letter case and PostgreSQL treats the spellings as one UUID, so without it an upper-case activation and a
  lower-case one (or a Resume, which reads the stored lower-case id) took different locks and could commit a conflicting
  ACTIVE set together.
  - **Why advisory:** an activation inserts a row that nobody can lock beforehand, so no existing row lock could serialize it.
  - **Order:** the lock is taken after the authorization locks and before the bot, so the admin order is routing lock → bot →
    deployment.
  - **No deadlock with the runtime:** the runtime never takes this lock, so it does not depend on the K.1 runtime lock order.
  - **Stop, Retire, Emergency Stop:** they do not take it and never wait for it.
  - **Ordering guarantee:** under READ COMMITTED, the second operation's check runs after the first commits, so it sees the
    committed state. A hash collision only serializes two unrelated accounts.
  - **Operational assumption (not enforced by code):** `write()` (`common.ts`) opens a plain `BEGIN` and inherits the
    connection's isolation level; nothing selects READ COMMITTED explicitly. PostgreSQL's default is READ COMMITTED. Under
    REPEATABLE READ or SERIALIZABLE the second check could read a snapshot taken before the first commit (SERIALIZABLE would
    instead abort one of them). The production database and its roles must keep `default_transaction_isolation = 'read
committed'`. The isolated run asserts it on the services' own transaction path. Forcing the level in the wrapper would be
    a separate owner decision; it was not done.
- **Paused deployments:** they are not in the ACTIVE set, so they block nothing. Resuming one into a conflict is refused, and a
  conflicting version can be pinned while paused but cannot be resumed.
- **Unchanged:** eligibility routing, priorities (nothing is reordered), sessions and their version pinning (no session
  column is touched), migrations, operator CLI syntax.
- **Known limits, for the reviewer:**
  - A conflicting ACTIVE set created before the guard existed is not repaired. It blocks the three operations on that account
    until a deployment is paused or retired. No production database exists yet.
  - The rule mirrors the runtime only for ACTIVE deployments. It does not check that a later bot is reachable for first
    messages under some other rule.

### 10.3 Tests

| Test                                                 | Kind                 | State                                  | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | -------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bots/trigger-match.test.ts` "routingConflicts" (5)  | Unit                 | **Passed**                             | Valid order; catch-all first (first_message and referral_source); catch-alls without later keywords; normalized shared keywords (case, spaces, NFC); both kinds in one pair; empty set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `bots/six-bot.test.ts` "production routing rule" (3) | Unit                 | **Passed**                             | Approved six-bot order has no conflict; Student Enquiry first conflicts with all five keyword bots; a version adding another bot's keyword or a `first_message` trigger conflicts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bot-control/routing-guard.db.test.ts` (14)          | PostgreSQL           | **Passed 14/14 (corrected run, 10.7)** | Approved six-bot activation; nonconflicting keyword bots; Student Enquiry before keyword bots, both ways round (atomic: no row, event or audit); shared keyword; existing codes kept; paused deployment resumed into a conflict; version change adding a shared keyword or `first_message`, with the pinned session byte-identical; conflicting version pinned while paused, then resume refused; account and organization isolation (including another organization's 404); two concurrent activations, proved by lock ownership (the second is blocked by the first's backend, then refused; exactly one commits); **P2 regressions:** lower- versus upper-case spellings of one account (the second activation is blocked by the first's backend, then refused; no row, event or audit of it remains; the final ACTIVE set is valid), and an upper-case activation against a Resume in both orders; the READ COMMITTED assertion |
| `bot-control/routing-lock.test.ts` (4)               | Unit                 | **Passed**                             | One key for every letter-case spelling of the organization and account (including the spelling the schema passes through unchanged); distinct pairs keep distinct keys; Activate, Resume and Change Version take the lock through the one helper, before the bot, and all re-check. Mutation-checked: without the lower-casing, 2 of the 4 fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `closed-loop-six-bot.db.test.ts` SIX-CL-2            | PostgreSQL (changed) | **Passed 3/3 selected (10.7)**         | Inverted world written by test-only `insertDeploymentBySql`. Routing characterization unchanged. The third case uses the production rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `closed-loop-general-info.db.test.ts` GI-CL-14a      | PostgreSQL           | **Passed 1/1 selected (10.7)**         | Section 10.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Other PostgreSQL suites that call the three operations were checked by source review. Every multi-deployment case uses an order
the guard accepts:

- CI-CL-2, PE-CL-2, SR-CL-2, RE-CL-1 and GI-CL-2: the keyword bot at 1, Student Enquiry at 2;
- CI-CL-8: CI at 1, GI at 2;
- `step.db.test.ts` case F: the first deployment is PAUSED;
- the `minimalFlow` deployments in `services` / `concurrency`: first_message only, no keywords.

**This review is not a substitute for running those suites.**

### 10.4 GI-CL-14a (supplementary counter evidence)

GI drives 2 + 8 × 3 + 2 + 1 = **29 real sends** through the ordinary closed loop with FakeTransport. That stays under the hourly
cap of 30 BOT requests per conversation. There is no seeded counter, no clock change and no rate-limit history.

**What it observes (correction after the independent review):** it does not inspect each committed processing step. It checks
**19 settled checkpoints**: after the opening keyword and after each of the 18 taps, once `settle()` has quiesced the loop. At
each checkpoint it asserts that `send_count`, `step_seq`, the number of the session's BOT requests (every one ACCEPTED) and the
FakeTransport calls to the student are all equal to the expected running total. The END notice is included in the total.
Ten checkpoints follow two separately committed sends (the opening's welcome and list, and each of the 9 topic taps' answer and BUTTONS); the other nine follow one, so any state between
those two sends is not observed.

**Not established by GI-CL-14a:** reaching the 60-send budget, or the SEND_BUDGET engine-error hand-over through a normal
closed-loop journey. **GI-CL-14 remains OPEN.** The combined evidence for the gap is: step-level ENG (seeded 60) + RE-CL-10 + the
simulator + GI-CL-14a (accumulation up to 29). The step from 29 to 60 is an inference, not an observation.

### 10.5 Verification run in this pass (database-free only)

- Typecheck: passed.
- ESLint (`bots`, `bot-control`, `bot-runtime`): passed.
- Prettier: changed files formatted.
- Unit suite: 2,868 / 2,868 passed in 119 files (was 2,860; +8 new). After the P2 correction: **2,872 / 2,872 in 120 files**
  (+4, `routing-lock.test.ts`); typecheck, full ESLint, full Prettier check and `git diff --check` clean again.
- At the time of this pass, the new and changed PostgreSQL tests (`routing-guard.db.test.ts`, 14 cases; SIX-CL-2; GI-CL-14a)
  were typechecked and linted only. They were run later, under separate owner authorization (section 10.7).
- No PostgreSQL connection, browser, Meta call, worker, migration or retention run in this pass.

### 10.6 Gate status after 08G-7A implementation (superseded for G7-3 by 10.7)

At implementation time every gate was **OPEN**: G7-3 awaited an owner-authorized isolated PostgreSQL run of
`routing-guard.db.test.ts` and the changed SIX-CL-2, and an independent guard review. Both have since happened (section 10.7).
G7-1 needs OD-G7-1 or option (b). Production activation: **NOT AUTHORIZED.**

### 10.7 Phase 08G-7A acceptance (2026-10-31)

**Status: PHASE 08G-7A ACCEPTED BY THE OWNER — ACCEPTANCE DOCUMENTED — OWNER GIT CHECKPOINT PENDING.** The work is uncommitted
on `Bot-Foundation` at HEAD `0bd24b6`.

**Independent review (source review, not test execution).** The first review returned CHANGES REQUIRED: one P2 (an upper- and a
lower-case UUID spelling of one account took different advisory locks) and two P3 documentation findings. These were corrected
in section 10.2 (`routingLockKey`), 10.4 and the data-lifecycle inventory. Focused re-review verdict: **P2 CLOSED — APPROVED FOR
ISOLATED GUARD DATABASE VALIDATION.** The review covered source and documentation. The test results below were reported from
the owner-authorized runs; the reviewer did not execute them.

**Environment and safety.**

- PostgreSQL 17.11 (`server_version_num` 170011), container `al-ict-phase08c-test-pg` (`postgres:17`), port bound to
  `127.0.0.1:55432` only, maintenance database `postgres`.
- The existing disposable harness (`src/db/__tests__/helpers.ts`, `vitest.db.config.mts`, both unchanged from HEAD): each run
  created and dropped its own `al_ict_test_<12hex>` database (no FORCE).
- `TEST_DATABASE_ADMIN_URL` was built in memory and passed only inline to each command; it was never printed or persisted.
  `DATABASE_URL` was unset. No Meta, Graph, WhatsApp or automation variables were present, and the test configuration loads no
  environment files.
- `al_ict_whatsapp` was never connected to (it does not exist on this server).
- Sends used FakeTransport only. No real Meta or WhatsApp request was made: the run logs contain no URLs, and their only
  "MetaTransport" match is the title of a selector-skipped SIX-CL-10 case.
- After every run, including the failed first one: the seven protected scratch databases were present with unchanged names and
  OIDs, no disposable database, `al_ict*` session or Vitest worker remained, and no credential or connection string appeared in
  the output.

| OID      | Protected scratch database |
| -------- | -------------------------- |
| 12374812 | `al_ict_test_270a70c6ec2d` |
| 12365026 | `al_ict_test_38a045daa70d` |
| 9984683  | `al_ict_test_863638504a9b` |
| 3466016  | `al_ict_test_99a775ee2ef5` |
| 3405653  | `al_ict_test_bcd1bc4ed7a6` |
| 3405651  | `al_ict_test_c8ff805d659a` |
| 3466049  | `al_ict_test_f045c40f31fd` |

**Validation history (each command was run once per authorization; there were no automatic retries).**

| Run                  | Target                                                     | Exit | Result                                          |
| -------------------- | ---------------------------------------------------------- | ---- | ----------------------------------------------- |
| First authorization  | `routing-guard.db.test.ts` (whole file)                    | 1    | **13 passed, 1 failed** (sequence stopped)      |
| Second authorization | `routing-guard.db.test.ts` (whole file, corrected fixture) | 0    | **14 passed, 0 failed**                         |
| Second authorization | `closed-loop-six-bot.db.test.ts`, `-t "SIX-CL-2:"`         | 0    | **3 passed**; 33 skipped (excluded by selector) |
| Second authorization | `closed-loop-general-info.db.test.ts`, `-t "GI-CL-14a"`    | 0    | **1 passed**; 24 skipped (excluded by selector) |

The skipped cases were excluded by the name selector; they are neither passes nor failures.

**First run's failure.** The case "a keyword shared (after normalization) with an active deployment is refused" built a version
with the keyword `"  FAQ "`. Publishing refused it (`FLOW_INVALID` / `TEXT_UNTRIMMED` at `triggers[0].words[1]`), so the test
never reached activation or the routing guard. That was a wrong test assumption: publish validation already rejects keywords with
surrounding spaces. With owner approval, the fixture alone was changed to `"FAQ"`. Against General Information's `faq`, the
collision is now case-only. Database-free, both fixtures validate and the production rule reports
`payment_enquiry shares a keyword with general_info`. No production code, assertion or title changed.

**Routing guard (14/14, corrected run).**

- The corrected shared-keyword case reaches activation and is refused with `ROUTING_CONFLICT` (reason
  `payment_enquiry shares a keyword with general_info`). The snapshot is unchanged and the General Information deployment stays
  ACTIVE.
- All four concurrent cases passed: two activations that conflict only together; a lower- against an upper-case spelling of one
  account; a Resume holding the lock against an upper-case activation; and an upper-case activation holding the lock against a
  Resume. In each case:
  - the equivalent spellings took the same routing lock;
  - PostgreSQL's `pg_blocking_pids` showed the second backend blocked by the first transaction's backend (no sleeps);
  - after the first committed, the second re-read the ACTIVE set and was refused with `ROUTING_CONFLICT`;
  - exactly one conflicting operation took effect;
  - no rejected deployment, event or audit row remained (a refused Resume left its deployment PAUSED);
  - the final ACTIVE set passed the production rule.
- Atomic refusal held for Student Enquiry ahead of a keyword bot in both directions, a resume into a conflict, and a conflicting
  version change, whose pinned session stayed byte-identical. `DEPLOYMENT_EXISTS` and `PRIORITY_TAKEN` keep their codes.
- Organization and account isolation passed.
- `current_setting('transaction_isolation')` inside a transaction opened by the services' database object, and
  `default_transaction_isolation`, were both `read committed`. This applies to the isolated test server only, not to a
  production connection.

**SIX-CL-2 (3/3 selected).** All three cases passed: the first-message fallback applies only to the first eligible message; with
inverted priorities (Student Enquiry 1), every keyword starts Student Enquiry; and the production rule flags the inverted set as
unsuitable and accepts the approved one. The inverted world exists only through test-only `insertDeploymentBySql` inside the
disposable database. There is no production bypass: the normal deployment path (Activate, Resume, Change Version) enforces the
guard, as `routing-guard.db.test.ts` shows. The changed SIX-CL-2 is now validated. The earlier 08G-6 36/36 run remains unchanged
historical evidence of the file as committed in `0bd24b6`.

**GI-CL-14a (1/1 selected).** The run had 29 BOT sends and 19 settled checkpoints. At every checkpoint, `send_count`,
`step_seq`, the session's ACCEPTED BOT requests and the FakeTransport calls agreed with the running total. The session ended
COMPLETED with no ERROR events. Ten checkpoints follow two separately committed sends, and no assertion was made about the state
between those paired sends. The run used no clock, counter or rate-limit manipulation. **GI-CL-14 remains OPEN:** the
closed-loop 60-send `engine_error` termination was not demonstrated.

**Gate status after 08G-7A acceptance.**

G7-3 is **IMPLEMENTED — INDEPENDENTLY REVIEWED — ISOLATED POSTGRESQL VALIDATION PASSED.** It does not authorize activation.
These operational conditions remain:

1. Verify `READ COMMITTED` on the actual deployment-service database connection before activation. The wrapper inherits the
   connection's level; forcing the level in code would be a separate owner decision.
2. Confirm the intended ACTIVE deployment configuration (approved order, keywords, versions) before activation.
3. The guard does not repair an invalid pre-existing ACTIVE set; it only refuses new conflicting operations on that account.
4. Production activation approval remains a separate, explicit owner decision.

Still OPEN:

- G7-1 / GI-CL-14 (closed-loop SEND_BUDGET evidence; OD-G7-1);
- G7-2 (inbox timestamp ordering, browser check);
- G7-4 (message retention policy; no retention periods set);
- G7-5 (retention scheduling and operations);
- G7-6 (real bot content and business data);
- G7-7 (integrated browser E2E);
- G7-8 (real Meta integration);
- **SE-2** (Student Enquiry collects name and grade before consent; `PHASE_08G-7_DATA_LIFECYCLE_INVENTORY.md`, section 1).

No raw-webhook, message, outbound-request, log or backup retention is implemented. Phase 08G-7 and production readiness are
**not** complete. Production activation: **NOT AUTHORIZED.**
