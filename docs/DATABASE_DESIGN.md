# Database Design

Status: Phase 02 schema is implemented and tested (migration `0000`). Phase 03 adds the authentication/authorization tables (migration `0001`). Phase 04 checkpoint 1 adds migration `0002` (webhook raw bodies, BSUID identity), **validated on disposable PostgreSQL 17 databases, never applied to the developer database**. Conventions: [ADR 0011](adr/0011-database-foundation-conventions.md); auth: [ADR 0012](adr/0012-authentication-and-authorization.md).

## Direction

Next.js → Drizzle ORM (node-postgres, isolated in `src/db/client.ts`) → standard PostgreSQL via `DATABASE_URL`. Production hosting provider: **TBD** in the database/deployment milestone (candidates include Supabase PostgreSQL and Neon PostgreSQL; neither is selected). This milestone uses local PostgreSQL (Docker) and a GitHub Actions PostgreSQL service only. The schema is provider-neutral.

## Layout

`src/db/schema/*` (tables and `enums.ts`), `src/db/client.ts` (lazy `getDb()`; nothing connects or reads `DATABASE_URL` until called), `src/db/migrations/` (generated SQL, committed). Scripts: `db:generate`, `db:migrate`, `db:check` (drizzle-kit). `db:push` is not used. The migration file is generated from the schema; to confirm there is no drift, `db:generate` must report "No schema changes, nothing to migrate".

## Data-layer operations

`src/db/ops/` holds the small, transaction-aware SQL primitives whose correctness the schema depends on: message status transitions, conversation activity timestamps, marketing-consent cache, and the webhook queue claim. They take an executor (database or transaction) so callers own transaction boundaries. Application modules use them through `@/db`; they never import `pg`.

## Tables in Phase 02

(Phase 04 migration `0002` adds `contact_bsuids`, see below.) organizations, whatsapp_accounts, webhook_requests, webhook_events, contacts, contact_consents, conversations, messages, message_status_events, message_attachments, leads, lead_attributions, tags, contact_tags.

Everything tenant-owned carries `organization_id` with composite organization-aware foreign keys; `webhook_events` routing columns are nullable until resolved. No Meta credential is ever stored in a column (`whatsapp_accounts.credential_ref` is only a pointer to server-side configuration).

## Tables in Phase 03 (authentication and access)

- **Better Auth-owned** (`src/db/schema/auth.ts`; shape dictated by the library, regenerate-and-diff on upgrade): `users`, `sessions`, `accounts`, `verifications`, `rate_limits`.
- **Application-owned** (`src/db/schema/access.ts`): `organization_memberships` (roles ADMIN/STAFF/VIEWER, statuses ACTIVE/SUSPENDED), `user_security_state` (global `password_change_required`), `staff_provisioning_intents` (short-lived provisioning coordinator; no credentials).

Users are global identities; memberships are organization-specific; a user without an ACTIVE membership has no application access. The Drizzle adapter must be wired with `transaction: true` and an explicit schema mapping (see the header of `auth.ts` and ADR 0012).

## Phase 04 schema changes (migration `0002`)

Reasons and decisions: [ADR 0013](adr/0013-whatsapp-webhook-ingestion.md); evidence: [WHATSAPP_G0_EVIDENCE.md](WHATSAPP_G0_EVIDENCE.md).

- **`webhook_requests`:** `raw_payload jsonb` is replaced by `raw_body bytea NOT NULL`, the exact received bytes (jsonb is not the wire body and rejects `\u0000`). `payload_sha256` is kept: lowercase hex SHA-256 of `raw_body` (CHECK `^[0-9a-f]{64}$`), not unique. New `ingest_status` (`ACCEPTED` | `UNPARSEABLE` | `UNSUPPORTED_SHAPE` | `EVENTS_REJECTED`, default `ACCEPTED`) and `ingest_error_code` (short fixed code, 1 to 64 characters, `NULL` exactly when `ACCEPTED`), plus a partial index on non-ACCEPTED rows. Only signature-verified deliveries are ever stored. The table has no writers yet, so the migration (`ADD COLUMN raw_body ... NOT NULL`, no backfill) assumes it is empty: it **must be deployed before any real webhook data exists** and fails safely and atomically otherwise (tested; see ADR 0013).
- **`contacts`:** `wa_id` is now nullable (a user known only by BSUID); `UNIQUE (organization_id, wa_id)` is unchanged. New `username` (untrusted display text). There is no `contacts.bsuid`.
- **`contact_bsuids` (new, 23 tables in total):** every BSUID ever seen for a contact, current or retired. `UNIQUE (organization_id, bsuid)`; composite organization-aware FK to `contacts`; `retired_at`; ordering CHECKs; index for contact lookup. **No "one current alias per contact" unique index**: Meta does not document whether an old BSUID stays valid after regeneration. `UNIQUE (organization_id, bsuid)` is correct only while one organization = one Meta Business Portfolio (onboarding invariant). `source_webhook_event_id` is provenance only: `ON DELETE SET NULL` to `webhook_events(id)`, so it never blocks pruning old events. A contact must have a `wa_id` or at least one `contact_bsuids` row; the database cannot express that across tables, so it is enforced by the single contact-creation code path, a database test and an operator tripwire query.
- **Known limitation:** `UNIQUE (organization_id, bsuid)` stops a second alias row but not an `UPDATE contact_bsuids SET contact_id = ...` that re-points an existing alias to another contact of the same organization (the composite FK still blocks other organizations). The resolver must never re-point an alias (conflicts fail closed); a trigger could enforce it later.
- **Retention note:** the Phase 02 provenance FKs `messages.source_webhook_event_id` and `message_status_events.webhook_event_id` are composite `NO ACTION`: a retention job must null them before deleting events (unchanged). `webhook_events` held for an inactive account (`UNROUTABLE`) must be exempt from pruning.
- **Constants only (no SQL):** `WEBHOOK_EVENT_TYPES` gains `IDENTITY`, `MESSAGE_TYPES` gains `REACTION`, new `INGEST_STATUSES`.

## Principles

Paginated, indexed queries; no N+1. Media goes in object storage, never in PostgreSQL BLOBs (object storage is not integrated yet). PII (phone numbers, profile names, message bodies, raw webhook payloads) is minimized, masked in logs, and subject to retention/erasure policy that is decided later.

## Deferred (not yet in the schema)

conversation assignment, internal notes, quick replies and templates, bots, campaigns, offerings/programs, students, batches, payments, attendance, audit logs. Cloudflare R2 remains a future media-storage candidate. Authentication is decided in ADR 0012.

## Decided: roles and permissions

Fixed roles (ADMIN, STAFF, VIEWER) stored on the membership with the permission matrix defined in application code (see ADR 0012). Relational roles/permissions and per-user overrides are not used.

## Open decision: assignment history

Options: explicit assignment-history records, audit-log events, or a combination. Decided in the database milestone.
