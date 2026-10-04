# WhatsApp Integration

Official **Meta WhatsApp Business Platform Cloud API only**. Never WhatsApp Web automation, Puppeteer/Chromium/Selenium, whatsapp-web.js, Baileys, QR-linked devices or unofficial clients ([ADR 0002](adr/0002-whatsapp-cloud-api-only.md)).

Phase 04 builds the **inbound** half. Status: checkpoint 1 is done (verification of Meta's current documentation, sanitized fixtures, the schema and migration `0002`, validated against real PostgreSQL on disposable databases and never applied to the developer database). There is **no webhook route, signature code, ingestion, worker or handler yet**. Decisions: [ADR 0013](adr/0013-whatsapp-webhook-ingestion.md). Evidence, with what is unresolved: [WHATSAPP_G0_EVIDENCE.md](WHATSAPP_G0_EVIDENCE.md).

## Flow (designed; built in later Phase 04 checkpoints)

```
WhatsApp user -> Meta Cloud API -> HTTPS webhook /api/webhooks/whatsapp
  GET   verification handshake (hub.mode / hub.verify_token / hub.challenge)
  POST  verify HMAC over the exact received bytes -> store exact bytes (webhook_requests)
        -> extract items (webhook_events, idempotent, routed by phone_number_id) -> 200
worker (PostgreSQL SKIP LOCKED) -> contacts / conversations / messages / statuses / attribution
```

The endpoint is not staff-authenticated (no Better Auth); trust comes from the verification token, the signature and the configured `whatsapp_accounts` row. It does nothing expensive before acknowledging Meta: no contact workflow, no bots, no Meta calls, no media download.

## Configuration

Read lazily (build and tests need none), validated with zod like the auth configuration. Planned names: `META_APP_SECRET` (signs every number's webhooks; global to the Meta app), `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (random, at least 32 characters; global to the app; per account only if Meta callback overrides are adopted later). Phase 04 reads **no access token** (nothing calls Meta). Per-number access tokens come later through `whatsapp_accounts.credential_ref` (the name of a server-side secret, never a value in the database). Nothing here is set yet and no Meta app is configured. Local development needs an HTTPS tunnel (Meta requires a valid public certificate).

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

Statuses: `sent`, `delivered`, `read`, `failed` map to the Phase 02 status model (append-only history plus a priority cache); `played` is ignored.

## Design targets that remain for later phases

- Outbound: all sends go through one messaging service and compliance guard; retries for transient failures with exponential backoff; rate-limit handling. A BSUID-only contact must be addressed through the BSUID recipient path.
- Compliance guard (policy as configuration/domain logic): rolling customer-service window from the latest inbound user message (Meta: opened by a user message or call, 24 hours; the window must be computed from `conversations.last_inbound_at`, never from `messages.occurred_at`), marketing consent with timestamp and source, opt-out, campaign suppression, audience safety, rate and budget controls, quality monitoring, human handover, full auditability. Exact window rules are Meta policy to be re-checked against current documentation when implemented; do not hardcode them across the codebase.
- Track sent/delivered/read/failed per message.
