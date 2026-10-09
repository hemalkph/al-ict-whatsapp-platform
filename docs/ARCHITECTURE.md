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

`src/proxy.ts` (optimistic cookie check), `/api/auth/[...all]` (public Better Auth instance), `/api/account/change-password`, pages `/login`, `/change-password` and the authenticated group `(app)` (landing at `/`). Operator CLIs live in `scripts/`: the auth ones call `@/modules/access/operator`, the WhatsApp ones call `@/modules/whatsapp/operator` (accounts, held and DEAD events, health) and `@/modules/whatsapp/worker` (the opt-in worker, `scripts/whatsapp-worker.ts`). The webhook endpoint is `/api/webhooks/whatsapp` (excluded from the proxy).

## Planned modules (not created yet)

a Meta Graph client (outbound sends, media download), messaging (single outbound service and compliance guard), conversation / inbox services and UI, leads, bots (runtime, versions), campaigns, audit. (Webhook intake, signature check, the queue, the inbound handlers and the operator tools already exist inside `whatsapp`; contacts, conversations and messages are written by its handlers but have no service or UI layer yet.) Registrations, payments, attendance later.

## Rules

- Outbound WhatsApp: only through the messaging service and compliance guard.
- Webhooks: verify signature, store the event, acknowledge fast, process asynchronously and idempotently (see WHATSAPP_INTEGRATION.md).
- Configuration is validated by the module that needs it, when it is implemented. There is no global env schema.
- Database access: standard PostgreSQL through Drizzle, no provider-specific coupling; hosting provider TBD (see DATABASE_DESIGN.md).

## Observability

Structured JSON logs with correlation ids (`request_id`, `organization_id`, `whatsapp_account_id`, `conversation_id`, `message_id`, `webhook_event_id`, `bot_session_id`). Never log secrets or unnecessary message content. `AppError` (`code`, `httpStatus`, `cause`) is the base error, enough to hook up Sentry later.
