# WhatsApp Integration

Official **Meta WhatsApp Business Platform Cloud API only**. Never WhatsApp Web automation, Puppeteer/Chromium/Selenium, whatsapp-web.js, Baileys, QR-linked devices or unofficial clients ([ADR 0002](adr/0002-whatsapp-cloud-api-only.md)).

Phase 04 builds the **inbound** half. Status: checkpoints 1, 2, 3, 4A, 4B and 4C are done: Meta documentation verified, fixtures, schema and migration `0002` (checkpoint 1), and the **webhook ingress** (checkpoint 2): `GET`/`POST /api/webhooks/whatsapp`, exact-byte signature verification, raw delivery and per-item event persistence, routing and idempotency. The **queue and worker core** (checkpoint 3: claiming, 120 s leases, fencing, retry/`DEAD` with at most 8 handler runs, held-event requeue, queue statistics) exists as tested infrastructure with fake handlers only. Checkpoint 4A adds contact identity resolution for normal inbound messages (`resolveInboundContact`: tenant-scoped, BSUID-alias based; a phone number alone is not proof of identity, so a new BSUID is never attached to an existing contact by phone, duplicates are preferred to wrong merges, and manual reconciliation is deferred); nothing calls it yet. Checkpoint 4B adds the inbound MESSAGE handler (contact, conversation, message, media metadata, reply links, Click-to-WhatsApp attribution) that a worker can run through `processWebhookBatch({ handlers })`. Checkpoint 4C adds the STATUS handler (history plus cached status of OUTBOUND messages through the Phase 02 operations, out-of-order safe, status-before-message kept and reconciled later, never touching conversations). Checkpoint 5A adds the standalone worker (`npm run whatsapp:worker`) that runs exactly those two handlers: opt-in (`WHATSAPP_WORKER_ENABLED=true`), no Meta call, graceful shutdown, bounded database-outage recovery. **Nothing starts it for you and it is not deployed anywhere**: there is no outbound sending, no identity handler and no operator account-activation or replay workflow yet (later checkpoints). Decisions: [ADR 0013](adr/0013-whatsapp-webhook-ingestion.md). Evidence, with what is unresolved: [WHATSAPP_G0_EVIDENCE.md](WHATSAPP_G0_EVIDENCE.md).

## Flow (ingress, the queue core, the MESSAGE and STATUS handlers and an opt-in worker are implemented; nothing runs the worker by default)

```
WhatsApp user -> Meta Cloud API -> HTTPS webhook /api/webhooks/whatsapp
  GET   verification handshake (hub.mode / hub.verify_token / hub.challenge)
  POST  verify HMAC over the exact received bytes -> store exact bytes (webhook_requests)
        -> extract items (webhook_events, idempotent, routed by phone_number_id) -> 200
worker (PostgreSQL SKIP LOCKED) -> contacts / conversations / messages / statuses / attribution
```

The endpoint is not staff-authenticated (no Better Auth); trust comes from the verification token, the signature and the configured `whatsapp_accounts` row. `src/proxy.ts` excludes the path (a proxy would buffer and silently truncate the body that the signature covers). It does nothing expensive before acknowledging Meta: no contact workflow, no bots, no Meta calls, no media download.

## Configuration

