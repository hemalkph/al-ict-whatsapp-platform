# ADR 0013: WhatsApp webhook ingestion

Status: Accepted for Phase 04. Checkpoint 1 (G0 evidence, fixtures, schema, migration 0002) is done and checkpoint 2 validated migration 0002 against real PostgreSQL 17.11 on disposable databases (it has never been applied to the developer database). The runtime comes in later checkpoints. Supersedes nothing; extends [ADR 0006](0006-webhook-inbox-no-redis.md). Evidence: [WHATSAPP_G0_EVIDENCE.md](../WHATSAPP_G0_EVIDENCE.md).

## Context

Meta's WhatsApp Cloud API delivers inbound messages and statuses to one HTTPS webhook per app. Delivery is at-least-once with no ordering guarantee and retries for up to 7 days (WhatsApp pages; the generic Graph page says 36 hours). Payloads reach 3 MB. Since April 2026 users may be identified only by a business-scoped user ID (BSUID); the phone-based `wa_id` and the message `from` can be absent. The Phase 02 tables (`webhook_requests`, `webhook_events`, `contacts`, ...) predate these facts.

## Decisions

### 1. The signature rule (non-negotiable)

```
HMAC-SHA256( META_APP_SECRET, exact received HTTP request-body bytes )
```

compared in constant time with the hex digest after `sha256=` in `X-Hub-Signature-256`. **This is the only accepted signature.** No alternate representation is ever accepted: not `JSON.stringify`, not decoded-and-re-encoded JSON, not Unicode normalization, not Unicode re-escaping, not canonical JSON, and there is no fallback "second candidate". The verifier will take a `Uint8Array` only (no string or object overload), so a transformed representation cannot reach it by construction.

Meta's Messenger Platform page says its signature is computed over an "escaped unicode version of the payload" and that hashing decoded bytes gives a different result. That sentence is recorded in the evidence file; it does **not** open an alternate path. If a real Sinhala/Tamil delivery ever fails on its exact received bytes, that is a **transport/framework investigation** (something between Meta and our handler altered the body: a proxy, a CDN, a framework that decoded and re-encoded), never a reason to weaken verification. The optional live smoke only _confirms_ the raw-byte assumption.

Verification happens **before** parsing or persisting anything; invalid signatures are rejected with no database write (invalid-signature telemetry is a log line, not a table, so forged requests cannot cause writes).

### 2. Raw request storage

`webhook_requests.raw_payload jsonb` is replaced by `raw_body bytea NOT NULL` holding the exact bytes. jsonb is not the wire body (it reorders keys, drops duplicate keys, normalizes numbers) and it rejects `\u0000`, so it can neither re-verify a signature nor replay a delivery, and one NUL would fail the insert and poison Meta's retries. `payload_sha256` is kept and now means the lowercase-hex SHA-256 of the exact bytes (CHECK `^[0-9a-f]{64}$`). Parsed content lives per item in `webhook_events.payload`; there is no second full parsed copy at request level. Raw bodies contain personal data (numbers, names, message text): never logged, never returned by an API, and a retention policy is a pre-production requirement ([PRE_PRODUCTION_BLOCKERS.md](../PRE_PRODUCTION_BLOCKERS.md)).

### 3. Signed-but-malformed deliveries: ACK 200 after durable storage

| Situation                                                                       | Response | Stored                                            |
| ------------------------------------------------------------------------------- | -------- | ------------------------------------------------- |
| Invalid signature                                                               | 403      | nothing                                           |
| Body above the cap                                                              | 413      | nothing                                           |
| Valid signature, invalid UTF-8 / invalid JSON                                   | **200**  | request row, `ingest_status = UNPARSEABLE` + code |
| Valid signature, JSON that is not the expected envelope                         | 200      | `UNSUPPORTED_SHAPE` + code                        |
| Valid signature, deterministic event-persistence failure (SQLSTATE class 22/23) | 200      | request row only, `EVENTS_REJECTED` + code        |
| Database unavailable, transient error, or the bytes cannot be durably stored    | **500**  | nothing (Meta retries)                            |

Returning 400 for signed-but-invalid JSON was rejected: Meta retries the same bytes, so a syntactically invalid body can never become valid by retrying and days of retries would only form a poison loop. Because the exact bytes are kept and the failure is recorded, nothing is lost and a future replay tool (needs `webhook.manage`) can re-run the parser after a fix. UTF-8 is decoded with a fatal decoder (invalid bytes are rejected, never replaced). `ingest_error_code` is a short fixed code (1 to 64 characters, `NULL` exactly when `ACCEPTED`), never exception text.

### 4. Request and event model

