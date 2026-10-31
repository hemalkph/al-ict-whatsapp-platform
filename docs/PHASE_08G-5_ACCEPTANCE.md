# Phase 08G-5 — New Registration Enquiry golden flow (acceptance)

Status: **POSTGRESQL VALIDATION PASSED — OWNER GIT CHECKPOINT COMMITTED (`b4f2df6` on `origin/Bot-Foundation`; reconciled from
Git history in Phase 08G-6).** Production activation: **NOT AUTHORIZED.**

Evidence layers: the implementation (flow, `rejectLinks` contract and boundary, tests) was **independently reviewed** (name-
validation P2 CLOSED). The PostgreSQL execution in section 5.2 is **developer-reported** run evidence, accepted by the owner.
No browser rendering or real WhatsApp delivery is claimed.

Synthetic, test-only fixture (`registrationEnquiryFlow()` in `src/modules/bots/testing.ts`). It is an enquiry note for staff,
not a working enrolment feature: nothing is registered, enrolled, charged or created (V3.2 exclusion C.9).

## 1. Flow and transitions

Keywords `register`, `registration`, `join`. Idle timeout 30 min. Max invalid attempts 2.

| From                                                       | Input                        | To                                                    |
| ---------------------------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| `welcome`                                                  | automatic                    | `consent`                                             |
| `consent` (BUTTONS)                                        | Continue                     | `ask_name`                                            |
| `consent`                                                  | Cancel                       | `cancelled` (END, COMPLETED)                          |
| `ask_name` (QUESTION text 2–80, `rejectLinks`, `reg_name`) | valid name                   | `ask_year`                                            |
| `ask_name`                                                 | too short/long, or link-like | same prompt; 2nd → `invalid_to_staff`; nothing stored |
| `ask_year` (integer 2101–2103, `al_year`)                  | valid                        | `ask_class`                                           |
| `ask_class` (LIST)                                         | `[TEST]` class 1–3           | `set_c1..3` (SET_VARIABLE `class_pref`) → `confirm`   |
| `ask_class`                                                | Talk to staff                | `to_staff` (`student_requested`)                      |
| `confirm` (BUTTONS, renders name/year/class)               | Yes, hand over               | `to_review` (HANDOVER `needs_staff`)                  |
| `confirm`                                                  | Change answers               | `ask_name`                                            |
| `confirm`                                                  | Cancel                       | `cancelled`                                           |
| any input step                                             | invalid ×2                   | `invalid_to_staff` (`invalid_input`)                  |
| any input step                                             | idle 30 min                  | silent COMPLETED (`idle_timeout`), no send            |
| render failure                                             | engine                       | HANDED_OVER `engine_error`, no notice, no send        |

`error_to_staff` (`error_fallback`) is on no transition. `engine_error` is the runtime's own reason; they stay distinct.

## 2. Name validation (runtime contract change)

`answer: {kind: "text", min, max, rejectLinks: true}`, enabled only on `ask_name`.

- **Opt-in and backward compatible.** Absent or `false` = no change. `false` is dropped from the normalized configuration, so
  every existing flow and published version keeps the same canonical form and hash. Allowed on text answers only
  (`ANSWER_FIELD_NOT_ALLOWED` otherwise). No pattern is author-supplied; no schema or migration change.
- **Enforced before mutation.** `parseAnswer()` returns undefined, so the existing invalid-answer path runs: no assignment to
  `reg_name`, no advance, the prompt is re-sent, a valid name then continues, two invalid → `invalid_input`. On Change answers a
  rejected replacement leaves the earlier name untouched. The engine's invalid reason carries no value; the rejected text is never
  placed in a bot message.
- **Boundary (`looksLikeLink` in `urls.ts`; checked on an NFKC copy with fullwidth/ideographic full stops folded; the stored
  value is not changed; no DNS or network lookup):**
  1. any `scheme://`, or a bare scheme (`javascript:`, `mailto:`, `http:`, `https:`, `ftp:` …);
  2. `www.`; an email shape; a dotted IPv4;
  3. a hostname shape: two or more dot-separated labels (letters, digits, marks, hyphens, any script). Followed by `/`, `?`, `#`
     or `:port` it is always refused. Otherwise it is refused when the last label is 2+ letters — **any suffix, no list** — unless
     the initials exception applies.
- **Suffixes:** the last label counts when it is 2+ letters in any script (any standard domain-shaped suffix, no list) or a
  punycode ASCII IDN label (`xn--…`, any case), so `xn--fsqu00a.xn--fiqs8s` is refused like its Unicode form `例子.中国`.
