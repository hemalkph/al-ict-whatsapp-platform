# Database Design

Status: Phase 02 schema is implemented and tested (migration `0000`). Phase 03 adds the authentication/authorization tables (migration `0001`). Phase 04 checkpoint 1 adds migration `0002` (webhook raw bodies, BSUID identity), **validated on disposable PostgreSQL 17 databases, never applied to the developer database**. Conventions: [ADR 0011](adr/0011-database-foundation-conventions.md); auth: [ADR 0012](adr/0012-authentication-and-authorization.md).

## Direction

Next.js → Drizzle ORM (node-postgres, isolated in `src/db/client.ts`) → standard PostgreSQL via `DATABASE_URL`. Production hosting provider: **TBD** in the database/deployment milestone (candidates include Supabase PostgreSQL and Neon PostgreSQL; neither is selected). This milestone uses local PostgreSQL (Docker) and a GitHub Actions PostgreSQL service only. The schema is provider-neutral.

## Layout

`src/db/schema/*` (tables and `enums.ts`), `src/db/client.ts` (lazy `getDb()`; nothing connects or reads `DATABASE_URL` until called), `src/db/migrations/` (generated SQL, committed). Scripts: `db:generate`, `db:migrate`, `db:check` (drizzle-kit). `db:push` is not used. The migration file is generated from the schema; to confirm there is no drift, `db:generate` must report "No schema changes, nothing to migrate".

## Data-layer operations

`src/db/ops/` holds the small, transaction-aware SQL primitives whose correctness the schema depends on: message status transitions, conversation activity timestamps, marketing-consent cache, and the webhook queue claim. They take an executor (database or transaction) so callers own transaction boundaries. Application modules use them through `@/db`; they never import `pg`.

## Tables in Phase 02

(Phase 04 migration `0002` adds `contact_bsuids`, see below; migration `0003` adds a partial unique index on `lead_attributions (organization_id, message_id) WHERE message_id IS NOT NULL`, so a message has at most one attribution row.) organizations, whatsapp_accounts, webhook_requests, webhook_events, contacts, contact_consents, conversations, messages, message_status_events, message_attachments, leads, lead_attributions, tags, contact_tags.

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

## Phase 05 schema changes (migration `0004`, additive; 25 tables in total)

- **`whatsapp_templates`:** a local registry of templates an operator attests are approved in Meta (`PENDING_ATTESTATION | APPROVED | DISABLED`), unique per `(organization, account, name, language)`; name charset CHECK; nothing here is verified with Meta.
- **`outbound_requests`:** one row per send request. Composite organization-aware FKs to the account, the conversation, the pre-created OUTBOUND `messages` row, the requesting membership and (for templates) the template. `UNIQUE (organization, account, membership, idempotency_key)` and `UNIQUE (organization, message_id)`; CHECKs for the lifecycle (which columns must be set in which state), the template/text split, code lengths, key shape and fingerprint (`^[0-9a-f]{64}$`). Holds a recipient _kind and id_ snapshot, never a token (`credential_ref` is only a name).
- **`outbound_requests_guard()` trigger (hand-written in 0004):** `BEFORE UPDATE`; immutable request columns, and only legal transitions (`QUEUED → SENDING|HELD`, `SENDING → QUEUED|ACCEPTED|REJECTED|UNKNOWN_OUTCOME|HELD`); terminal states cannot change. This is what makes "an unknown outcome is never retried" a database fact, not only application code.
- `messages` gets no new columns: the OUTBOUND row is created at request time with `wamid NULL` and `client_request_id = request id`; acceptance sets the wamid.

## Phase 06 schema changes (migration `0005`, additive; 29 tables in total)

- **`conversations`:** `assigned_membership_id` (composite FK to `organization_memberships (organization_id, id)`) and `assigned_at`; CHECK that both are set or both null. One current assignee or none. A later suspension does not clear it. New indexes: `conversations_org_activity_idx` (org, last_message_at DESC, id DESC) for the all/unassigned views and `conversations_assignee_idx` (partial, assigned rows) for "assigned to me".
- **`conversation_events`:** append-only history of ASSIGNMENT and STATUS changes (actor, from/to assignee, from/to status). CHECKs for the kind, the status values and the shape per kind; composite FKs to the conversation and to every membership it names; trigger `staff_inbox_append_only` forbids UPDATE and DELETE.
- **`conversation_notes`:** append-only internal notes (author membership, body 1-4000, non-blank); same trigger; never a message.
- **`quick_replies`:** reusable staff text (title 1-60, body 1-1000); `title_key` generated by PostgreSQL (`lower(btrim(title))`); unique among ACTIVE rows per organization (partial index), archived rows are kept.
- **`message_reads`:** per-staff seen state, primary key (organization, membership, message), composite FKs to the membership and the message. A message-level set, not a timestamp watermark (ADR 0015).
- **`messages`:** one new partial index `messages_inbound_conversation_idx` (inbound rows only) for unread counts and the Unread filter. No column changes; message and timestamp semantics are untouched.
- `tags` and `contact_tags` are reused unchanged. Migration 0005 was validated on disposable PostgreSQL 17 test databases (fresh and as an upgrade from 0000-0004). It has since been applied, by the developer, to the local persistent development database; it has never been applied to a production database (see "Where the migrations have been applied").