`webhook_requests` = one HTTP delivery. `webhook_events` = one item extracted from it: a message, a status, an `IDENTITY` change, or an ignored `OTHER` change. Idempotency keys are namespaced, versioned and always scoped by `phone_number_id`: `wa:msg:v1:{phone_number_id}:{wamid}`, `wa:status:v1:{phone_number_id}:{wamid}:{status}:{timestamp}`, `wa:other:v1:{scope}:{sha256(RFC 8785 canonical JSON)}`. wamids are opaque strings, never parsed. The two-level model, the global unique idempotency key and the `SKIP LOCKED` queue are unchanged.

### 5. Routing and account states

Events route by `metadata.phone_number_id` to `whatsapp_accounts.phone_number_id` (never the display number), with `entry.id` cross-checked against `waba_id` (subject to a live confirmation). Existing statuses are used; no new status is added.

| Account state at ingest   | Event status          | Routing columns | Reason             | Released                                                                                        |
| ------------------------- | --------------------- | --------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| ACTIVE                    | `PENDING`             | set             |                    | normal processing                                                                               |
| PENDING (being set up)    | `UNROUTABLE` (a hold) | NULL            | `account_pending`  | automatically by the operator activation operation                                              |
| unknown `phone_number_id` | `UNROUTABLE`          | NULL            | `unknown_account`  | automatically when an account for that id is created ACTIVE or activated through that operation |
| WABA mismatch             | `UNROUTABLE`          | NULL            | `waba_mismatch`    | explicit operator requeue only (a misconfiguration signal)                                      |
| DISABLED                  | `IGNORED`             | set             | `account_disabled` | explicit operator requeue only; re-enabling an account releases nothing automatically           |
| archived                  | `IGNORED`             | set             | `account_archived` | explicit operator requeue only                                                                  |

An account changing state between ingest and processing moves the event the same way (PENDING back to a hold with the routing cleared; DISABLED/archived to `IGNORED`) and **does not count as a processing attempt**. The single requeue primitive requires the account to be ACTIVE now, re-derives `organization_id`/`whatsapp_account_id` from the account row (never stale data), resets `attempts` and `next_attempt_at`, and is called only by the activation operation and an explicit operator command. Nothing is silently lost: held and ignored rows keep their payload until retention (which must exempt held events). The checkpoint-1 schema needs no new column for any of this.

### 6. Provider timestamps are facts

`messages.occurred_at` (and status `occurred_at`) store the provider timestamp whenever it is a positive integer within the JavaScript `Date` range; nothing is clamped or rewritten to protect ordering. A separate **effective activity time**, `LEAST(provider_ts, event.received_at + 5 min)`, is the only value used for derived state: `conversations.last_message_at`, `last_inbound_at` (existing monotonic `GREATEST` operation), the reopen check, and **every future customer-service-window calculation, which must read `conversations.last_inbound_at` and never `messages.occurred_at`**. A future-dated message therefore cannot extend the window by more than 5 minutes or reorder the inbox while its history stays untouched. Anomalies (`timestamp_future`, `timestamp_stale`) are logged with the delta and a reason code, no personal data. Known limitation: the per-conversation message timeline sorts by `occurred_at`, so an absurd provider timestamp sorts oddly until time catches up.

### 7. BSUID identity and history

- `contacts.wa_id` becomes nullable (a BSUID-only user has no phone-based id; `UNIQUE (organization_id, wa_id)` is unchanged and still rejects duplicates among non-NULL values) and `contacts.username` is added (untrusted display text). There is **no `contacts.bsuid`**.
- New table **`contact_bsuids`** is the single source of truth for BSUID ownership and history: `UNIQUE (organization_id, bsuid)` (a BSUID can never belong to two contacts, even when retired), a composite organization-aware FK to `contacts`, `retired_at` (NULL = not known to be superseded), timestamps with ordering CHECKs, an index for contact lookup (newest seen first). Meta regenerates the BSUID when a user changes phone number and redelivers webhooks for days in no guaranteed order, so a late event carrying the old BSUID must resolve to the existing contact instead of creating a duplicate; a single "current BSUID" column cannot do that. Phone numbers are **not** aliased: they are recycled between people, BSUIDs are unique per portfolio-user pair.
- **No "one current alias per contact" unique index.** Meta documents regeneration but not whether the old BSUID stops being valid at once or whether two can coexist (G0 item H2). The database does not assert what Meta does not document. The application keeps at most one non-retired alias per contact and picks the newest `last_seen_at` if it ever sees more. A later migration can add the index once evidence exists.
- **Provenance:** `source_webhook_event_id` references `webhook_events(id)` `ON DELETE SET NULL` (single column), so it can never block pruning old events. Tenant ownership comes from `organization_id` + `contact_id`, not from this pointer. Note: the Phase 02 provenance FKs on `messages.source_webhook_event_id` and `message_status_events.webhook_event_id` are composite `NO ACTION` and **do** block pruning until a retention job nulls them first (their documented design); that is unchanged, and the retention job must handle it.
- Contact matching inside a delivery is explicit: primary `messages[].from_user_id <-> contacts[].user_id`, fallback `messages[].from <-> contacts[].wa_id`; never `contacts[0]`, never array position (H3: no official example has more than one sender per `value`; the multi-sender fixture is synthetic).

