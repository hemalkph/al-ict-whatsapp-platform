# ADR 0020: Bot outbound dispatch, staff control sequences and the Stop-suppression correction (Phase 08D)

- **Status:** Implemented in Phase 08D; awaiting independent code, database and concurrency review. Not approved.
- **Context:** Phase 08-0 architecture V3.2 (sections I, J, K.8, K.10, L, N); the corrected Phase 08D implementation plan
  (`PHASE_08D_IMPLEMENTATION_PLAN.md`, revision 2); ADR 0014 (outbound messaging), ADR 0019 (bot persistence).

## Decision

### Migration 0008 (`0008_bot_outbound_dispatch`)

- `outbound_requests` gains `origin` (`STAFF` | `BOT`, default `STAFF`), `bot_session_id`, `bot_step_seq`, `bot_send_epoch` and
  `control_seq`.
  - `requested_by_membership_id` becomes nullable, and `message_type` gains `INTERACTIVE`.
  - A NULL-safe shape CHECK requires a STAFF row to have its member and no bot column, and a BOT row to have no member plus a
    session, a step of at least 1 and an epoch of at least 1.
  - BOT rows may be `TEXT` or `INTERACTIVE`; STAFF rows `TEXT` or `TEMPLATE`.
  - A BOT row's idempotency key is `bot-<session>-<step>`.
  - Unique indexes: one request per session step; one in-flight (`QUEUED`/`SENDING`) BOT request per session; one per
    conversation.
  - A staff-control index on `(organization_id, conversation_id, control_seq)`.
  - A composite foreign key to `bot_sessions (organization_id, id, conversation_id, whatsapp_account_id)` (`MATCH SIMPLE`, so
    it is skipped for STAFF rows).
- The 0004 guard function is replaced in place. Every 0004 rule is kept. In addition, origin, the BOT bindings and `control_seq`
  are immutable, and a BOT request can never move `SENDING → QUEUED`. STAFF keeps that move for results that prove nothing was
  sent.
- **Control sequences.** `BEFORE INSERT` triggers on `outbound_requests` (every origin) and `conversation_events` allocate
  `control_seq` with the 0007 allocator, under the conversation row lock, and overwrite any supplied value.
  - Rows written before 0008 keep NULL, which counts as "before every session".
  - Two indexes on `conversation_events` support the 08E eligibility queries.
- `bot_request_hold_code(org, request)` (`STABLE` SQL) is the single BOT dispatch rule. It is used by the claim and by the final
  authorization. In order, it checks:
  1. that the session, deployment and bot can be read;
  2. that the deployment is not `RETIRED` or `STOPPED`;
  3. the send epoch;
  4. that the bot is not archived;
  5. that output is not suppressed;
  6. the session branch: a live session waiting for this exact step, or a terminal session's recorded terminal notice;
  7. that no `RESOLVED` event and no staff control row is sequenced after `started_control_seq`.

  It reads only protected columns.

- `bot_deployment_events.requests_in_flight` (see "Stop" below).

### Interactive messages

- One versioned, strict `InteractivePayload` (`messaging/interactive.ts`) is the only shape written and read. It is stored
  identically in `outbound_requests.payload` and in `messages.content.interactive`. The dispatcher re-validates the stored value
  before sending; a value that no longer validates is HELD `payload_invalid`.
- Meta's reply-button and list-message reference pages were re-read on 2026-10-19 (Graph v26.0):
  - **buttons:** up to 3; body 1024; footer 60; title 20 and unique; id 256.
  - **lists:** up to 10 sections and 10 rows in total; body 4096; footer 60; button label 20; section title 24; row id 200;
    row title 24; description 72.
  - Meta marks a section title **required** even for one section, so a flat engine list is stored as one section titled with
    the list's button label.
- Meta states lengths in "characters" without defining the unit. We count **UTF-16 code units**, checked explicitly, because
  the installed zod's `.max()` counts code points. That unit is never smaller than code points or graphemes.
- The list body is capped at the flow contract's 1024.
- Reply ids must match the bot contract's `b1.<token>.<key>` grammar; a test pins pattern equality.
- Interactive messages are BOT-only. They follow the text eligibility rules: window-bound, and BSUID recipients stay gated.

### Automated request creation

- `enqueueAutomatedMessage(tx, authority, input, deps)` (`messaging/enqueue.ts`) is the only creator of BOT requests.
- It runs in the caller's step transaction, which already holds the L.2 step locks.
- From the database, it re-verifies the session (live, unsuppressed, bound to the authority's conversation, account, contact,
  deployment and version), the deployment (status and epoch), the bot (not archived), and the absence of staff control after
  the session start. It then applies the ordinary policy: account, contact, window and recipient.
- Idempotency comes from a per-step advisory lock, the derived key and the content fingerprint. The same content replays; other
  content conflicts.
- The BOT deadline is 120 s.
- It refuses while `BOTS_RUNTIME_ENABLED` is off. **No production code or script imports it** (pinned by a static test). No
  production application caller can create live automated BOT requests at this checkpoint, and every automation gate defaults
  OFF.

### Two-stage authorization

- **Gate:** `BOTS_RUNTIME_ENABLED` must be exactly `"true"`. When it is off, the claim's candidate query excludes BOT rows, so
  they can neither be sent nor fill the 20 candidate slots and starve staff requests.
