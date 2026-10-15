# Architecture

## Style

Modular monolith in one Next.js (App Router, strict TypeScript) codebase. No microservices.

## Layout

```
src/app/       routes only (UI and API handlers); thin, delegates to modules
src/modules/   domain modules, one folder each, public API via index.ts
src/shared/    small cross-cutting code (errors, logging); no domain logic
docs/          specs and ADRs
```

## Module boundaries

- A module exposes a public API through `src/modules/<name>/index.ts`.
- Code outside a module (including other modules and `src/app`) imports it only via `@/modules/<name>`.
- Files inside a module import their own internals freely.
- ESLint enforces this for files outside `src/modules` (`no-restricted-imports` on `@/modules/*/*`). Module-to-module deep imports are not lint-enforced yet: this is a convention, reviewed by humans. Do not add clever lint rules; if the rule gets brittle, keep the convention.

## Implemented modules

- `auth` (`src/modules/auth`): the two Better Auth instances built from one shared base configuration. Public API (`@/modules/auth`): `getAuth()` (public instance, the only one that may ever be HTTP-mounted), `getSession()`, `readAuthEnv()`. The private provisioning instance lives in `src/modules/auth/provisioning.ts`, is not exported from the barrel, and is import-restricted by ESLint to the auth and access modules.
- `access` (`src/modules/access`): fixed roles/permission matrix, `can`/`assertCan`, `requireUser`/`requireAccess`/`requirePermission`, `AccessContext`. Feature modules take an `AccessContext` and scope every query by `ctx.organizationId`.
- `whatsapp` (`src/modules/whatsapp`): webhook ingress (GET verification, exact-byte HMAC, raw body and per-item event storage, routing and idempotency; public API `handleWebhookGet` / `handleWebhookPost`), the PostgreSQL event queue and worker core (`queue/`), contact identity resolution (`identity/`), the MESSAGE and STATUS handlers (`inbound/`, `status/`), the opt-in standalone worker (`worker/`, started only by `npm run whatsapp:worker`) and the operator-only layer (`operator/`, used by `scripts/whatsapp-{accounts,events,status}.ts`). Everything except the two webhook handlers is internal to the module. Still not implemented: any call to Meta (outbound messaging, media download), identity-change handling, conversations / inbox UI. See `WHATSAPP_INTEGRATION.md`, ADR 0013 and `RUNBOOK_WHATSAPP.md`.
- Staff HTTP API: `src/app/api/staff/**` (5 route files) + `src/lib/route-helpers.ts`; routes call only the `@/modules/access` public API.
- Staff lifecycle services live in `src/modules/access/staff/` (re-exported from `@/modules/access`): createStaff, listStaff, changeMemberRole, suspendMember, reactivateMember, resetStaffPassword.
- Cross-cutting security helpers in `src/shared`: HTTP authorization errors and `toErrorResponse`, `emitSecurityEvent`, same-origin check, safe redirect validation.
- `src/app/**` may not import `@/db` or the private provisioner (ESLint).

## Routes and entrypoints

`src/proxy.ts` (optimistic cookie check), `/api/auth/[...all]` (public Better Auth instance), `/api/account/change-password`, pages `/login`, `/change-password` and the authenticated group `(app)` (landing at `/`, the staff inbox at `/inbox`). Operator CLIs live in `scripts/`: the auth ones call `@/modules/access/operator`, the WhatsApp ones call `@/modules/whatsapp/operator` (accounts, held and DEAD events, health) and `@/modules/whatsapp/worker` (the opt-in worker, `scripts/whatsapp-worker.ts`). The webhook endpoint is `/api/webhooks/whatsapp` (excluded from the proxy).

## Outbound messaging (Phase 05, backend only)

`src/modules/messaging` is a separate module from `src/modules/whatsapp` (the inbound module does not import it; a static test pins this). Public API: `submitOutboundMessage`, `getOutboundRequest` and two error classes. Two staff routes call it (`POST /api/conversations/{id}/messages`, `GET /api/outbound-requests/{id}`); they only queue and read. Sending happens in the opt-in `npm run whatsapp:outbound-worker` process (claim → SENDING → one HTTP request in `meta-transport.ts` → fenced record). `src/modules/messaging/meta-transport.ts` holds the only `fetch` to Meta in server code. See [ADR 0014](adr/0014-whatsapp-outbound-messaging.md).

## Staff inbox (Phase 06)

