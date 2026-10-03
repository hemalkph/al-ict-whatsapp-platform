# WhatsApp Integration

Official **Meta WhatsApp Business Platform Cloud API only**. Never WhatsApp Web automation, Puppeteer/Chromium/Selenium, whatsapp-web.js, Baileys, QR-linked devices or unofficial clients.

## Configuration

The exact Meta/WhatsApp environment variable contract is **finalized during the WhatsApp integration phase**. `.env.example` reserves nothing for it yet.

## Design targets

- WABA id and phone number id per account; multiple numbers later.
- Webhook GET verification and POST handling with `X-Hub-Signature-256` validation.
- Inbound: text, interactive (button/list replies), Flow responses, media references, status updates, Click-to-WhatsApp `referral`.
- **Never assume exactly-once delivery.** Idempotency via Meta identifiers; store the raw event in `webhook_events`, acknowledge fast, process asynchronously.
- Outbound: all sends go through one messaging service and compliance guard; retries for transient failures with exponential backoff; rate-limit handling.
- Track sent/delivered/read/failed per message.

## Compliance guard (policy as configuration/domain logic)

- Rolling customer-service window from the latest inbound user message; free-form only while allowed, approved template otherwise.
- Marketing consent with timestamp and source; opt-out with timestamp; suppression from campaigns.
- Campaign audience safety checks, rate controls, budget controls (later), quality monitoring (later).
- Human handover and full auditability.
  Exact window length and rules are Meta policy details to be confirmed against current Meta documentation at implementation time. Do not hardcode them across the codebase.
