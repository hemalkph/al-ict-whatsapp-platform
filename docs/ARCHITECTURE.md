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

## Planned modules (not created yet)

identity (users, memberships, authz), whatsapp (Meta client, webhook intake, signature check), messaging (single outbound service and compliance guard), contacts, conversations, leads, bots (runtime, versions), campaigns, audit. Registrations, payments, attendance later.

## Rules

- Outbound WhatsApp: only through the messaging service and compliance guard.
- Webhooks: verify signature, store the event, acknowledge fast, process asynchronously and idempotently (see WHATSAPP_INTEGRATION.md).
- Configuration is validated by the module that needs it, when it is implemented. There is no global env schema.
- Database access: standard PostgreSQL through Drizzle, no provider-specific coupling; hosting provider TBD (see DATABASE_DESIGN.md).

## Observability

Structured JSON logs with correlation ids (`request_id`, `organization_id`, `whatsapp_account_id`, `conversation_id`, `message_id`, `webhook_event_id`, `bot_session_id`). Never log secrets or unnecessary message content. `AppError` (`code`, `httpStatus`, `cause`) is the base error, enough to hook up Sentry later.
