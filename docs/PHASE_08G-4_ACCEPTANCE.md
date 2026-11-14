# Phase 08G-4 definition and acceptance draft (Staff Routing golden flow)

Status: **INDEPENDENT REVIEW: APPROVED FOR ISOLATED CLOSED-LOOP TEST IMPLEMENTATION (no blocking P1/P2).** TEST-ONLY, SYNTHETIC. Owner Git checkpoint: **COMMITTED (`506e664` on `origin/Bot-Foundation`; reconciled from Git history in Phase 08G-6)**. Production activation: **NOT AUTHORIZED**. PostgreSQL status: **PASSED on the isolated server (second run: 25 of 25, exit 0, about 5 s)**. First run: 25 executed, 20 passed, 5 failed, all in SR-CL-4 (the test asserted a causal order the Inbox does not guarantee); database safety and cleanup passed on both runs. Staff-scoped persistence and retrieval via `listMessages()` is proven by SR-CL-4; browser rendering and real WhatsApp delivery are NOT verified (future integrated Phase 08G obligation). GI-CL-14 remains an outstanding integrated-acceptance obligation (not reopened here).

## 1. Implemented flow

- `staffRoutingFlow()` in `src/modules/bots/testing.ts`; tests in `src/modules/bots/staff-routing.test.ts`. No production runtime, schema or migration changed.
- Keywords `staff`, `agent`, `human` (keyword only, no `first_message`). Settings: idle 30 minutes, 2 invalid attempts. No variables.
- `welcome` (MESSAGE) → `reason_menu` (LIST, five rows) → one HANDOVER per row. `invalid_to_staff` and `error_to_staff` are General Information's own nodes (a test pins them equal).
- Content is SYNTHETIC TEST (name says so). It must never be published.

## 2. Approved decisions

- **D-12**: categories are generic, not departments. No department, staff name, availability, hours or response time is stated.
- **D-13**: the category reaches staff only through the bot's handover wording and the student's own selection reply (limitation L6: six fixed reason codes, no category code; the Inbox bot panel shows no variables). Alternative (new reason codes) is a contract change and not proposed.

## 3. Category mapping

| Row key     | Title                 | Node          | Reason code         | Handover text (after "Thank you. I've passed your ")                                 |
| ----------- | --------------------- | ------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `classes`   | Class question        | `h_classes`   | `student_requested` | class question to our staff. Please wait here for their reply. I can't say how soon. |
| `payment`   | Payment question      | `h_payment`   | `student_requested` | payment question …                                                                   |
| `register`  | Registration          | `h_register`  | `student_requested` | registration question …                                                              |
| `technical` | Problem joining class | `h_technical` | `student_requested` | problem joining class …                                                              |
| `other`     | Something else        | `h_other`     | `other`             | other question …                                                                     |

Two invalid replies → `invalid_input`. Configured error node → `error_fallback`. Internal engine error → `engine_error`, no send (shared contract, covered by the Payment suite).

## 4. Staff timeline visibility

The handover notice is a terminal-notice BOT message persisted in the conversation, and the student's list selection is an inbound message. Staff identify the category from these two. The reviewer's nonblocking P3 is resolved: the `other` notice now reads "I've passed your other question to our staff. Please wait here for their reply. I can't say how soon.", so all five categories are identifiable from the notice alone (the golden test asserts it). Reason `other` and the list option "Something else" are unchanged. Not claimed: that a department was chosen, a staff member assigned, a reply time, or any payment or registration processed. Persisted-timeline evidence is SR-CL-4 (passed on the second PostgreSQL run; see section 7).

## 5. SR-CL scenarios (implemented; PostgreSQL validation passed 25/25 on the second run, see the status line and section 7)

File: `src/modules/bot-runtime/closed-loop-staff-routing.db.test.ts` (reuses `staffRoutingFlow()` and the shared `closedLoopKit`; no new infrastructure). 25 test cases.