## Phase 07 schema changes, checkpoint 07A (migration `0006`, additive; 31 tables in total)

The database foundation for leads and ad attribution (ADR 0016). No service, route, reconciler or page exists yet.

- **`leads`:** four columns. `revision` (optimistic-concurrency token: 0 at INSERT, +1 with every status change and never otherwise), `closed_at` (start of the current closed period; NULL while open), `cycle_started_at` (start of the current inquiry cycle) and `initiating_attribution_id` (the confirmed Meta ad referral an automatic lead was created from; given only by the INSERT, immutable, with a composite FK to a touch of the same contact). CHECKs: `revision >= 0`, `closed_at` set exactly while the status is a closed one, `closed_at >= cycle_started_at`. An INSERT trigger refuses a revision other than 0 and, for a lead that names an initiating touch, requires a META_AD touch with a message that is not linked yet and sets `cycle_started_at` to that touch's receipt time. A second trigger enforces the transitions (revision, `closed_at` stable while closed, `cycle_started_at` moving only on a reopen, a lead never changing contact, organization or origin). New indexes: the partial unique `leads_org_contact_open_uidx` (**one open lead per contact**) and `leads_org_created_idx` (newest first).
- **`lead_events`:** append-only history (CREATED, STATUS, TOUCH_LINKED) with shape CHECKs, composite FKs to the lead (with its contact), the acting membership and the attribution touch (with its contact), and partial unique indexes (one CREATED per lead, a touch creates at most one lead, one TOUCH_LINKED per touch, one STATUS per revision).
- **`lead_reconcile_decisions`:** one durable outcome per attribution touch for the future reconciler (four terminal skips, RETRY, PARKED), with shape CHECKs, a composite FK to the touch (same organization and contact) and a partial index of due retries. A guard trigger locks the touch on every write: a decision exists only for an unlinked touch; terminal rows are final; a RETRY row is deleted only once its touch is linked (so attempts cannot be reset), its attempts never decrease, and a newly assigned retry time must be in the future by the database clock.
- **`lead_attributions`:** no column changes. A unique constraint `(organization_id, id, contact_id)` (FK target) and the partial index `lead_attributions_unlinked_ad_idx` (candidates for automatic handling). A guard trigger makes the evidence immutable: inserted unlinked, never deleted, nothing changed except `lead_id` once, and a link accepted only for a confirmed Meta ad referral with a message, without a terminal decision, to an open lead of the same contact whose cycle it does not predate (for the lead's own initiating touch, recorded in `leads.initiating_attribution_id`, only the receipt time is compared; no history event can grant that exception).
- **Deferred constraint triggers** make a link commit only with its TOUCH_LINKED event and with no reconcile decision left for the touch, a status change only with its STATUS event, and a lead created by an ad referral only with its CREATED event and its initiating touch linked.
- **Upgrade:** the migration refuses atomically (SQLSTATE 23505) when a contact has more than one open lead and never resolves that itself; existing leads get `revision` 0, `closed_at` from `status_changed_at` when closed, `cycle_started_at` from their creation and no initiating touch; nothing else changes and no history is invented. Validated on disposable PostgreSQL 17 test databases only (fresh, and as an upgrade from 0000-0005 with data); **not applied to the local development database or to any production database.**

## Where the migrations have been applied

Three kinds of database are involved, and they are in different states. "Validated" in this document always means kind B.

| Kind                                                                                      | Migrations applied                                                | Who applies them                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Local persistent development database (`al_ict_whatsapp`, the local Docker PostgreSQL) | `0000`-`0005`. **`0006` is not applied.**                         | The developer, by hand (`npm run db:migrate`), when they decide to. No test and no project script migrates it. State as last observed during checkpoint 07A. |
| B. Disposable test databases (`al_ict_test_*`)                                            | Every committed migration and the uncommitted `0006`, on each run | `npm run test:db` creates, migrates and drops them; nothing in them persists.                                                                                |
| C. Production databases                                                                   | None                                                              | No production database exists yet. No migration of this project has ever been applied to one.                                                                |

A migration that has been applied to kind A or C must never be edited afterwards (a new migration is written instead). `0006` could still be corrected in place after its database review because it had been applied only to kind B.

## Principles

Paginated, indexed queries; no N+1. Media goes in object storage, never in PostgreSQL BLOBs (object storage is not integrated yet). PII (phone numbers, profile names, message bodies, raw webhook payloads) is minimized, masked in logs, and subject to retention/erasure policy that is decided later.

## Deferred (not yet in the schema)

conversation assignment, internal notes, quick replies and templates, bots, campaigns, offerings/programs, students, batches, payments, attendance, audit logs. Cloudflare R2 remains a future media-storage candidate. Authentication is decided in ADR 0012.

## Decided: roles and permissions

Fixed roles (ADMIN, STAFF, VIEWER) stored on the membership with the permission matrix defined in application code (see ADR 0012). Relational roles/permissions and per-user overrides are not used.

## Open decision: assignment history

Options: explicit assignment-history records, audit-log events, or a combination. Decided in the database milestone.
