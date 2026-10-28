# Phase 08G-2 acceptance (Class Information golden flow)

Status: **DATABASE VALIDATION PASSED — OWNER GIT CHECKPOINT PENDING.** The database-free work is verified and the isolated PostgreSQL closed-loop run passed (section 5). The owner Git checkpoint (commit) has not happened, so 08G-2 is not closed. This document authorizes no further database run, deployment, worker, Meta call, live send or production activation.

## 1. Review and scope

- Independent review approved the Class Information golden flow, its 28 database-free tests and the closed-loop plan CI-CL-1 to CI-CL-8 (with the assertion refinements below).
- Definition: section 6 of `~/Desktop/PHASE_08G-0_SIX_BOT_DEFINITIONS.md` (outside the repository); decisions D-1 to D-18 approved as defaults (`PHASE_08G-1_APPROVAL_ADDENDUM.md`).
- Flow: `classInfoFlow()` in `src/modules/bots/testing.ts`. Keywords `classes`, `class`. `welcome` → `class_list` → `cls_c1..c3` → `more` ("Another class" → `class_list`, "Talk to staff" → `to_staff`, "That's all" → `bye`). "Class not listed" → `needs_staff`. The handover, error and END nodes are General Information's own (a test pins them equal).
- No production runtime, schema, migration (0000 to 0009) or bot behavior changed.

## 2. Content status: SYNTHETIC ONLY

Every class is `[TEST] Class one/two/three` with "example … (test only)" lines and "This is not a real class." No fee, teacher, venue, schedule or link exists anywhere in the flow. It must never be published. Database-free tests assert the absence of links, prices, fee words, joining platforms, teacher words and enrolment claims.

## 3. PostgreSQL closed-loop tests (`src/modules/bot-runtime/closed-loop-class-info.db.test.ts`): 14 tests

Real signed webhook → ingest → webhook worker → bot worker → dispatcher → **FakeTransport**, through the shared `closedLoopKit`, on fresh generated `al_ict_test_*` databases only. Prompt tokens are read from captured FakeTransport payloads; none is fabricated.

| ID      | Scenario                                                         | Expected database assertions                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CI-CL-1 | `classes` → class one → Another class → class three → That's all | Exactly 8 sends in order: welcome, class list, class-one details, more, class list (fresh token), class-three details, more, END. Request step_seq 1..8, idempotency `bot-<session>-<n>`, all BOT/ACCEPTED/attempt 1, wamids match. Session bound to its organization, bot, pinned version and deployment: COMPLETED, `flow_end`, `terminal_notice_step_seq = 8`, 4 INPUT_ACCEPTED events. |
| CI-CL-2 | Keywords and precedence                                          | `class`, `  CLASSES  `, `Class` start it (whole-message, NFC, trim, case-insensitive). With only Class deployed, `info` and `faq` are IGNORED `no_trigger_match` (0 sessions, requests, calls). With Student Enquiry at priority 2, `classes` starts Class on its pinned version and a plain first message (separate fresh student) starts Student Enquiry.                                |
| CI-CL-3 | Class not listed                                                 | HANDED_OVER, `flow_handover`, `needs_staff`, notice at step 3, events INPUT_ACCEPTED + HANDED_OVER, exactly one notice text.                                                                                                                                                                                                                                                               |
| CI-CL-4 | Talk to staff, from the list and from More Options               | Both `student_requested`, notice at step 3 and step 5, correct transcript.                                                                                                                                                                                                                                                                                                                 |
| CI-CL-5 | Invalid input                                                    | One invalid reply re-sends the same list with a different token; tapping it is accepted (`invalid_attempts` back to 0). Two invalid replies: `invalid_input` handover with the notice, no second re-prompt.                                                                                                                                                                                |
| CI-CL-6 | Another class; keyword `class` at a waiting list                 | Another class returns to `class_list`. Typed `class` is `wrong_kind` (INPUT_REJECTED), `invalid_attempts` 1, same session id, one session, same bot; the next tap is accepted on that session.                                                                                                                                                                                             |
| CI-CL-7 | Idle expiry                                                      | `reconcileSession` with fixed decision clocks: `not_due` at `expires_at - 1 ms`; at `expires_at` COMPLETED `idle_timeout`, `output_suppressed_at` set, no notice, no new BOT request, no transport call, no events. **This proves the reconciliation decision. It is not SQL sweep candidate discovery** (the candidate query filters on the real `clock_timestamp()`).                    |
| CI-CL-8 | Coexistence and cooldown                                         | With General Information at priority 2: a live Class session receiving `info` is `input_rejected` and never switches bots. After END, `classes` and `info` inside the 30-minute cooldown are IGNORED `cooldown`; counts of sessions, BOT requests and transport calls are unchanged.                                                                                                       |

## 4. Shared regression evidence reused (not duplicated)