| ID      | Cases | Definition and expected persisted assertions                                                                                                                                                                                                                                                                                               |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SR-CL-1 | 5     | Per category: welcome, list, one notice (3 sends, steps 1-3, idempotency keys, ACCEPTED, one attempt); `HANDED_OVER`, `flow_handover`, reason `student_requested` (x4) / `other`; org, bot, deployment, pinned version; terminal notice step 3; fifth notice contains "your other question".                                               |
| SR-CL-2 | 9     | Keywords `staff`, `  AGENT  `, `Human` start the pinned version (3); `staffing`, `human please`, `pay`, `class`, `info` give `no_trigger_match` with zero session/request/call (5); with Student Enquiry deployed (Staff priority 1): `staff` selects Staff Routing, a plain first message selects Student Enquiry (1, separate students). |
| SR-CL-3 | 2     | One invalid reply re-prompts with a different token taken from the captured payload, the new token is accepted; two invalid replies give `invalid_input`.                                                                                                                                                                                  |
| SR-CL-4 | 5     | Per category: real `listMessages()` under the real staff `AccessContext` returns 5 messages oldest first; the student selection (INTERACTIVE, text = category title) and the category-specific TEXT notice; rows match organization, conversation and WhatsApp account.                                                                    |
| SR-CL-5 | 1     | After handover, `staff`, `human`, `agent` are `IGNORED` with `handover_unresolved`; no session, bot request or transport call; original session and events unchanged.                                                                                                                                                                      |
| SR-CL-6 | 1     | Waiting at the list: `reconcileSession` at `expires_at - 1ms` is `not_due`; at `expires_at` it is `COMPLETED` / `idle_timeout`; no extra request, event, notice or call. Verifies the reconciliation decision only, not SQL sweep candidate discovery.                                                                                     |
| SR-CL-7 | 1     | `variables = {}`; only two inbound rows; zero `leads`, `lead_attributions`, `contact_tags`; conversation `assigned_membership_id` and `assigned_at` NULL, status `OPEN`; no assignee in `conversation_events`. No payment or registration table exists in the schema.                                                                      |
| SR-CL-8 | 1     | Session, all three requests and all conversation messages carry the expected organization, conversation, account; session carries bot, deployment, pinned version. No new control test: Staff Routing adds no control path.                                                                                                                |

Per-ID totals: 5 + 9 (3 + 5 + 1) + 2 + 5 + 1 + 1 + 1 + 1 = 25.

### Staff timeline retrieval boundary (SR-CL-4)

Proves: the persisted inbound selection and the persisted outbound notice are returned by the real `listMessages()` for the staff `AccessContext` (`conversation.read` asserted inside it), scoped by organization, conversation and account, with a delivery view from the real outbound request. Does not prove: browser rendering, WhatsApp delivery (the notice was accepted by the FAKE transport), or cross-tenant refusal (Inbox suites).

SR-CL-4 correction: the first run failed all five SR-CL-4 cases because the test asserted a causal order (keyword, welcome, list, selection, notice) that the Inbox does not guarantee. Inbound messages carry the provider's whole-second timestamp, bot messages the server's millisecond enqueue time, and `listMessages()` orders by `occurred_at` (then id) only, so a reply in the same second as its prompt can sort before it. The test now finds each message by direction, type and content (exactly one each), asserts five distinct persisted messages and exactly five rows in the conversation, and asserts only that the returned `occurredAt` values are non-decreasing. It no longer waits and no longer asserts causal order.

The ordering behaviour is recorded as a **separate P3 Inbox issue** (`docs/PHASE_08G-4_INBOX_ORDERING_ISSUE_DRAFT.md`, for the owner to record in the tracker). It is not resolved and not formally accepted as a production limitation. Browser verification of the timeline remains a future integrated Phase 08G obligation.

### Shared regression dependencies (referenced, not repeated)

Staff takeover and suppression: `closed-loop.db.test.ts` H1/H2, `staff-takeover-suppression`, `staff-before-start`, `staff-concurrency`. Stop and Pause: `stop-boundary`, `pause-drain`. Tenant isolation, version pinning, live-send and outbound gates (`gates`), retention redaction, duplicate webhooks and worker recovery: the Student enquiry and General Information closed-loop suites. Engine-error termination: Payment Enquiry suite (the configured `error_fallback` HANDOVER node is distinct from an internal `engine_error` termination).

## 6. Remaining limitations

L4 no bot-to-bot jump, 30-minute cooldown, 3 sessions per 24 h. L6 no category reason code. L7 no staff-visible structured fields. `other` carries no category beyond "question". SEND_BUDGET is unreachable here (no cycle), so engine_error is not re-exercised. Final-read race (one send can slip after takeover) unchanged.

## 7. Verification state

Database-free: see the report. PostgreSQL: **PASSED on the isolated server** — first run 25 executed, 20 passed, 5 failed (all SR-CL-4, an unsupported causal-order assertion; see the SR-CL-4 correction above); second run after that test correction 25/25 passed, exit 0, about 5 s. Database safety and cleanup passed on both runs. (Reconciled in Phase 08G-6 from the status line; this section previously still read "NOT RUN".) GI-CL-14 (PostgreSQL engine-error evidence) outstanding for integrated Phase 08G acceptance.