`src/modules/inbox` (public API `@/modules/inbox`) owns every inbox query and rule: the conversation list, conversation detail and contact panel, the message timeline, status and assignment changes (compare-and-set under the conversation row lock), per-staff seen state, internal notes, contact tags and quick replies. It takes only `@/modules/access` (authorization) and the read-only `getReplyReadiness` from `@/modules/messaging`; it has no network, transport or outbound-service import and cannot send (static tests). The other modules do not import it. Thirteen thin routes under `src/app/api/inbox/**` call it through `handleApi` (same-origin on mutations, `requireAccess`, safe errors). The page `/inbox` (`src/app/(app)/inbox/`) is a server component that renders the first page of data and hands over to a client component (`inbox-app.tsx`, with the list, timeline, composer, quick-reply picker and details panel); filters and the open conversation live in the URL. Replies use the Phase 05 endpoint only. Bounded polling refreshes the screen (no realtime service). See [ADR 0015](adr/0015-staff-inbox.md).

`src/modules/leads` (public API `@/modules/leads`, Phase 07B) owns the lead rules: manual creation, status changes (compare-and-set on a revision, under the contact's advisory lock and the lead row lock), the lead list, the lead detail with its attribution read model, lead history and the leads of one contact. It takes only `@/modules/access`; it imports no WhatsApp, messaging or inbox code, has no network code, and writes only `leads` and `lead_events`. Lifecycle timestamps are read from the database clock after the locks, never taken from the client (the closed time and a reopened cycle start keep a conservative later boundary only when a stored time is ahead of that clock; see ADR 0016). A lead write locks the actor's organization and then membership, the order staff management uses. Six thin routes under `src/app/api/leads/**` call it through `handleApi`. Automatic creation from ad referrals is the reconciler below (07C: implemented, undergoing independent review, not approved and not production-ready); the pages (07D) are not implemented. See [ADR 0016](adr/0016-leads-and-ad-attribution.md).

`src/modules/leads/reconcile` (Phase 07C) is the automatic lead reconciler: a bounded keyset scan of confirmed Meta ad touches of INBOUND messages that belong to the touch's OWN contact (`messages.conversation_id` → `conversations.contact_id` equal to the touch's `contact_id`, within the touch's organization) and that Phase 04 already stored (oldest first; decided touches, retries not yet due, contacts whose advisory lock is held by a session of THIS database, touches held back by the first-touch policy and touches of organizations that staff management holds exclusively are left out, the last by `FOR KEY SHARE ... SKIP LOCKED` on the organization row inside the scan statement itself, held only until the scan's own transaction ends and never across the per-candidate transactions), each handled in its own transaction under the contract lock order (organization `KEY SHARE`, a TRIED contact advisory lock, contact, open lead, touch, decision, history; no row lock is waited for) with its eligibility re-read under those locks. The fallible work runs in a savepoint inside that transaction: a recoverable failure is rolled back to the savepoint and its RETRY or PARKED row is written in the same transaction while the contact lock taken before the savepoint is still held, so no other reconciler can judge the touch in between. The attempt observes the touch's state before the work; after an ambiguous COMMIT (a lost acknowledgement) the fallback records a failure only if the committed state still equals the observed one, so one failure consumes at most one attempt. The run budget and batch size admit work (before every scan, page and candidate) and are not a deadline. Every statement runs under PostgreSQL's own lock and statement timeouts, set per transaction. It links a touch to an open lead at once or creates exactly one lead that names the touch (the database derives the cycle start), records skips as terminal decisions and failures as RETRY/PARKED, with the freshness anchor (the first-consideration time from the database clock, read while the contact is held) stored with the first failure. It is not exported from `@/modules/leads`; the only entry point is the opt-in command `npm run leads:reconcile` (`scripts/leads-reconcile.ts`), which runs one pass and prints counts. It imports no other module, has no network code and no scheduler, and is not production-ready (blocker 67). See [ADR 0016](adr/0016-leads-and-ad-attribution.md) and the runbook, section 9.

## Planned modules (not created yet)

a Meta Graph client (outbound sends, media download), messaging (single outbound service and compliance guard), leads, bots (runtime, versions), campaigns, audit. (Webhook intake, signature check, the queue, the inbound handlers and the operator tools already exist inside `whatsapp`; contacts, conversations and messages are written by its handlers but have no service or UI layer yet.) Registrations, payments, attendance later.

## Rules

- Outbound WhatsApp: only through the messaging service and compliance guard.
- Webhooks: verify signature, store the event, acknowledge fast, process asynchronously and idempotently (see WHATSAPP_INTEGRATION.md).
- Configuration is validated by the module that needs it, when it is implemented. There is no global env schema.
- Database access: standard PostgreSQL through Drizzle, no provider-specific coupling; hosting provider TBD (see DATABASE_DESIGN.md).

## Observability

Structured JSON logs with correlation ids (`request_id`, `organization_id`, `whatsapp_account_id`, `conversation_id`, `message_id`, `webhook_event_id`, `bot_session_id`). Never log secrets or unnecessary message content. `AppError` (`code`, `httpStatus`, `cause`) is the base error, enough to hook up Sentry later.