- **Initials exception (intentional data-quality trade-off):** **two or more** labels before the last, each one initial (an
  uppercase letter, or one Sinhala/Tamil syllable of ≤3 code points), and the last label name-cased (uppercase then
  lowercase, or Sinhala/Tamil). So `K.M.Silva`, `K.M.Dev`, `A.B.De`, `A.B. Perera` and Sinhala/Tamil multi-initial names
  pass, while two-label name-cased shapes (`T.Co`, `X.Com`) get no exception and are refused. A path, port or scheme beats the
  exception (`K.M.Silva/x` is refused).
- **Ambiguities accepted:** multi-initial shapes are accepted even when they could be a hostname (`A.B.Com`). A single joined
  initial (`K.Perera`) and joined words (`Dr.Nimal`, `Nimal.Perera`, `St.John`) are refused and re-prompted; the spaced
  forms (`K. Perera`, `Dr. Nimal`) pass.
- **Known limits, not claimed:** spaced or bracketed dots (`example dot org`, `example [.] org`) and other deliberate obfuscation
  are not recognised. This is field-specific data-quality validation, not a comprehensive security boundary.
- The renderer, dispatcher, handover, retention and `engine_error` contracts are unchanged. The inbound reply itself is
  already in conversation history; the validator deletes nothing and implies nothing was deleted.

## 3. Approved product decisions

D-14 name, A/L year, class interest only. D-15 retention of the confirmation follows existing conversation retention (owner to
state). D-16 allowed years pending: fixture uses 2101–2103. Approved cancellation wording: "Your registration enquiry has been
cancelled. No registration has been completed."

## 4. Privacy, visibility and retention (corrected)

- The confirmation is a **consolidated, staff-readable summary**, not the only readable record: staff can also read each student
  reply, including unsolicited messages sent before consent.
- The confirmation message is **persisted when it is queued (enqueue), before transport acceptance and before "Yes, hand
  over"**. That button requests staff handover; it does not control whether staff can already read the summary. Persistence
  and staff-scoped `listMessages()` retrieval are verified on PostgreSQL (RE-CL-5); browser rendering is unverified.
- Cancel does not delete earlier inbound or outbound messages. At consent and confirm only; at free-text steps the student can
  only stop replying and idle timeout applies.
- Collected variables are sensitive and are cleared by the separate terminal-session redaction after the database-controlled
  period; that leaves messages (replies, confirmations, earlier summaries) untouched. Conversation-message retention is
  unresolved owner policy.
- Retention execution is **operator-invoked** (CLI, dry-run by default). A configured period does not establish a schedule.
- **Confirmation copy (owner-approved, applied):** "Would you like to hand this enquiry over to our staff for review?" with
  button "Yes, hand over" (14 characters). It describes handover only: no assignment or response-time claim.
- The claim scanner (`registrationClaimViolations`) is a test-only heuristic: it rejects affirmative statements such as "Your
  registration is complete" and allows negated wording. It is not a general language-policy validator (for example it misses
  "Registration complete.").

## 5. PostgreSQL closed-loop cases (IMPLEMENTED, PASSED on isolated PostgreSQL)

Reuse the 08G-4 harness and shared runtime evidence; do not repeat the generic runtime suite.