Read lazily (build and tests need none), validated with zod like the auth configuration. Names: `META_APP_SECRET` (signs every number's webhooks; global to the Meta app), `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (random, at least 32 characters; global to the app; per account only if Meta callback overrides are adopted later). Phase 04 reads **no access token** (nothing calls Meta). Per-number access tokens come later through `whatsapp_accounts.credential_ref` (the name of a server-side secret, never a value in the database). Nothing real is configured and no Meta app exists yet; tests use fake values. Local development needs an HTTPS tunnel (Meta requires a valid public certificate).

## HTTP outcomes (implemented)

| Request                                                                                                           | Response                                                | Stored                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET` valid `hub.mode=subscribe` + token + challenge                                                              | 200, `text/plain`, the challenge, `no-store`, `nosniff` | nothing                                                                |
| `GET` anything else                                                                                               | 403, empty                                              | nothing                                                                |
| Required setting missing                                                                                          | 500, empty (the log names the key only)                 | nothing                                                                |
| `POST` missing/malformed/wrong signature                                                                          | 403, empty                                              | nothing                                                                |
| `POST` declared or streamed body over 4 MiB                                                                       | 413 with `Connection: close`                            | nothing                                                                |
| `POST` valid signature, invalid UTF-8 / invalid JSON                                                              | 200                                                     | request row `UNPARSEABLE` (`invalid_utf8` / `invalid_json`), no events |
| `POST` valid signature, JSON that is not a WhatsApp envelope                                                      | 200                                                     | request row `UNSUPPORTED_SHAPE`, no events                             |
| `POST` valid signature, normal delivery                                                                           | 200                                                     | request row `ACCEPTED` + one event per message/status/other item       |
| `POST` duplicate delivery or duplicate item                                                                       | 200                                                     | request row kept; duplicate items add no event                         |
| `POST` valid signature, content that deterministically cannot be stored (SQLSTATE 22/23/54, or very deep nesting) | 200                                                     | request row `EVENTS_REJECTED`, no events                               |
| `POST` the database is unavailable or the transaction fails otherwise                                             | 500                                                     | nothing (Meta retries)                                                 |

**Event routing** (organization only from the `whatsapp_accounts` row found by `metadata.phone_number_id`): ACTIVE -> `PENDING` with routing; account PENDING -> `UNROUTABLE` hold (`account_pending`, **routing kept**: the event stays with the account that matched); unknown number -> `UNROUTABLE` with no routing (`unknown_account`, released only by an explicit operator decision naming a verified target account); `entry.id` differing from the account's `waba_id` -> `UNROUTABLE` with no routing (`waba_mismatch`, conservative: G0 only supports `entry.id` = WABA id by placeholder semantics); DISABLED -> `IGNORED` (`account_disabled`); archived -> `IGNORED` (`account_archived`). Also `IGNORED`: a `played` or unknown status (`status_not_mirrored`), a change on a field other than `messages` (`unsupported_field`), a group message (`group_unsupported`), and every `system` message (`system_message_pending_h1`, kept untouched for a later reviewed replay: the identity-change delivery is unresolved, G0 item H1). A malformed element is stored `DEAD` (`malformed_event`). Nothing is dropped. **Contact pairing** is per message (`from_user_id` with `contacts[].user_id`, else `from` with `wa_id`; never `contacts[0]`); the matched element, or `null`, and the pairing result are stored with the event.

## What Meta documents (summary; see the evidence register for sources and gaps)

- Verification: `hub.mode=subscribe`, `hub.challenge`, `hub.verify_token`; answer 200 with the challenge.
- Signature: `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 with the App Secret. **Our rule: over the exact received bytes, nothing else** (ADR 0013).
- At-least-once delivery, retried for up to 7 days (the generic Graph page says 36 hours), payloads up to 3 MB, no ordering guarantee stated.
- One `messages` field carries inbound messages and outbound statuses. Routing key: `entry[].changes[].value.metadata.phone_number_id`.
- Users can be identified only by a **BSUID** (`contacts[].user_id`, `messages[].from_user_id`, `statuses[].recipient_user_id`); `wa_id` and `from` may be absent.
- Media ids received by webhook expire after 7 days; media URLs after 5 minutes.

## Inbound message types (mapping)

| Meta                                                          | Stored as                              | Notes                                                                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| text                                                          | TEXT                                   | body                                                                                                                                                  |
| image, video, document, sticker, audio (voice flag)           | IMAGE, VIDEO, DOCUMENT, STICKER, AUDIO | metadata and a `message_attachments` row (`PENDING` = provider media exists, not fetched; no downloader in Phase 04); the webhook `url` is not stored |
| location, contacts                                            | LOCATION, CONTACT                      | personal data                                                                                                                                         |
| button, interactive `button_reply` / `list_reply`             | BUTTON, INTERACTIVE                    |                                                                                                                                                       |
| reaction                                                      | REACTION                               | recorded; never advances conversation activity or the service window                                                                                  |
| identity-change system item                                   | no message row                         | see ADR 0013 section 8 (not designed until G0 item H1 closes)                                                                                         |
| other system items                                            | SYSTEM                                 | only when the contact and conversation already exist                                                                                                  |
| unsupported, unknown, Flow `nfm_reply`, `order`, future types | UNKNOWN                                | no official payload shape retrieved for `nfm_reply` / `order`                                                                                         |

Statuses: `sent`, `delivered`, `read`, `failed` map to the Phase 02 status model (append-only history plus a priority cache, NULL < SENT < FAILED < DELIVERED < READ); `played` and unknown values are ignored. A status is matched to a message only by the opaque wamid within the routed account and only if that message is OUTBOUND (never by recipient); a status for a message that does not exist yet is kept unlinked and linked when the outbound writer creates the message (it must take the per-message advisory lock and call `resolveStatusEventsForMessage`). A status is not customer activity: it never extends the customer-service window, reopens a conversation or changes consent.

## Running the worker locally (opt-in; never started for you)

The worker (`npm run whatsapp:worker`) claims already-stored webhook events and runs the MESSAGE and STATUS handlers. It makes no request to Meta and needs no Meta app, number, subscription or credential. It is **disabled unless `WHATSAPP_WORKER_ENABLED=true`** is set explicitly, and it refuses to run against a database that has not been migrated (it never migrates or creates anything).

Safe local procedure (the developer database `al_ict_whatsapp` currently has **zero tables** and must be migrated deliberately by you; this project's tooling never does it silently):

1. Use a disposable local PostgreSQL database for experiments. Create it yourself, point `DATABASE_URL` at it in `.env.local`, and apply the committed migrations with `npm run db:migrate` (only when you decide to).
2. Put events in the queue: send signed requests to a local `next dev` server's `/api/webhooks/whatsapp` (needs `META_APP_SECRET`; sign sanitized fixtures from `src/modules/whatsapp/__fixtures__/` with the same secret), or run the automated tests, which do this against throw-away databases and are the supported way to exercise the worker.
3. Start: `WHATSAPP_WORKER_ENABLED=true npm run whatsapp:worker`. Without that variable it prints why it did not start and exits 2 without touching the database.
4. Stop: Ctrl-C (or `SIGTERM`). It stops claiming, lets the event in flight finish, closes its connections and exits 0.

Limits: `WHATSAPP_WORKER_BATCH_SIZE` (1 to 100, default 20), `WHATSAPP_WORKER_CONCURRENCY` (1 to 8, default 2). Held (`UNROUTABLE`), ignored, `DEAD` and `OTHER`/`IDENTITY` events are never processed by the worker and nothing requeues them automatically; reactivating a WhatsApp account does not release its held events. Logs are JSON lines with fixed fields (counts, internal ids, short reason codes) and never contain message text, phone numbers, BSUIDs, secrets or the database URL.

## Design targets that remain for later phases

- Outbound: all sends go through one messaging service and compliance guard; retries for transient failures with exponential backoff; rate-limit handling. A BSUID-only contact must be addressed through the BSUID recipient path.
- Compliance guard (policy as configuration/domain logic): rolling customer-service window from the latest inbound user message (Meta: opened by a user message or call, 24 hours; the window must be computed from `conversations.last_inbound_at`, never from `messages.occurred_at`), marketing consent with timestamp and source, opt-out, campaign suppression, audience safety, rate and budget controls, quality monitoring, human handover, full auditability. Exact window rules are Meta policy to be re-checked against current documentation when implemented; do not hardcode them across the codebase.
- Track sent/delivered/read/failed per message.
