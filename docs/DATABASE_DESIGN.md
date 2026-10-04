# Database Design

Status: Phase 02 schema is implemented and tested (migration `0000`). Phase 03 adds the authentication/authorization tables (migration `0001`, generated and under review, not yet applied). Conventions: [ADR 0011](adr/0011-database-foundation-conventions.md); auth: [ADR 0012](adr/0012-authentication-and-authorization.md).

## Direction

Next.js → Drizzle ORM (node-postgres, isolated in `src/db/client.ts`) → standard PostgreSQL via `DATABASE_URL`. Production hosting provider: **TBD** in the database/deployment milestone (candidates include Supabase PostgreSQL and Neon PostgreSQL; neither is selected). This milestone uses local PostgreSQL (Docker) and a GitHub Actions PostgreSQL service only. The schema is provider-neutral.

## Layout

`src/db/schema/*` (tables and `enums.ts`), `src/db/client.ts` (lazy `getDb()`; nothing connects or reads `DATABASE_URL` until called), `src/db/migrations/` (generated SQL, committed). Scripts: `db:generate`, `db:migrate`, `db:check` (drizzle-kit). `db:push` is not used. The migration file is generated from the schema; to confirm there is no drift, `db:generate` must report "No schema changes, nothing to migrate".

## Data-layer operations

`src/db/ops/` holds the small, transaction-aware SQL primitives whose correctness the schema depends on: message status transitions, conversation activity timestamps, marketing-consent cache, and the webhook queue claim. They take an executor (database or transaction) so callers own transaction boundaries. Application modules use them through `@/db`; they never import `pg`.

## Tables in Phase 02

organizations, whatsapp_accounts, webhook_requests, webhook_events, contacts, contact_consents, conversations, messages, message_status_events, message_attachments, leads, lead_attributions, tags, contact_tags.

Everything tenant-owned carries `organization_id` with composite organization-aware foreign keys; `webhook_events` routing columns are nullable until resolved. No Meta credential is ever stored in a column (`whatsapp_accounts.credential_ref` is only a pointer to server-side configuration).

## Tables in Phase 03 (authentication and access)

- **Better Auth-owned** (`src/db/schema/auth.ts`; shape dictated by the library, regenerate-and-diff on upgrade): `users`, `sessions`, `accounts`, `verifications`, `rate_limits`.
- **Application-owned** (`src/db/schema/access.ts`): `organization_memberships` (roles ADMIN/STAFF/VIEWER, statuses ACTIVE/SUSPENDED), `user_security_state` (global `password_change_required`), `staff_provisioning_intents` (short-lived provisioning coordinator; no credentials).

Users are global identities; memberships are organization-specific; a user without an ACTIVE membership has no application access. The Drizzle adapter must be wired with `transaction: true` and an explicit schema mapping (see the header of `auth.ts` and ADR 0012).

## Principles

Paginated, indexed queries; no N+1. Media goes in object storage, never in PostgreSQL BLOBs (object storage is not integrated yet). PII (phone numbers, profile names, message bodies, raw webhook payloads) is minimized, masked in logs, and subject to retention/erasure policy that is decided later.

## Deferred (not yet in the schema)

conversation assignment, internal notes, quick replies and templates, bots, campaigns, offerings/programs, students, batches, payments, attendance, audit logs. Cloudflare R2 remains a future media-storage candidate. Authentication is decided in ADR 0012.

## Decided: roles and permissions

Fixed roles (ADMIN, STAFF, VIEWER) stored on the membership with the permission matrix defined in application code (see ADR 0012). Relational roles/permissions and per-user overrides are not used.

## Open decision: assignment history

Options: explicit assignment-history records, audit-log events, or a combination. Decided in the database milestone.
