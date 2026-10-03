# Database Design

Status: **design notes only. No schema exists yet.** Decisions marked "open" are made in the database/security milestone.

## Direction

Next.js → Drizzle ORM → standard PostgreSQL. Production hosting provider: **TBD** during the database/deployment milestone (candidates include Supabase PostgreSQL and Neon PostgreSQL). The data layer stays provider-neutral.

| Item                       | Status                                    |
| -------------------------- | ----------------------------------------- |
| Production PostgreSQL host | TBD (Supabase / Neon candidates)          |
| Realtime for inbox         | Later evaluation (e.g. Supabase Realtime) |
| Better Auth                | Provisional                               |
| Cloudflare R2              | Future media storage candidate            |
| Local PostgreSQL (Docker)  | Optional for development                  |

Use connection pooling suitable for a serverless/pooled Postgres. Media goes in object storage, never in PostgreSQL BLOBs.

## Principles

Important records carry `organization_id`. Paginated, indexed queries; no N+1. Do not create a table per concept without need; each entity is evaluated below.

## Entity evaluation (leanings, not decided)

| Entity                            | Leaning                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| organizations, users, memberships | Separate tables.                                                                           |
| roles/permissions                 | **Open.** See options below.                                                               |
| whatsapp_accounts                 | Separate table (WABA id, phone number id; multiple later).                                 |
| contacts                          | Separate table.                                                                            |
| contact_consents                  | Append-only history (consent source and timestamps, opt-out); needed for compliance audit. |
| leads                             | Separate table; lifecycle states extensible, not hardcoded in UI.                          |
| lead_sources / ad_referrals       | Possibly one attribution table.                                                            |
| students                          | Separate table, created on conversion.                                                     |
| conversations                     | Separate table; current assignee likely a column.                                          |
| conversation_assignments          | **Open.** See options below.                                                               |
| messages                          | Separate; the highest-volume table.                                                        |
| message_status_events             | Append-only events (sent/delivered/read/failed).                                           |
| message_attachments               | Separate; stores object-storage references.                                                |
| internal_notes                    | Separate.                                                                                  |
| tags, contact_tags                | Separate with a join table.                                                                |
| quick_replies, message_templates  | Separate.                                                                                  |
| webhook_events                    | Separate; the webhook inbox (idempotency keys, processing state).                          |
| bots, bot_versions                | Separate; versions immutable once published.                                               |
| bot_flows                         | Likely folded into the bot_versions definition (JSON).                                     |
| bot_sessions, bot_execution_logs  | Separate.                                                                                  |
| campaigns, campaign_recipients    | Separate.                                                                                  |
| audit_logs                        | Separate, append-only.                                                                     |

## Open decision: roles and permissions

- **A. Fixed membership role enum.** Simplest; changing role capabilities needs a deploy.
- **B. Relational roles + permissions.** Most flexible; more tables and admin UI.
- **C. Fixed roles with permission overrides.** Sensible defaults with per-member exceptions.
  Decided in the database/security milestone. No ADR yet.

## Open decision: assignment history

Options: explicit assignment-history records, audit-log events, or a combination. Decided in the database milestone.