- **Stage 1 (claim):** the existing checks (`assess`, recipient, deadline) run first, then `bot_request_hold_code`, then
  payload re-validation. A refusal moves the request `QUEUED → HELD` with the code.
- **Stage 2 (final pre-HTTP authorization, BOT only, `messaging/bot-authorization.ts`):**
  - **ONE** statement reads the request and its claim fence, the account, the conversation's `last_inbound_at`, the contact
    (archive, consent, phone), every BSUID alias, and `bot_request_hold_code`.
  - The clock is read **after** the statement returns.
  - The checks run in this order: fence; gates; account; 60 s start budget; deadline; bot rule; `assess()` (window, contact,
    recipient choice) with the fresh clock; the chosen recipient still being the stored and claimed one.
  - Any refusal is a fenced `SENDING → HELD` with its code. There is **no transport call** and the request is never re-queued.
- **STAFF:** the final read is unchanged byte for byte, including its re-queue path.
- **Every other BOT outcome:** a result proving nothing was sent becomes `HELD`, never `QUEUED`; `unknown` becomes
  `UNKNOWN_OUTCOME`.

### Staff control

- Staff submission locks the conversation row first, then takes the idempotency lock, then the account, then inserts. The
  replay path takes the same lock first.
- The Inbox workflow already locked the conversation first; its event insert now allocates `control_seq`.
- Takeover acts on **output** in 08D: hold codes `staff_took_over` and `conversation_resolved` at claim and at the final read.
  Handing a session over on a staff action is 08E work.

### Stop suppression (the correction of the open P2)

- **The finding:** a suppression statement that waits on a request row can close a cycle.
  1. Stop holds the conversation, and its statement saw R as `QUEUED`.
  2. A claim committed R as `SENDING`.
  3. The acceptance record holds R's newest version and waits for the conversation.
  4. The waiting statement must wait for that record, so the two deadlock.
- **The correction (`bot-control/suppression.ts`):** two statements on the caller's transaction (same connection; locks held
  until commit).
  1. `SELECT r.id … ORDER BY r.id FOR UPDATE OF r SKIP LOCKED` over the `QUEUED` BOT requests of the stopped deployments'
     sessions, live or terminal, so terminal notices are included.
  2. `UPDATE … SET state = 'HELD' WHERE id = ANY(<locked ids>) AND state = 'QUEUED'`.

  A count statement follows. The candidate statement never waits on a request row, so Stop has no wait edge to any request.
  Stop, Emergency Stop and Retire all use it, with hold code `bot_stopped`; the deployment event kind tells them apart. 08E's
  sweeper and terminalization must reuse it.

- **A skipped request:** Stop's epoch bump commits in the same transaction. The dispatcher's claim or final authorization then
  holds the request (`bot_epoch_superseded`). A request whose final authorization had already passed cannot be recalled
  (V3.2 I.4, blocker 42).
- **Audit counts on the deployment event:**
  - `requests_suppressed`: the requests this operation itself moved to `HELD`.
  - `requests_in_flight`: the requests of the affected sessions still `QUEUED` or `SENDING` in the count statement's snapshot,
    taken after the hold. It is not a count of HTTP attempts or acceptances, and not a promise that they stay unsent.

### Acceptance-record retry (STAFF and BOT)

- Only the `ACCEPTED` record transaction is retried, at most 3 transactions in total.
- It retries only when every SQLSTATE in the error chain is `40P01` or `40001`, **and** the failure came from a statement inside
  the transaction (a per-attempt `bodyCompleted` flag).
- It never retries a COMMIT-stage error (ambiguous), a connection failure (no SQLSTATE, or class 08/57 anywhere in the chain), or
  any other code.
- Every attempt uses the same claim fence and `wamid`. It stops at once when the fence is lost. The transport is never called
  again.
- When the retries are exhausted, it falls back to the existing fenced `UNKNOWN_OUTCOME accepted_but_not_recorded`.
- Status events cannot be duplicated: each attempt is atomic, and the reconciliation helpers only update rows.

## Consequences

- **Production concurrency P2:** the correction is implemented, together with the three-participant READ COMMITTED regression
  (`bot-control/suppression.db.test.ts`):
  - a cursor barrier with proofs P1–P6;
  - a legacy negative control with retries enabled and with retries disabled;
  - the real-Stop orders O1–O8;
  - the I.3 invariant.

  It **remains OPEN and production-blocking until those tests pass on PostgreSQL and the correction is independently reviewed.**

- **Two deliberate STAFF behaviour changes:**
  - the conversation-first lock in submission;
  - the bounded acceptance-record retry, which only turns some false `UNKNOWN_OUTCOME` results into a truthful `ACCEPTED`.
- **Not demonstrated:** the V3.2 J.1 rationale for the conversation-first submission lock (a `KEY SHARE`-then-upgrade
  deadlock). PostgreSQL lets a transaction that is the only locker strengthen its own row lock without queueing, and the
  allocator's `FOR NO KEY UPDATE` does not conflict with other `KEY SHARE` holders. The lock is kept for the uniform L.2 order;
  the claim is not.
- **Remaining limits:**
  - the window after the final authorization (blocker 42);
  - the acceptance record waits behind a long Stop's conversation locks (latency, not correctness);
  - one database role (the "only the runtime enqueues" rule is enforced by application code and static tests);
  - the BOT deadline and window use the application clock, like staff messaging.