### 8. Identity changes: handler design STOPPED (G0 item H1)

Official pages contradict each other about how identity changes are delivered ([evidence](../WHATSAPP_G0_EVIDENCE.md)): the BSUID page documents a system message carrying only the **new** BSUID plus a separately subscribable `user_id_update` field carrying `previous`/`current`; the webhooks overview field list omits `user_id_update`; a legacy page documents `user_changed_number` with phone numbers. An earlier working assumption (a `system.previous_user_id` property) came from a search summarizer and is **not supported by any official text**; it is discarded. Decided now: `system.body` is never parsed; no handler may depend on an undocumented field; the old BSUID is available only from a structured `previous` field; conflicting mappings fail closed (never silently merged). **Not decided until H1 is closed** (a look at the real App Dashboard's field list): which delivery will occur, the exact `system.type` values, and any automatic `wa_id` mutation. Policy by documented subtype, for now: `user_changed_user_id`, `user_changed_number` and `user_id_update` each have **insufficient evidence, so no automatic `wa_id` mutation is allowed** (the earlier "clear or replace `wa_id`" idea is withdrawn). `wa_id` is only ever filled by ordinary message handling when empty and unused. An identity-change item is never an ordinary chat message (no message row, no conversation activity); its raw payload stays preserved for audit and replay. Other system messages are stored as `SYSTEM` only when the contact and conversation already exist, and never advance activity.

### 9. Business portfolio invariant

BSUIDs are scoped to a **Meta Business Portfolio**, not to a phone number, and the documentation does not equate a portfolio with a WABA. `UNIQUE (organization_id, bsuid)` is therefore correct only while **one application organization = one Meta Business Portfolio**. This is an **onboarding invariant**: the account-onboarding operator tool will require explicit confirmation and the runbook states it (it cannot be verified without an authenticated Graph call, which Phase 04 does not make). If one organization ever contains accounts from several portfolios, the required schema change is: add `business_portfolio_id` to `whatsapp_accounts` and `contact_bsuids`, scope uniqueness to `(organization_id, business_portfolio_id, bsuid)`, take the portfolio from the receiving account during resolution, and revisit parent BSUIDs. WABA id is never substituted for the portfolio id.

### 10. Media attachments

A `message_attachments` row with `storage_status = PENDING` means **provider media exists but has not been fetched yet**. No downloader exists or consumes these rows in Phase 04; `message_attachments_pending_idx` is reserved for the future downloader. No Phase 04 health check treats PENDING attachments as a failing queue: queue health looks only at `webhook_events`. Meta media ids from webhooks expire after 7 days and media URLs after 5 minutes (verified), so the downloader must fetch promptly and must handle `EXPIRED`. The media `url` in the webhook is not persisted outside the retained event payload.

### 11. Worker semantics (decided now, implemented later)

`MAX_ATTEMPTS = 8` handler runs per event, crashed runs included. `attempts` counts claims (the existing claim operation increments it on every claim, including lease reclaim): the first claim makes it 1; after any claim, `attempts > 8` marks the event `DEAD` **without running the handler**; a transient failure with `attempts >= 8` marks it `DEAD` (no further retry), otherwise `FAILED` with `next_attempt_at = now + delay`. A permanent error is `DEAD` after one run. Backoff `delay(n) = min(30 s * 2^(n-1), 1 h)` with plus or minus 20 % uniform jitter gives the nominal gaps **30 s, 1 m, 2 m, 4 m, 8 m, 16 m, 32 m** before runs 2 to 8 (3,810 s = 63 m 30 s nominal in total; 50 m 48 s to 76 m 12 s with jitter). Lease 120 s; per-event wall clock 60 s and `statement_timeout` 15 s stay below the lease. Completion and failure updates are fenced on `status = 'PROCESSING' AND locked_by = me`.

### 12. Graph version

Recorded only (observation, 2026-10-04): v26.0 (2026-07-29, latest), v25.0 (2026-02-18, expires 2028-07-29), v24.0 (2025-10-08), v23.0 (2025-05-29). Inbound webhooks make no Graph call and require no version choice from us; the outbound version is decided in the outbound phase.

## Migration 0002 deployment precondition (validated)

`0002` runs `ALTER TABLE webhook_requests ADD COLUMN raw_body bytea NOT NULL` **before** `DROP COLUMN raw_payload`, with no default and **no backfill**. That is correct only while `webhook_requests` is empty, so **0002 must be deployed before any real webhook data exists**. No runtime code writes the table yet, so every existing database satisfies this today; once the webhook route ships and a delivery has been stored, the precondition is permanently gone and a different migration would be needed.

- Deliberately not done: filling `raw_body` from `raw_payload`. Serializing the jsonb would fabricate bytes that were never on the wire, could never re-verify a signature, and would make a stored hash look authoritative.
- Proven by `src/db/__tests__/migration-0002-precondition.db.test.ts` with the real drizzle migrator: on a pre-0002 database with an empty `webhook_requests` the migration applies (22 to 23 tables); with one existing row it fails with SQLSTATE `23502` (`column "raw_body" of relation "webhook_requests" contains null values`, statement 4 of 17), and **nothing is half-applied** (0002 is not recorded, `contacts.wa_id` is still NOT NULL, `contact_bsuids` does not exist, the original row and its jsonb are untouched); and once the table is empty by an operator decision the same migration applies. The migrator runs the pending migrations in one transaction, which is what makes the failure safe.
- If real or user data could already be in `webhook_requests` anywhere, **stop**: do not run 0002 and do not edit it automatically; decide the data's fate first (it would have to be exported as evidence, not converted).
- Run order for a deployment: apply `0002` first, then deploy the version that contains the webhook route.

## Implementation notes (checkpoint 2: pure core and HTTP ingress)

Implemented in `src/modules/whatsapp/` behind a two-function public API; the route imports only that. Decisions taken while implementing:

- **Exact bytes only.** `verifyWebhookSignature(body: Uint8Array, header, secret)` has no string or object overload (checked by the compiler in a test), computes exactly one HMAC, and a static test asserts it contains no JSON, normalization, escaping or canonical form. The handler reads `request.body` as bytes through a bounded reader (4 MiB, streamed count; `Content-Length` only as a hint); it never calls `request.json()` or `request.text()`. UTF-8 is decoded with a fatal decoder that keeps a BOM.
- **Oversize refusals close the connection.** A 413 carries `Connection: close`. Found with a stalling raw client and an E2E run: after answering 413 the server otherwise held the request open until the client left. Covered by a handler test and a real-server E2E test.
- **Deterministic versus transient** is decided by SQLSTATE (22, 23 and 54 deterministic; also `RangeError` from very deep nesting), inside a savepoint so a deterministic child failure leaves the request row (`EVENTS_REJECTED`, `event_insert_data_error`) and no children, while infrastructure errors roll everything back and answer 500. A normalizer failure (a pure function of the bytes) is stored as `EVENTS_REJECTED` / `normalize_failed`.
- **System messages are not interpreted** (H1 unresolved): every `system` message becomes an `IGNORED` `OTHER` event (`system_message_pending_h1`) with the raw item preserved. No `IDENTITY` event is ever emitted. `user_id_update` is just an unsupported field.
- **Canonical JSON** (`src/shared/canonical-json.ts`) is the RFC 8785 Appendix A sample canonicalizer (JSON.stringify for primitives, UTF-16 code-unit key order), refusing non-finite numbers; tested against the official section 3.2.3 example and every Appendix B number row. It is imported only by the idempotency-key module.
- **Event payload** (`webhook_events.payload`): `{v:1, wabaId, field, metadata, contact, pairing, message}` for messages, `{..., status}` for statuses, `{..., element}` for other items, all NUL-stripped and well-formed.
- **No `after()`, worker, timer or Meta call** exists in the ingest path (a static test scans for them).

## Consequences

- Migration `0002` changes `webhook_requests` (drops `raw_payload`, adds `raw_body`, `ingest_status`, `ingest_error_code`), `contacts` (nullable `wa_id`, `username`) and adds `contact_bsuids` (23 tables). `ADD COLUMN raw_body ... NOT NULL` assumes `webhook_requests` is empty, which holds everywhere because nothing writes it yet; on a non-empty table the migration fails safely and atomically (see the precondition section above).
- A contact must have a `wa_id` or at least one `contact_bsuids` row. The database cannot express that across tables; the single contact-creation code path, a database test and a tripwire query in the operator queue-status tool enforce it.
- `WEBHOOK_EVENT_TYPES` gains `IDENTITY` and `MESSAGE_TYPES` gains `REACTION` (TypeScript only; both columns have no CHECK).
- Open after this checkpoint: H1 (identity delivery), H2 (old/new BSUID overlap), H3 (multi-sender), the wire form of non-ASCII payloads, reaction versus the service window; see the evidence register. Identity handling must not be built until H1 is closed.