| ID       | Case                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RE-CL-1  | The three keywords start the flow; trigger precedence and cooldown as for the other bots.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| RE-CL-2  | After start and before Continue, session variables are empty (assert variables, not absence of inbound messages).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| RE-CL-3  | Cancel at consent and at confirm persist COMPLETED with the approved text; no handover, no lead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| RE-CL-4  | Name/year/class persist as `reg_name`/`al_year`/`class_pref`; read back the pinned published configuration and verify all three `sensitive: true` and `ask_name` `rejectLinks: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| RE-CL-5  | The confirmation ("…Would you like to hand this enquiry over to our staff for review?") is persisted at enqueue with substituted values, before transport acceptance and before any button; a staff-scoped `listMessages` returns it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| RE-CL-6  | Change answers overwrites all three; staff-scoped retrieval returns the new summary, and the earlier summary and replies remain (distinguish them by position/content).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| RE-CL-7  | Yes, hand over persists HANDED_OVER `needs_staff` with one non-claiming terminal notice; class-list "Talk to staff" persists `student_requested` and no summary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| RE-CL-8  | Invalid ×2 at each step persists `invalid_input`; one invalid then valid continues.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| RE-CL-9  | Idle expiry at each step persists a silent COMPLETED.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| RE-CL-10 | Link-like names at `ask_name`, initial and Change-answers paths, including ordinary unlisted suffixes (`example.school`, `example.school/enrol`, `example.nz`, `例子.中国`), two-label name-cased domains (`T.Co`, `X.Com`), punycode IDNs (`xn--fsqu00a.xn--fiqs8s`, upper-case form) and recognised forms; plus a multi-initial name (`K.M.Dev`) accepted: re-prompt, no `reg_name` stored or overwritten, no transition to the year, no bot message containing the value, valid retry continues, two → `invalid_input`. The rejected inbound message itself stays in history. Separate shared renderer-error regression: a render failure persists `engine_error` with no additional outbound row from the failing step. |
| RE-CL-11 | Retention redaction clears populated variables and tokens; lifecycle fields and message history unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| RE-CL-12 | Snapshot the conversation's actual lead rows, contact tags and assignee before and after each path; assert no change made by the bot. Legitimate BOT outbound requests are expected and are not prohibited records. No payment table is assumed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 5.1 Implementation (`src/modules/bot-runtime/closed-loop-registration-enquiry.db.test.ts`, 53 cases)

Real closed loop (`closedLoopKit`: signed webhook → ingest → webhook worker → bot worker → dispatcher → FakeTransport) on a
fresh harness database only. Interactive taps reuse the real option ids and prompt wamids captured from FakeTransport.

| ID       | Cases | What is asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RE-CL-1  | 10    | 4 keyword forms (case/space) start the pinned version and deployment; 5 near-misses are `no_trigger_match` with no session, request or call; with Student Enquiry (`first_message`, priority 2) deployed, `join` starts Registration and a plain message starts Student Enquiry (fresh students).                                                                                                                                                                                                                                                                                                                                                                                     |
| RE-CL-2  | 1     | Before Continue: only welcome + consent sent, consent payload exact, no question asked, `variables = {}` (the trigger message is persisted and stays); Continue → `ask_name`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| RE-CL-3  | 2     | Cancel at consent: COMPLETED `flow_end`, approved notice, no variables, all 5 messages kept. Cancel at confirm: COMPLETED, variables still populated until redaction, summary still stored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| RE-CL-4  | 2     | Full collection: six exact payloads in order, fresh token per prompt, six BOT requests, exactly three variables, no other question. Pinned version: `sensitive: true` ×3 and `ask_name.answer.rejectLinks: true` in the stored jsonb; canonical text = canonical form of the jsonb and of the fixture, revalidates to itself, SHA-256 matches; the runtime then refuses `example.school` on that version.                                                                                                                                                                                                                                                                             |
| RE-CL-5  | 1     | Before any button: the summary is a BOT OUTBOUND INTERACTIVE message at step 6 with its request (enqueue), exact rendered body, organization/conversation/account/wamid; real staff-scoped `listMessages` returns it with every line and the button titles; the individual replies are listed too.                                                                                                                                                                                                                                                                                                                                                                                    |
| RE-CL-6  | 1     | Change answers replaces all three values; both summaries remain stored and both are returned to staff; earlier replies remain; no lead or attribution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| RE-CL-7  | 2     | Yes, hand over → HANDED_OVER `needs_staff`, notice exact and claim-free, 7 requests. Class-list Talk to staff → `student_requested`, 6 requests, no summary. No assignee in either.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| RE-CL-8  | 8     | One invalid (short name, year words, year out of range, typed class) → same prompt again, `invalid_attempts = 1`, variables unchanged, `INPUT_REJECTED` code, valid recovery. Two invalid (long name, year range/decimal, class, typed confirm) → `invalid_input` with the shared notice, variables unchanged.                                                                                                                                                                                                                                                                                                                                                                        |
| RE-CL-9  | 2     | At `ask_name` and at `confirm`: decision-clock reconciliation not due 1 ms before `expires_at`, COMPLETED `idle_timeout` at it, no request, call or event; variables kept until redaction. Reconciler decision only, not sweep candidate discovery.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| RE-CL-10 | 19    | 11 link-like names (5 original bypasses, `T.Co`, `X.Com`, punycode and its upper case, an https URL, an embedded URL): stay at `ask_name`, `variables = {}`, question re-sent, no year question, `INPUT_REJECTED answer_invalid`, not reflected in any provider payload or stored OUTBOUND message (the student's inbound message is expected to remain), valid recovery. `K.M.Dev` accepted. 2 exhaustion pairs → `invalid_input`. 4 Change-answers cases keep the earlier name and reconfirm. Shared renderer-error regression (test-only variant without `rejectLinks`): HANDED_OVER `engine_error`, no additional request or call from the failing step, `ERROR render_rejected`. |
| RE-CL-11 | 1     | Terminal session with populated variables and a consumed token: not redacted under the 30-day period; with the period shortened in this database only, cleared variables/awaiting/tokens; every other session column, all 13 messages and all events unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| RE-CL-12 | 4     | Hand over, Talk to staff, Cancel, invalid_input: scoped before/after counts of `leads`, `lead_attributions`, `contact_tags` unchanged; assignee null before and after; no assignment event; every request is the session's own BOT TEXT/INTERACTIVE send.                                                                                                                                                                                                                                                                                                                                                                                                                             |

Shared evidence reused, not repeated: tenant isolation, Stop/Pause, staff takeover, version pinning, outbound/live-send gates,
duplicate webhooks and worker recovery (Student enquiry, General Information and Payment suites).

**Assumptions confirmed by the run:** the render-failure step records `INPUT_ACCEPTED` beside `ERROR render_rejected` and
`HANDED_OVER engine_error`; `invalid_attempts` resets on a valid answer; ingest stores the student's text unmodified (including
`例子.中国`); the staff timeline text of an interactive message contains each body line.

### 5.2 Execution evidence (developer-reported, owner-accepted)

| Item      | Result                                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command   | `npx vitest run --config vitest.db.config.mts src/modules/bot-runtime/closed-loop-registration-enquiry.db.test.ts --reporter=verbose` (`DATABASE_URL` unset; admin URL built in memory, never printed or stored) |
| Attempt   | First authorized execution; no retry                                                                                                                                                                             |
| Result    | **53/53 passed**, 0 failed, 0 skipped; exit code 0; Vitest duration 12.42 s                                                                                                                                      |
| Server    | Isolated PostgreSQL 17.11 (`server_version_num` 170011), container `al-ict-phase08c-test-pg`, `127.0.0.1:55432`, maintenance database `postgres`                                                                 |
| Harness   | Existing `createTestDatabase` (fresh `al_ict_test_<12hex>`, refuses `al_ict_whatsapp`, no FORCE drop), `closedLoopKit`, FakeTransport                                                                            |
| Messaging | FakeTransport only; no Meta/Graph request, no real WhatsApp send, no credentials present                                                                                                                         |
| Cleanup   | The run's database was dropped; all seven protected `al_ict_test_*` databases unchanged, names and OIDs identical before and after; no leftover test database, session, Vitest or worker process                 |
| Source    | No source, runtime or migration change during the database-validation pass; Git unchanged                                                                                                                        |

Per-scenario passes: RE-CL-1 10/10, RE-CL-2 1/1, RE-CL-3 2/2, RE-CL-4 2/2, RE-CL-5 1/1, RE-CL-6 1/1, RE-CL-7 2/2, RE-CL-8 8/8,
RE-CL-9 2/2, RE-CL-10 19/19, RE-CL-11 1/1, RE-CL-12 4/4.

Main acceptance evidence:

1. The published, pinned version preserves `ask_name.answer.rejectLinks: true` and `sensitive: true` on all three variables;
   canonical text and SHA-256 agree; the runtime enforces the pinned policy (RE-CL-4).
2. Link-like names are rejected before storage, on the initial and Change-answers paths, with re-prompt, recovery, exhaustion and
   no bot reflection (RE-CL-10).
3. The confirmation is persisted at enqueue, before "Yes, hand over", and retrievable through staff-scoped `listMessages()`
   (RE-CL-5, RE-CL-6).
4. Both approved handover routes: "Yes, hand over" → `needs_staff`; class-list "Talk to staff" → `student_requested` (RE-CL-7).
5. The existing retention function clears eligible terminal-session variables, awaiting data and tokens only, not conversation
   history or events; the shortened period was confined to the disposable database and restored (RE-CL-11).
6. No lead, attribution, contact tag or staff assignment results from any tested path (RE-CL-12).
7. No production runtime or migration change during the database-validation pass.

### 5.3 Limitations and open obligations

- Registration content is synthetic; real A/L years and class names are pending.
- Final production consent wording and conversation-message retention policy are pending; retention scheduling is not
  established (operator-invoked only).
- Browser rendering and actual WhatsApp delivery are unverified.
- `rejectLinks` is bounded, field-specific data-quality validation, not a universal security filter.
- Still open, separately: GI-CL-14 (General Information SEND_BUDGET PostgreSQL evidence; the RE-CL-10 render-failure case
  does not replace it), the Inbox timestamp-ordering P3, the integrated six-bot acceptance, browser verification, and the
  production message-retention and retention-scheduling decisions.
- Production activation: **NOT AUTHORIZED.**

## 6. Outstanding owner business data

Real A/L years (D-16); real class names; final consent wording; conversation-message retention (D-15); the retention
schedule/operator.