Staff takeover and both suppression orderings (H1 to H4, GI-CL-8a/8b), operator Stop and deployment Pause (H3, GI-CL-9), organization isolation (GI-CL-10), version pinning (GI-CL-11), automation gates and live-send HELD (GI-CL-12, `gates.db.test.ts`), redaction (GI-CL-13), duplicate webhooks and worker recovery (A to F), trigger and control-sequence ordering. Validated on PostgreSQL 17 for 08G-1 (49/49). These controls are not re-proven for Class Information; they rely on that existing evidence. Class-specific smoke checks beyond the eight scenarios are not added.

## 5. PostgreSQL validation result (owner-authorized, one run, no retries)

| Item        | Result                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command     | `npx vitest run --config vitest.db.config.mts src/modules/bot-runtime/closed-loop-class-info.db.test.ts`                                                                                                   |
| Totals      | 1 file, **14 passed, 0 failed, 0 skipped**; first run; 3.4 s (the earlier "16 cases" was a miscount: 1 + 6 + 1 + 1 + 2 + 1 + 1 + 1 = 14)                                                                   |
| Environment | PostgreSQL 17.11 (`server_version_num` 170011) in isolated container `al-ict-phase08c-test-pg`, `127.0.0.1:55432`, maintenance database `postgres`; fresh harness-generated `al_ict_test_*` databases only |
| Safety      | `DATABASE_URL` and all bot, outbound, live-send, Meta and Graph variables unset; admin URL built in memory only; the permanent `al_ict_whatsapp` database was never touched                                |
| Transport   | FakeTransport only; no Meta call, no real WhatsApp send, no browser test, no worker                                                                                                                        |
| Cleanup     | Every disposable database removed; the 7 protected scratch databases kept their original names and OIDs; no remaining database sessions, test processes or workers                                         |
| Changes     | No production runtime, schema or migration change; no Git state change by the run                                                                                                                          |

| ID      | Tests | Result                                                                                                                                                                                                                                                                                                                          |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-CL-1 | 1     | **Passed.** Eight ordered sends with the correct details for two different classes (one and three), fresh tokens, session pinned to its organization, bot, version and deployment, one terminal notice, COMPLETED / `flow_end`.                                                                                                 |
| CI-CL-2 | 6     | **Passed.** `class`, `  CLASSES  ` and `Class` start the bot. `info` and `faq` start nothing: persisted `IGNORED` / `no_trigger_match`, 0 sessions, requests and calls. With Student Enquiry deployed at priority 2, `classes` starts Class Information on its pinned version and a plain first message starts Student Enquiry. |
| CI-CL-3 | 1     | **Passed.** "Class not listed": HANDED_OVER, `flow_handover`, `needs_staff`, one notice (step 3).                                                                                                                                                                                                                               |
| CI-CL-4 | 1     | **Passed.** "Talk to staff" from the class list (notice step 3) and from More Options (notice step 5): `student_requested`.                                                                                                                                                                                                     |
| CI-CL-5 | 2     | **Passed.** The re-prompt token differs and is accepted; two invalid replies hand over as `invalid_input` with no second re-prompt.                                                                                                                                                                                             |
| CI-CL-6 | 1     | **Passed.** "Another class" returns to the class list; typed `class` is `wrong_kind`, `invalid_attempts` 1, same session, no second bot; the next tap is accepted.                                                                                                                                                              |
| CI-CL-7 | 1     | **Passed.** `not_due` at `expires_at - 1 ms`; COMPLETED / `idle_timeout` at `expires_at`; no new outbound request, notice or transport call. **This proves idle reconciliation at the deadline (`reconcileSession` with a fixed decision clock). It is not SQL sweep candidate discovery.**                                     |
| CI-CL-8 | 1     | **Passed.** With General Information deployed, `info` during a live Class session does not switch bots; after END, `classes` and `info` inside the 30-minute cooldown are ignored (`cooldown`) with no new session, request or call.                                                                                            |

## 6. Status

| Item                                              | State                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Class Information flow and 28 database-free tests | Verified (unit suite)                                                                                               |
| CI-CL-1 to CI-CL-8 (14 tests)                     | **PostgreSQL validation passed**                                                                                    |
| Milestone                                         | **DATABASE VALIDATION PASSED — OWNER GIT CHECKPOINT PENDING**                                                       |
| Owner Git checkpoint                              | **Pending** (nothing committed)                                                                                     |
| GI-CL-14 (SEND_BUDGET integrated evidence)        | **Still pending PostgreSQL evidence**; not passed. The engine-error contract is covered only by the simulator tests |
| Content                                           | Synthetic, test-only; real class data unapproved                                                                    |
| Production publication and activation             | **Not authorized**                                                                                                  |

## 7. Outstanding owner business data

Real class names (up to 8) with approved schedule, format, venue or https joining link; whether to show a teacher, fees or a "last updated" date (D-6); whether a joining link may be sent to anyone who sends the keyword (D-7); which classes to list (D-8); language (D-3).

None of this is approved for publication: the Class Information definition in the repository is synthetic and must not be published.
