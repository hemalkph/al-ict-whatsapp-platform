# A/L ICT WhatsApp Platform — Project Context

Prepared 2026-10-09 (Asia/Colombo) from the full retrieved history of **WhatsApp API Setup**, conversation `6abe7692-84cc-83e8-9e9d-18f3fb65643c`, and its available pasted-text attachments. This is a development handoff, not evidence of production readiness.

## 1. Read this first: exact handoff state

> **Status update added after this handoff was written (the text below is the historical handoff state, preserved).** Checkpoint 5A was later committed as `4bfe677` (`add opt-in WhatsApp webhook worker`). Work after it, an operator batch (account / held-event / DEAD-event / health commands, `docs/RUNBOOK_WHATSAPP.md`, a guard for the shared `getDb()` pool) and an independent-review correction batch (account-activation race fix, identifier-integrity validation, operator stdout/stderr contract, payload-reveal and disable semantics documentation), existed only as uncommitted working-tree changes when this note was written. Git state changes; always inspect `git log`, `git status` and CI locally instead of trusting any state recorded in this file. Where the text below says "current", "uncommitted" or "not yet committed", read it as "at the 5A handoff".

**Checkpoint 5A (historical handoff state): implemented and tested according to Claude's latest report; NOT YET COMMITTED OR PUSHED.** Review that working-tree change before authorizing another checkpoint. Do not assume a new GitHub CI run exists for it.

- A standalone, explicitly enabled WhatsApp webhook worker has been implemented. It is **disabled by default**, has not been deployed or supervised, and does not start automatically in the application or CI.
- Its registry contains exactly **MESSAGE and STATUS**. There is no IDENTITY handler and no OTHER no-op handler.
- The repository development database `al_ict_whatsapp` reportedly still has **zero tables**. Successful migration and database tests used disposable databases. Schema files and passing tests do not mean the development database has been initialized.
- Migrations reportedly end at **0002**. Checkpoints 2, 3, 4A, 4B, 4C and 5A did not require another migration.
- No outbound messaging, real Meta API calls, live number connection, production deployment, media downloader, shared inbox, bot engine, campaigns, or student/payment workflows have been completed in this history.
- Checkpoint 5A introduced a worker-specific mitigation for a Drizzle transaction-start connection leak. (Historical: at the 5A handoff the shared `getDb()` pool remained affected; the later operator batch applied the same guard and error handling to it.)
- The user explicitly requires agents to **stop for review and not stage, commit or push automatically**. Provide instructions for the user to perform Git actions after approval.

### Evidence labels used in this document

**Reported/tested:** a supplied Claude report says implementation or tests completed. These reports are the source of truth for historical progress, but this handoff author did not inspect the repository or rerun those tests.

**Conversation-confirmed:** user-supplied output or a later conversation milestone confirms an action. Where only a subsequent prompt says a checkpoint is committed/pushed/green, that is historical conversation evidence, not a fresh Git or GitHub inspection.

**Decision:** an agreed invariant or policy. It must be preserved even if an earlier plan proposed something different.

**Unverified/assumed:** not established by a live Meta observation, complete source evidence, or a repository inspection. Do not convert these into facts.

All 70 retrieved turns were considered, from initial product/API questions through the final context-transfer request. Seven available pasted-text attachments were read: revised Phase 04 plan, G0/schema report, ingress report, queue report, initial identity report, inbound report, and worker 5A report. Several older turns identify uploads whose contents are absent from the retrieved history; their detailed implementation is supported only by the subsequent reviews and summaries. Screenshot contents and the referenced demonstration video were not independently inspected for this handoff. There is no claimed access to `/Users/Projects/Class/al-ict-whatsapp-platform`.

## 2. Product intent and scope

Build an owned, secure internal WhatsApp platform for an **A/L ICT class and its team**. The user wants to handle incoming student inquiries, coordinate staff replies, and eventually connect Facebook/Instagram Click-to-WhatsApp ads to structured student registration and class operations.

The intended journey is **contact → lead → student**. These are distinct concepts: a person who messages is not automatically a lead, enrolled student, or marketing subscriber. WhatsApp is the communication layer around that journey.

The eventual product includes multiple business numbers, a shared inbox with staff assignment and OPEN/PENDING/RESOLVED conversations, contact profiles, tags and notes, quick replies, class/batch context, registration/payment-related communication, reminders, approved templates/campaigns, reporting, and a visual bot/automation studio. The user specifically emphasized step-by-step button interactions after an ad, the demonstration's bot studio, settings, and “anchor” behavior. Exact semantics of that provider's anchor feature were not established; do not invent a specification from that reference.

These are product goals, not a list of implemented features. Current development deliberately establishes data integrity, access control, webhook ingestion, identity resolution, message persistence and queue execution first. Avoid building a generic enterprise CRM or a complete bot/campaign/payment system in the next checkpoint.

Early discussion covered Meta test numbers, number verification, multiple numbers, business verification versus badges, direct Cloud API versus provider subscriptions, free tiers and messaging costs. Those were planning discussions. Pricing, free quotas, policy dates, number onboarding/coexistence, approval requirements and service-window billing must be reverified against current official Meta documentation before making operational or financial decisions. No historical price estimate here is a deployment guarantee.

## 3. Repository, local setup and stack

### Reported project identity

| Item | Historical evidence |
| --- | --- |
| Repository | `https://github.com/hemalkph/al-ict-whatsapp-platform.git` |
| Local project | `/Users/Projects/Class/al-ict-whatsapp-platform` |
| Old starting directory | `/Users/Projects/Class/WhatsApp API`, originally empty and not a Git repository; reported untouched after cloning the real repo |
| Branch | `main`, tracking `origin/main` |
| Foundation commit | `f66797c` — `establish project foundation`; user supplied successful push and clean status output |
| Current working tree | 5A modifications/untracked paths reported, uncommitted; exact current status and HEAD must be inspected locally |
| Development database | Local Docker PostgreSQL, database `al_ict_whatsapp`, reported zero tables through 5A |

The current context-writing chat has its own generated folder. It is not the WhatsApp repository. This file was created as a separate downloadable deliverable; no product source or Git state was modified.

### Architecture decisions

- **Next.js 16 App Router + TypeScript**, React frontend, Tailwind CSS and local shadcn/ui conventions. Next.js **16.3.8** is named in the later E2E abort investigation; check the lockfile before treating it as the current installed version.
- **Modular monolith**. Thin app routes/pages use public module entrypoints. Business rules live in modules; PostgreSQL access lives in `src/db`; shared errors, security and logging live in shared code.
- **PostgreSQL + Drizzle + node-postgres (`pg`)**, ordinary SQL and transaction-aware operations. Reported pins: `drizzle-orm 0.45.3`, `pg 8.23.1`, `drizzle-kit 0.31.11`. Do not upgrade them incidentally.
- **Better Auth 1.7.7** for staff authentication, database-backed sessions, credential management and supported password APIs. Application memberships/authorization are separate from the library's identity model.
- Approved auth configuration also pins `@better-auth/drizzle-adapter 1.7.7`, pg provider, explicit schema mapping, UUID ids, adapter transactions, password length 12–128, seven-day session expiry/one-day update age, and database-backed rate limiting. Public instance disables signup; private server-only instance allows controlled provisioning with autoSignIn false and is never mounted. No Admin or Organization plugin. Verify these against local configuration before upgrades.
- Node **24** in `.nvmrc`; initial environment report named Node **24.16 LTS** and npm **11.17**. Docker and Git were installed. Use repository-pinned tooling rather than inferring today's machine state.
- Vitest unit and real PostgreSQL integration tests; Playwright Chromium against the production build; ESLint, TypeScript and Prettier checks.
- PostgreSQL-backed webhook queue. **No Redis**, second queue, or hosted queue service is required by the current implementation.
- Database provider remains **neutral**. Neon and Supabase were candidates, not selected providers. Earlier recommendations to configure Supabase/Neon were superseded. No Supabase-specific code or confirmed hosted production DB exists in this history.
- Hosting/runtime remains undecided. Cloudflare compatibility was a goal, not a finalized Next.js deployment architecture. A long-running Node worker needs an explicit host and supervision decision.
- No realtime provider has been selected; polling/SSE/WebSockets/managed realtime were possible later choices.

### Reported repository map

```text
src/app/                         thin App Router pages and routes
  api/health/route.ts
  api/auth/                      restricted public Better Auth surface
  api/staff/                     five staff API routes
  api/webhooks/whatsapp/route.ts  public Meta webhook endpoint
src/proxy.ts                     optimistic session-cookie gate
src/modules/auth/                auth configuration/private provisioning
src/modules/access/              AccessContext, permissions, staff lifecycle
src/modules/whatsapp/
  __fixtures__/                  byte-preserved fake Meta fixtures
  identity/                      ordinary inbound contact resolver
  inbound/                       MESSAGE mapping and handler
  status/                        STATUS mapping and handler
  queue/                         claims, fencing, retries, requeue, stats
  worker/                        5A config, registry, loop and lifecycle
src/db/
  client.ts                      centralized pg/pool initialization
  schema/                        Drizzle schema
  ops/                           transaction-aware shared operations
  migrations/                    0000, 0001, 0002 plus snapshots/journal
  __tests__/                     constraints, migrations, helpers, pool tests
src/shared/                      errors, security, logging, canonical JSON
scripts/                         migration/test/auth/worker utilities
e2e/                             production-server harness and browser specs
docs/                            specifications, decisions and blocker register
.github/workflows/ci.yml         verify, database, e2e
```

This map combines report paths and established conventions; confirm actual filenames locally. Important documentation includes `MASTER_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_DESIGN.md`, `SECURITY.md`, `DEPLOYMENT.md`, `ROADMAP.md`, `TESTING_STRATEGY.md`, `WHATSAPP_INTEGRATION.md`, `PRE_PRODUCTION_BLOCKERS.md`, `WHATSAPP_G0_EVIDENCE.md`, and ADRs 0011 (database), 0012 (auth/access), 0013 (webhook ingestion). Read local `AGENTS.md` and `CLAUDE.md` before editing; their existence was reported, but their contents were not supplied here.

Environment is lazily validated when the relevant subsystem runs. Builds and database-free tests must not require real DB/auth/Meta settings. `.env.example` contains placeholders; real secrets stay out of Git. `DATABASE_URL` and optional `DATABASE_MIGRATION_URL` are provider-neutral. Tests use explicit local test-admin URLs, not production credentials. Do not run `db:push`, broadly approve install scripts, force audit fixes, or remove Docker volumes as a convenience.

## 4. Completed development history

The checkpoint numbering evolved. Phase 04's revised plan originally grouped identity and message work differently. The actual sequence is **G0/schema → ingress (2) → queue (3) → ordinary contact identity (4A) → inbound messages (4B) → statuses (4C) → standalone worker (5A)**. “Identity 4A” does not mean identity-change processing exists.

### Phase 01 / Checkpoint 01 — foundation

Reported implementation: scaffolded application shell and `/api/health`; minimal health module, shared AppError/logger, standard `cn` helper, Tailwind/shadcn setup, TypeScript/lint/format/test configuration, Docker Compose, CI, README and architecture/product/security/roadmap/ADR documentation. Health returns 200 with `{"status":"ok"}` and `Cache-Control: no-store`.

Cleanup removed network-dependent Google Font fetching so builds use a local/system baseline, corrected the unexpected `cn` package to the standard `clsx` + `tailwind-merge` helper, removed an unnecessary generated button and unnecessary path plugin, and used the official shadcn eject procedure. shadcn stopped being a direct dependency while required local CSS utilities were retained. Provider-specific database commitments were removed. No auth, DB schema or WhatsApp implementation existed at this point.

Five foundation tests and lint/typecheck/build passed. Production dependency audit became zero after cleanup/eject. Initial development-tooling findings were not a reason for a breaking downgrade. User-provided output confirms commit `f66797c`, push to `origin/main`, and a clean tree.

### Phase 02 / Checkpoint 02 — database foundation

Reported implementation: provider-neutral Drizzle/pg installation, centralized lazy client, schema, migration scripts and generated migration `0000_init_foundation_schema.sql`; SQL review before execution; migration from empty on disposable PostgreSQL **17.11**; real constraint and concurrency tests; database CI with migration drift detection.

The initial foundation had **14 tables**, not 22. Auth later brought it to 22; `contact_bsuids` brought it to 23. Known Phase 02 tables cover organizations, WhatsApp accounts, contacts, leads, conversations, messages, message attachments/status events, webhook requests/events, consent events, tags and lead attribution. Do not fabricate omitted exact table names; inspect the schema for the authoritative list.

Corrections before finalizing 0000:

- Composite tenant provenance FKs from messages/status history to `(organization_id, webhook_event_id)`. Unrouted events cannot be referenced as tenant domain provenance.
- Status-to-message FK includes organization, message and WhatsApp account.
- Attribution-to-lead FK includes organization, lead and contact.
- Nullable provenance references use **NO ACTION**, so retention must null references before deleting a referenced event.
- Lease index on `locked_at WHERE status='PROCESSING'` supports reclaim.
- Idempotency fallback hashes must include routing scope, especially `phone_number_id`.

Final reported 0000: 66 statements, 14 tables, **29 foreign keys** (an earlier 38 count was corrected), 18 unique constraints, 3 unique indexes, 20 other indexes and 14 CHECK constraints. PostgreSQL accepted it. Regeneration of the initial uncommitted migration was historical cleanup, not permission to rewrite committed migrations now.

Shared operations were added in `src/db/ops`: `message-status.ts`, `conversation-activity.ts`, `consent.ts`, `webhook-queue.ts`. Callers own transactions. Consent cache follows latest `occurred_at`, then `created_at`, then id; older observations do not override newer ones. Status observations are append-only and idempotent; cached priority is `NULL < SENT < FAILED < DELIVERED < READ`, including status-before-message reconciliation. These are reused later.

68 DB tests passed across four files, including SKIP LOCKED and status permutation/concurrency proofs. Database CI was locally simulated against a fresh Docker DB; drift detection was deliberately broken and shown to fail. A pg client error-listener/harness problem was subsequently fixed, with 30 repeated clean CI-mode runs reported. That harness correction did not establish broad production outage handling. Later conversation milestones treat Phase 02 as checkpointed and green.

### Phase 03 — auth/access and staff operations

This phase proceeded through several review gates, not one large implementation.

1. **Library installation/compatibility gate.** Better Auth pinned at 1.7.7; actual installed APIs, Drizzle adapter and transaction behavior verified before permanent schema design. `transaction: true` is required for user/credential creation. Public and private auth surfaces are separated; the private provisioner must never become HTTP-reachable.
2. **Schema/migration gate.** Migration 0001 added five library-owned auth tables and three application-owned tables: `organization_memberships`, `user_security_state`, `staff_provisioning_intents`. Total became 22. Application role/status rules remain independent of the global auth identity.
3. **Auth/access foundation.** DB sessions, cookie cache disabled, seven-day sliding sessions (no optional 30-day absolute cap), fresh ACTIVE membership/role lookup on every protected request, fixed ADMIN/STAFF/VIEWER permissions, forced-password-change gate, same-origin and redirect helpers, security-event logging and module boundaries.
4. **Staff lifecycle.** Admin-created staff, role changes, suspension/reactivation, password replacement and last-admin protection. Global identity takeover by another organization is refused. Provisioning is recoverable through an organization-owned globally unique normalized-email intent. Suspensions and session revocation have transaction-aware safety. No direct password-hash writes and no Better Auth Admin plugin.
5. **Password-reset hardening.** Replaced a shared per-user resolver Map with per-call `AsyncLocalStorage` capture `{userId, token?}`. Callback ownership is checked; missing context fails closed. Concurrent different-user resets cannot cross tokens; same-user resets leave one final valid new password. Failed reset leaves the force-change flag and revoked sessions in place, emits generic `PASSWORD_RESET_INCOMPLETE`, and leaves the unused library verification token to its 60-second expiry. Public request/reset endpoints remain closed; retry works. 214 DB tests passed ×12; 152 unit tests unchanged.
6. **Bootstrap/recovery and auth entrypoints.** Operator-only first-admin bootstrap and ownership-aware stale-intent inspection/recovery were reviewed as implemented; public login/logout, forced password change and protected app shell were approved. No public signup, organization signup, social auth or student login. A spawned-tsx cache/test isolation mitigation was stress-tested; the review noted inconsistent repeat counts in one report and did not treat them as exact evidence.
7. **Staff HTTP API.** Thin, session-authorized routes expose listing, creation, role change, suspension/reactivation and administrative reset behavior through the lifecycle services. Same-origin mutation checks, strict body validation, no mass assignment, safe DTOs and tenant-filtered target lookup. Missing/foreign valid UUIDs share 404; malformed UUIDs return 400. Self/last-admin conflicts return 409; stale/demoted/suspended actors get fresh 403. `application/json; charset=utf-8` acceptance was an explicit final check. 308 DB tests ×10 reported; no limiter yet on staff routes.
8. **Final real-browser proof and CI.** 36 Chromium tests against production build and disposable DB established login, cookie round-trip, forced change, session revocation, logout, hostile redirect rejection, staff roles and cross-origin denial. 193 unit and 308 DB tests reported. Added the third GitHub job, `e2e`. Later conversation states Phase 03 is complete and checkpointed.

Provisioning ordering is non-negotiable:

```text
acquire organization-owned globally unique email intent
→ Better Auth creates user + credential (adapter transaction enabled)
→ one application transaction locks/revalidates intent,
  reconciles auth_user_id, creates password_change_required security state,
  creates ACTIVE membership, then deletes intent
→ commit
```

A partial global user without ACTIVE membership has zero application access. Never create membership before the required security state in separate writes. Never blindly expire an intent: it may own a partially created global identity. Recovery CLI existence does not mean production monitoring or self-service recovery is complete.

The auth-core checkpoint documented missing `user_security_state` as password_change_required=false; this is not permission to omit that row in supported provisioning. Security state and ACTIVE membership must be created atomically. No PostgreSQL RLS was adopted in Phase 03: server-side AccessContext, scoped queries and composite tenant constraints are the established boundary, rather than a claim that RLS independently protects arbitrary SQL.

### Phase 04 — G0 evidence and schema / Checkpoint 1

G0 inspected official Meta documentation before allowing runtime assumptions. Initial report stopped before applying migration 0002; a subsequent authorized PostgreSQL validation completed the schema gate. H1 remained contradictory, so no identity-change handler was designed or implemented.

Fixtures: **41 files**, manifest and README; **22 OFFICIAL_EXAMPLE_DERIVED**, **19 SYNTHETIC_EDGE_CASE**, zero Dashboard-derived examples. All data fake, with Sinhala literal/escaped byte pairs, Tamil, NUL escapes, invalid UTF-8/JSON and identity shapes. Fixtures are excluded from Prettier and marked `-text` in `.gitattributes` to preserve bytes. Synthetic examples must keep their label.

Migration 0002 and final G0 uncertainties are described in sections 6 and 7. PostgreSQL validation reported **208 unit / 356 DB** tests; migration-from-empty, nonempty-table precondition and exact BYTEA preservation passed. No schema correction was needed. Schema checkpoint was reviewed for commit/push; E2E harness trouble was handled separately before continuing.

### Checkpoint 2 — webhook core and ingress

Reported/tested:

- `src/app/api/webhooks/whatsapp/route.ts` and public module entrypoint; lazy independent GET token/POST secret validation. `META_APP_SECRET` minimum 16 characters; `WHATSAPP_WEBHOOK_VERIFY_TOKEN` minimum 32. No sending token is read.
- GET requires `hub.mode=subscribe`, constant-time token comparison, printable ASCII challenge 1–256 characters. Success: exact challenge, text/plain, 200, no-store/nosniff. Invalid request: empty 403. Missing configuration: generic 500 naming only the missing key in logs.
- Streamed byte reader with **4 MiB** cap. Content-Length is only an early hint. Oversize: 413, no storage, `Connection: close` to prevent a stalled uploader retaining an open request.
- One HMAC-SHA256 over exact `Uint8Array` bytes; only `sha256=` + 64 lowercase hex accepted, with constant-time comparison. No transformed/re-escaped fallback.
- Authenticated invalid UTF-8/JSON is stored as `UNPARSEABLE` and acknowledged 200. Unsupported envelope: `UNSUPPORTED_SHAPE`, 200. Deterministic child normalization/insertion failure preserves the request as `EVENTS_REJECTED`, no surviving child events, 200. Transient/infrastructure errors roll everything back and return 500.
- Transaction inserts request, routing and normalized events; chunked inserts use savepoint + `ON CONFLICT (idempotency_key) DO NOTHING`. Duplicate requests may be retained while logical events remain unique.
- MESSAGE and STATUS normalization; system/non-messages fields become ignored OTHER; no IDENTITY emitted. Groups, played and unknown statuses ignored; malformed elements DEAD.
- Message/contact pairing by `from_user_id ↔ user_id`, otherwise `from ↔ wa_id`; never `contacts[0]`. Contradictory paired contact is discarded rather than used to guess identity.
- Route bypasses the optimistic proxy; look-alike paths stay protected. Signed cookie-less production-server E2E succeeds.

Keys: `wa:msg:v1:{scope}:{wamid}`; `wa:status:v1:{scope}:{wamid}:{status}:{timestamp}`; OTHER uses canonical-JSON SHA256. Scope is phone_number_id, otherwise `waba:{id}`, otherwise `none`. RFC 8785 canonicalizer is for event idempotency **only**, never signatures. Equivalent Unicode JSON representations can produce one event while requiring different byte signatures.

Reported ingress DB suite: **400 ×8**; E2E **44** with normal/jitter repetitions and oversize probes; all ordinary checks green. No new migration or dependency changes. Later checkpoint prompts state ingress committed/pushed and three CI jobs green.

### Checkpoint 3 — queue core, followed by tenant requeue correction

Built on Phase 02 operations: `processWebhookBatch(db, {handlers})`, explicit registry, queue policy/errors/timeout/stats and transaction-aware requeue. No standalone worker existed at this checkpoint.

- Due PENDING/FAILED and expired PROCESSING claims use ordered `FOR UPDATE SKIP LOCKED`; fresh **per-claim UUID** `locked_by`, lease time and incremented attempts. NULL PROCESSING lock time is reclaimable.
- Defaults: batch 20, concurrency 2; bounds 1–100 and 1–8. Each lane claims just before processing, rather than leasing a whole waiting batch.
- Lease 120 seconds, handler budget 60 seconds, statement timeout 15 seconds; budget must be shorter than lease. No heartbeat.
- Maximum **eight handler executions** across retries/crashes. Exhausted/crashed rows can become DEAD without a ninth handler execution. Attempts mean claims; hold/ignore account gates restore the increment.
- Transient retry delays after attempts 1–7: 30 seconds, 1, 2, 4, 8, 16, 32 minutes, ±20% jitter. PermanentWebhookError causes immediate DEAD; unknown exceptions and infrastructure errors are transient. Do not revive an earlier plan that classified all FK/CHECK errors as permanent.
- Handler domain writes and fenced PROCESSED transition share one transaction. All transitions compare event id, PROCESSING and claim UUID. Lease loss cannot overwrite the new owner or commit stale domain writes.
- Unregistered event types are not claimed. Unsupported types must not be “handled” by a no-op.
- Account state is rechecked before domain work. ACTIVE proceeds; PENDING holds; DISABLED/archived ignores; missing routing is DEAD. Routing stays attached once assigned.

**Initial requeue design was rejected.** It looked up the current phone-number owner and reassigned historical routing; PENDING holds also cleared routing. That could transfer old tenant history when a number changed ownership. Final hardening replaced it:

1. `requeueRoutedHeldEvents({whatsappAccountId,reasons,receivedAfter})` locks that exact ACTIVE, unarchived account; requires original event organization/account and stored phone/WABA to match; never changes routing. Ownership mismatch refuses the call.
2. `requeueUnroutedEvent({webhookEventId,targetWhatsappAccountId,receivedAfter})` is explicit, per-event operator assignment for genuinely unrouted history. Target, phone, WABA and confirmed age are checked; already-routed events cannot move.
3. `requeueOnAccountActivation({whatsappAccountId})` releases only **already-routed account_pending** rows from the last 30 days, counts older stale holds, and does not automatically release unknown-account history. WABA mismatch stays unrouted and explicit-only. Disabled/archived releases require explicit same-account operations; reactivation by itself runs no requeue.

The account ownership composite FK blocks organization changes when history exists. Direct SQL can still repoint an account with no history; onboarding policy must govern that. No ownership trigger was added. No production account-mutating script existed at this checkpoint.

Final corrected report: **473 unit, 498 DB ×12, 44 E2E plus five repeats**, with 43 requeue DB tests. Mutation proofs catch rehoming, moving routed events and ignoring stored phone/WABA. Later history treats corrected Checkpoint 3 as checkpointed/green.

### Checkpoint 4A — ordinary inbound contact identity, then safe-policy correction

`resolveInboundContact(tx,event,{observedAt})` operates only in the caller's READ COMMITTED transaction. Tenant comes only from the trusted event row. It takes sorted transaction-scoped advisory locks per org/BSUID and org/phone, with unique constraints and conflict re-resolution as the second layer.

**The initial report's legacy-link policy is superseded.** Unknown BSUID + existing legacy phone no longer adds an alias to the old contact. `linkedLegacy` and `webhook.contact_identity_linked` were removed.

Final policy:

| Observation | Outcome |
| --- | --- |
| Known current or retired org-scoped BSUID alias | Original contact; retired alias remains byte-identical and is not promoted/reactivated |
| Unknown BSUID, phone unowned | New contact and alias, phone when safe, consent UNKNOWN |
| Unknown BSUID, phone owned by legacy or BSUID contact | Separate BSUID contact with wa_id NULL; existing contact unchanged; safe conflict code |
| Phone-only, owner has no aliases | Resolve legacy contact, explicitly uncertain continuity |
| Phone-only, owner has any current/retired alias | Permanent `phone_only_identity_ambiguous`; DEAD; no writes |
| Phone-only, no owner | New phone-only contact; not BSUID-verified |

Aliases are authoritative. A phone number alone does not prove continuity. Prefer duplicate contacts to exposing another person's history. No automatic merge, reassignment, phone history, wa_id rewrite or identity-change processing. A new alias can be inserted only for a contact created in the same resolver call. Unknown BSUIDs sharing a phone stay separate.

Safe conflict codes include `legacy_phone_ownership_unverified`, `phone_held_by_bsuid_contact`, `phone_owned_by_other_contact`, `phone_differs_from_contact`, `phone_only_identity_ambiguous`. Names/usernames are display data, never identity. Paired profile values are sanitized/NFC-normalized, whitespace-collapsed, capped (name 200, username 100 code points), and cannot erase newer data with older observations; Sinhala/Tamil joiners are preserved. Parent BSUIDs ignored. Archived contacts stay archived.

Alias owner/BSUID/retirement fields are not rewritten or deleted by this resolver. Retired aliases resolve but are unchanged. Concurrency/rollback/tenant tests and static guards enforce this; DB constraints alone do not prevent same-org alias reassignment.

Final correction report: **496 unit, 551 DB ×12, 44 E2E plus four repeats**; mutations restoring unsafe legacy linking and phone-only attachment were caught. Ordinary legacy phone-only resolution remains inherently uncertain. Manual reconciliation is deferred. Later history treats corrected 4A as committed/pushed/green.

### Checkpoint 4B — inbound MESSAGE persistence

`handleInboundMessage(tx,event,context)` uses the approved resolver and same queue transaction. At this stage the handler registry was passed explicitly in tests; no executable worker existed yet.

- Advisory lock by organization/account/wamid, then duplicate existence check **before any domain write**. Duplicate is a complete no-op including updated_at. Final unique index and savepoint roll back provisional writes if another writer wins the insertion race.
- One conversation per organization/account/contact, concurrent-safe create/re-read. OPEN/PENDING remain unchanged. RESOLVED reopens only for a **new** inbound message with effective time newer than resolved_at. Duplicate, delayed older message, reaction and RESOLVED without resolved_at do not reopen.
- Provider `occurred_at` is retained exactly. Effective activity/profile/reopen time caps at receipt + five minutes and derived activity only moves forward; future/stale anomalies use fixed log codes. Invalid timestamps are permanent errors.
- Types: TEXT, IMAGE, VIDEO, AUDIO, DOCUMENT, STICKER, LOCATION, CONTACT, INTERACTIVE, BUTTON, FLOW, REACTION, UNKNOWN, with bounded whitelisted mapping. System messages remain outside ordinary processing under the conservative ingress policy.
- Media metadata only; one PENDING attachment per media item with valid id. No provider temporary URL stored, no fetching. PENDING means awaiting a future downloader, not a broken webhook queue.
- Replies preserve `reply_to_wamid`; resolved link only within same conversation/org/account. Late parents back-resolve waiting replies; never self-link, cross conversation or replace an existing link.
- Referral creates one `lead_attributions` row only on a new message, `lead_id NULL`, exact `ctwa_clid`, source_url-only supported. `ad → META_AD`, otherwise REFERRAL; no guess of Facebook versus Instagram. No automatic lead/student/consent creation.
- NUL/lone-surrogate cleaning preserves ordinary Sinhala/Tamil/emoji/ZWJ. Text cap 4096, captions 2048, other per-field limits; inputs over four times a field's limit fail with `content_too_large`. Unknown properties are not copied into curated domain content.
- Contact, alias, conversation, message, attachment, reply and attribution writes roll back together with event processing, including COMMIT-time failures. Archived contacts are not automatically unarchived.

Attribution uniqueness is application-enforced (new-message path plus NOT EXISTS), not a DB unique constraint; blocker 21. Ambiguous identity produces DEAD and needs review/replay tooling; blocker 22.

Report: **550 unit / 636 DB ×12 / 44 E2E**, normal/delayed/jitter repetitions, nine mutations caught. Tenant mutation initially survived concurrent test setup; sequential tests were added so missing filtering is actually detected. Cluster-wide advisory-lock test was corrected to scope to its scratch DB. No new schema/migration. Later 4C prompt states 4B committed/pushed/green.

### Checkpoint 4C — STATUS persistence

`handleMessageStatus(tx,event,context)` validates, checks trusted ACTIVE org/account, takes the same org/account/wamid advisory lock, and calls existing `recordMessageStatus` once. Queue owns completion. No message/contact/conversation is fabricated.

- sent/delivered/read/failed map to SENT/DELIVERED/READ/FAILED. played/unknown ignored by ingress; direct unsupported handler input is permanent `unsupported_status`.
- Existing Phase 02 status ops tightened to **OUTBOUND only**, including `resolveStatusEventsForMessage`. An inbound wamid is kept as unlinked history with `inbound_message_wamid`; no phone matching.
- Append-only, idempotent observations include org/account/wamid/status/provider time/bounded first error/provenance/message link. Replays change neither history nor message updated_at.
- Strict priority advancement `NULL < SENT < FAILED < DELIVERED < READ`; lower statuses never regress cache. Delivery after failure clears cached error; history keeps both. All 64 ordered three-status selections tested.
- Orphan statuses have message_id NULL until matching outbound creation/reconciliation. They create nothing. Statuses for messages this system never sent may remain unlinked indefinitely.
- Exact provider time preserved. Invalid `abc`, zero, negative, fractional or excessively long timestamp is permanent invalid_timestamp. More than five minutes future / more than eight days stale is retained and flagged. `latest_status_at` may be future-valued **display data**, not service-window/activity/order authority.
- First error only: code ≤64, description ≤500, NUL-stripped; precedence message, title, error_data.details. Error text/wamid/recipient never logged. Statuses never touch conversation activity/status/resolved_at.
- Future outbound writer must take the **same advisory lock** before inserting and call `resolveStatusEventsForMessage` in the transaction.

Report: **575 unit (37 files), 693 DB (29 files) ×12, 44 E2E** with repetitions, 11 mutation variants caught; all checks green, no migration. The 5A report explicitly refers to **already-committed 4C code**, establishing historical 4C commit evidence. Its exact commit, push and remote CI status are not independently known here.

### Checkpoint 5A — standalone worker (uncommitted at the handoff; later committed as `4bfe677`)

Implemented `scripts/whatsapp-worker.ts` and `src/modules/whatsapp/worker/` (config, frozen registry, loop, run, policy, errors, public/test entrypoints and seven test files), plus `src/db/__tests__/worker-pool.db.test.ts`.

Changed package script/env example, DB client/public exports, queue process optional stopSignal, stats event-type filter, logging/tests, four boundary guards, docs, and one 4C timestamp test. The latter computed `epoch(minutesAgo(1))` twice and could flake across a second boundary; now computes once. Reported Git state: 17 modified files plus three untracked paths, all uncommitted.

`npm run whatsapp:worker` wires SIGTERM/SIGINT and calls runWorker. It validates config, creates its own bounded pool, confirms schema is migrated, then loops around existing processWebhookBatch. It creates no schema and no second queue, makes no Meta calls and sends nothing.

- Requires **WHATSAPP_WORKER_ENABLED exactly `true`**. Unset/empty/false/TRUE/1/yes refuse with exit 2 and no connection; errors name key, never value.
- Missing tables, bad password or absent DB exit 2 and create nothing. Therefore the currently empty dev DB cannot run it successfully.
- No cron, instrumentation, lifecycle hook, automatic app startup or CI worker activation.
- Frozen literal registry exactly MESSAGE → handleInboundMessage, STATUS → handleMessageStatus. OTHER/IDENTITY remain unclaimed, attempts 0, no lock; real ignored system/unsupported ingress rows stay as stored.
- Empty polling: 500 ms doubling to five seconds, ±20% jitter. Work found: immediate next poll. Fixed-field worker.stats at startup and once/minute.
- Existing queue defaults retained: batch 20, concurrency 2, lease 120 s, handler budget 60 s, statement timeout 15 s, max eight attempts. Pool is concurrency + 2, connect timeout ten seconds.
- SIGTERM/SIGINT stop new claims even inside a batch; in-flight events finish, pool closes, exit 0. Beyond handler budget + ten seconds, exit 1; leases recover normally. SIGTERM sent only to npm may not reach child script: supervisor should run script directly.
- SIGKILL mid-event leaves PROCESSING with no partial domain writes. Lease expiry lets another worker reclaim once. Two real processes drained 30 events into 30 messages/five contacts; lease-loss stale writes/completion refused.
- DB failures use one-second doubling backoff up to 30 seconds; log short outage/recovery codes, exit 1 after five minutes without successful poll. Repeated terminated connections while processing 40 events lost/duplicated none. Silent network blackholes rely on TCP keepalive (ten-second initial delay) and per-event deadlines.
- Drizzle 0.45.3 reportedly starts BEGIN outside the client-release try/finally. Connection death exactly at BEGIN leaks a pool slot and can hang pool.end(). **Worker pool only** gets a reaper/guard workaround; shared getDb pool unchanged (blocker 28).
- Tests exercise real signed ingress → MESSAGE persistence, STATUS history/cache/orphans/rollback, duplicates, tenant/account isolation, account state transitions, permanent/transient/max-attempt and COMMIT failure.

Verification reported: **665 unit (43 files; 90 worker tests); 746 DB (32 files; 34 in-process worker, 15 real child-process, four worker-pool tests)**. Final full DB loop passed ×12, targeted worker/pool 53 tests ×10, official E2E 44 plus five normal/five delayed/three jitter runs. All 14 mutations caught and byte-identical restoration reported. No leftover DB/processes or host sleep in counted final runs. Earlier loops stopped on real test failures: chaos test blindly expired live leases (fixed to orphan leases/bounded kills/asserted crash), and the 4C timestamp flake. Do not call all earlier attempts clean.

db:check, db:generate (no changes), lint/typecheck/build, whole-repo Prettier and diff check passed. Audit remained **four moderate**. No new migration. **Stop here: no commit/push/deployment/later checkpoint is established.**

## 5. Strict security and tenant invariants

1. **Server-derived tenant and role.** Never trust browser headers/body/query for organization, role or account. Auth uses current DB-backed session + ACTIVE membership; webhook ingress routes by the known phone_number_id account, and handlers use the trusted event row.
2. **Tenant-aware DB relationships.** Keep composite FKs and org/account filters; same phone, BSUID or wamid in another organization is independent. Foreign resources look absent, not discoverable.
3. **One organization = one Meta Business Portfolio** is the required onboarding invariant for `(organization_id,bsuid)` uniqueness. A WABA is not a portfolio. This is documented policy, not Graph-verified enforcement. Supporting multiple portfolios inside one org requires deliberate schema/routing changes; do not substitute WABA id for portfolio id.
4. **No history rehoming.** Once routing exists, requeue cannot rewrite it. Unknown-account historical assignment is explicit per event; current number ownership never proves ownership of old events. Account ownership changes with history are blocked by FK.
5. **Identity continuity is fail-closed.** No automatic legacy phone→BSUID link, alias repointing, contact merge, phone-only resolution of BSUID-established contact, display-name matching or parent-BSUID inference. Phone recycling must not expose old conversations.
6. **Raw-byte signature authority.** Exactly one HMAC of received bytes. Never JSON parse/stringify, canonicalize, normalize Unicode or escape text before signature verification. No second candidate signature path. Investigate proxy/tunnel byte mutation if live verification fails.
7. **Authenticate before retaining untrusted request content.** Invalid/missing signature and oversized input create no request/event rows. Authenticated malformed data may be durably quarantined with 200; transient storage failure gets 500.
8. **Transaction + fence.** Contact/message/status/attachment/attribution/reply writes and event PROCESSED share the queue transaction. No independent connection/domain transaction; no swallowed write failure; COMMIT errors and lease loss roll back domain state. FK locking can prevent reclaim after a worker begins domain writes; tests cover both this and pre-write lease loss.
9. **At most eight executions, bounded concurrency.** No ninth handler run, no no-op unsupported handler, no prematurely leased waiting batch, no aggressive idle spin. Account holds do not consume attempts.
10. **Idempotency includes side effects.** Duplicate message/status cannot reopen conversations, move seen/activity timestamps, update profile rows, add attachments/attribution or rewrite updated_at. Unique constraints plus locking/savepoints are required, not only an early SELECT.
11. **Time has separate meanings.** Store provider times exactly; effective inbound times govern bounded monotonic activity/reopening. Status priority governs cache, not provider time. Reactions conservatively do not extend activity/window or reopen; true Meta window semantics remain unverified.
12. **Consent is explicit.** Contact defaults UNKNOWN. Incoming message, referral, reaction, template interaction or lead classification is not marketing opt-in. Keep append-only evidence and event ordering; no automatic lead/student/consent writes.
13. **Secrets/PII never in logs, DTOs, error messages or Git.** Fixed-field whitelist allows internal request/event/org/account ids, attempt/duration/count/outcome/reason. Never raw body, message text, contact/profile, phone, BSUID, wamid, tokens/signatures, error descriptions or database credentials. Provider-id hash helpers are bounded; raw identifiers do not become log fields.
14. **Auth boundary is authoritative near data.** Proxy is only cookie-presence optimization, performs no DB check and accepts forged/revoked cookies at that layer. Server access lookup still rejects them. Cookie cache disabled; role changes/suspension/session revocation take effect immediately on authoritative lookup.
15. **Credential ownership and lifecycle.** Better Auth owns hashes/password resets; no manual credential edits. Private provisioning/reset surfaces are not public routes. Force-change gate is server-derived; admin protections include last-admin concurrency and cross-org global identity protection. Multi-org UI/identity administration is not enabled.
16. **Mutating staff operations require same-origin evidence and strict schemas.** Do not weaken CSRF/Origin/Fetch-Metadata validation to quiet a test. Redirects must stay safe internal paths.
17. **No real Meta traffic/credentials in CI.** Fixtures and test secrets only. Do not accidentally start worker, invoke sending API, download media, connect production numbers or apply migrations to production while verifying a checkpoint.

## 6. Migration 0002: authoritative final design and precondition

Only `webhook_requests`, `contacts` and new `contact_bsuids` were intended to change.

**webhook_requests**: replace `raw_payload jsonb` with `raw_body bytea NOT NULL`; keep lowercase SHA256 of exact received bytes with `^[0-9a-f]{64}$` CHECK. Add ingest_status ACCEPTED/UNPARSEABLE/UNSUPPORTED_SHAPE/EVENTS_REJECTED (default ACCEPTED), ingest_error_code NULL exactly when ACCEPTED, otherwise 1–64 characters; partial non-ACCEPTED index on status/received_at. No fabricated default raw bytes.

**contacts**: wa_id becomes nullable while unique `(organization_id,wa_id)` remains; add username. **No contacts.bsuid column/cache.** BSUID ownership lives in alias rows.

**contact_bsuids**: id, organization_id, contact_id, bsuid, first_seen_at, last_seen_at, retired_at, source_webhook_event_id, created_at; unique `(organization_id,bsuid)`; BSUID length 1–255; last_seen ≥ first_seen; retired NULL or ≥ first_seen; tenant composite FK to contact; org/contact/last_seen index; partial provenance index.

**Two important departures from the earlier revised plan:**

- No partial unique “one current alias per contact” index: H2 did not settle old/new coexistence. Tests explicitly permit two non-retired aliases. Current resolver only adds an alias for a newly created contact and does not implement rotations; future selection/rotation must be reviewed rather than assuming uniqueness.
- Alias provenance is a **single-column FK to webhook_events(id) ON DELETE SET NULL**, to permit pruning. It does not itself enforce source-event tenancy. Tenant association must be checked by application code. Existing message/status provenance stays tenant-composite NO ACTION, requiring explicit null-before-prune cleanup.

TypeScript-only additions included IDENTITY event kind and REACTION message kind; declaring IDENTITY does not mean ingress emits it or worker handles it.

**Precondition: webhook_requests must be empty.** JSONB cannot reconstruct signed original bytes. Adding NOT NULL raw_body without a default safely rejects existing rows and rolls back; never invent bytes/hashes or silently clear live rows. Deployment order is apply 0002, then expose ingress. If the target has existing webhook rows, stop for a separate data-migration/retention decision.

Follow-up PostgreSQL 17.11 validation applied 0000 (66 statements), 0001 (20), 0002 (17) from empty. Byte tests covered all 256 values, Unicode forms, invalid UTF-8/JSON, empty bytes and whitespace/key order. A pre-0002 database with rows proved failure preserves state. Alias/event deletion/provenance and cross-org constraints passed; four migration mutations were caught and restored. Report snippets visually truncated some SQL CHECK text; PostgreSQL validation is the reported evidence, not the malformed pasted SQL. Do not copy that fragment as executable migration SQL.

## 7. Meta evidence gates: H1, H2, H3 and other unknowns

G0 sources were reported retrieved from official developers.facebook.com pages on **2026-10-04** through a fetch tool because scripted requests returned 400. `docs/WHATSAPP_G0_EVIDENCE.md` and ADR 0013 are the local evidence ledger. This handoff does not freshly verify those pages. Search snippets were explicitly rejected as authority when they invented properties.

### H1 — identity-change delivery: UNRESOLVED, handler stopped

Reported contradiction:

- BSUID page described system messages in messages[] with `system.{body,wa_id,user_id,parent_user_id,type}`, named `user_changed_user_id`, but did **not** document `system.previous_user_id`. Old BSUID appeared only in human-readable body.
- The same page described separate `user_id_update` with `user_id.{previous,current}` and subscription instructions.
- Webhook overview's complete 19-field list omitted `user_id_update`.
- Legacy system page documented only `user_changed_number` with old/new phone fields.

The assumption of `system.previous_user_id` came from a search summary and was **withdrawn**. Do not parse old identity out of prose/body; do not invent fields, automatically alter wa_id or design rotation based on this contradiction. Need App Dashboard subscription evidence and sanitized actual deliveries. Current system messages/non-messages fields are stored as ignored OTHER (`system_message_pending_h1` where applicable); no IDENTITY is emitted. Existing/seeded IDENTITY rows have no handler and remain unclaimed.

### H2 — scope/cardinality/stability: partly established, partly unknown

G0 reported official text: BSUID scoped to **Business Portfolio–user pair**, regenerated on user phone change; portfolio ≠ WABA. Same BSUID across every number of a portfolio is **medium-confidence inference**, not complete observed cardinality proof. Whether old BSUID stays usable and whether old/new overlap is undocumented. No current-alias DB unique index, no phone alias history, parent BSUID ignored. All accounts in an organization must share a portfolio until a deliberately revised schema supports otherwise.

### H3 — contact/message pairing: definitions supported; multi-sender unverified

Property definitions support from_user_id/user_id and from/wa_id matching. Every official example had one message and one contact per value. Multi-sender deliveries are **synthetic edge cases**, not demonstrated real Meta behavior. Defensive per-message pairing exists; reversed contacts/missing contacts/conflicts are tested. No fixture relabelling without evidence.

### Other unresolved provider/operational facts

- Literal UTF-8 versus escaped Unicode on actual wire; local tests prove exact-byte correctness, not Meta's wire representation.
- Reaction effect on the 24-hour customer-service window. Current policy stores reaction without reopening/advancing activity.
- `nfm_reply`/order shapes, source_type values beyond ad, and **sent/read status JSON remain synthetic** (delivered/failed examples support the minimal handler fields).
- `entry.id` equals WABA id on actual delivery: medium confidence; mismatch is a hold, not a discard.
- Secret used for overridden-callback signatures; callback overrides/groups/unrelated webhook fields remain out of scope.
- Retry duration conflict: WhatsApp material said up to seven days, generic Graph page 36 hours. Seven days was the planning assumption, not fully reconciled evidence; stale timestamp warning threshold is eight days.
- G0 plan recorded Graph v26.0/v25.0 dates as historical metadata; no outbound API version was selected. Reverify at outbound milestone.
- Actual number verification/coexistence, subscription, token permissions/rotation, billing, rate tiers and production webhook latency still need a controlled live gate.

## 8. Test and CI history; known harness failures

### Latest successful reported suite sizes

| Milestone | Unit | PostgreSQL | Chromium E2E |
| --- | ---: | ---: | ---: |
| Foundation | 5 | Not yet | Not yet |
| Phase 02 | 5 | 68 | Not yet |
| Reset hardening | 152 | 214 | Not yet |
| Phase 03 final browser gate | 193 | 308 | 36 |
| G0/schema validation | 208 | 356 | No runtime E2E in schema report |
| Ingress | 447 | 400 | 44 |
| Corrected queue/requeue | 473 | 498 | 44 |
| Corrected identity 4A | 496 | 551 | 44 |
| Second E2E harness fix | 510 | 551 | 44 |
| Inbound 4B | 550 | 636 | 44 |
| Status 4C | 575 | 693 | 44 |
| Worker 5A | 665 | 746 | 44 |

Counts are snapshots from reports, not current independent measurements. Some reports repeat totals with different breakdowns; don't infer a test was removed merely from formatting. Mutations establish security/concurrency assertions can fail, but not live Meta or production correctness.

### GitHub jobs

- **verify:** lint, typecheck, database-free unit tests and build.
- **database:** PostgreSQL 17 service, pinned Node/npm install, db:check, generate/drift check (including untracked migration files), migrate from empty, confirm migration/table state, real PostgreSQL tests.
- **e2e:** PostgreSQL 17 + Chromium/system dependencies, production build, disposable migrated/seeded DB, browser tests, failure-only artifacts (seven-day retention reported).

CI uses fake secrets/data, no Meta credentials or calls. Successful local YAML simulation is not a hosted CI pass. Earlier checkpoints progressed through reported hosted-green gates; **5A had not been pushed at the handoff, so its hosted CI was pending then; check the hosted result for the actual commit**.

DB harness uses a separate local scratch DB per file, migration SQL, and cleanup, with non-local-host refusal. E2E uses `al_ict_e2e_*`, ignores normal DATABASE_URL, drops in finally (including failure/Ctrl-C), and fails if cleanup fails. Test outputs/report folders are ignored. Test-server HTTPS uses throwaway cert and production env so real Secure/__Secure- cookies are exercised. E2E retries were zero because rerunning stateful tests against already-mutated DB would be misleading. Fake session cookies/passwords can appear in failure traces; production secrets must not.

### Harness incidents and corrections

1. Phase 02 integration harness error handling was corrected, with repeated CI-mode proof. It was not a blanket production-client fix.
2. After G0/schema CI, verify/database were green but E2E logged an aborted/ECONNRESET server error. First harness correction ordered shutdown/in-flight work and capture/validation/DB-drop cleanup; migration 0002 was unrelated. Strict server-error detection stayed in place. Later intermittent behavior required deeper investigation.
3. Cross-site attacker `fetch(...,{mode:"no-cors"})` POST received proxy 401 without its body being read; Chromium canceled the opaque response at headers. Next.js 16.3.8 cloned-body/finalize behavior could remove an error listener and log `uncaughtException: Error: aborted` on a slow runner. Test changed to **real cross-site form navigation**, waits for full response, and verifies genuinely different origins, `sec-fetch-site: cross-site`, expected Origin, navigation mode, **no session cookie**, 401 and unchanged ACTIVE target membership. Mutation checks protect origin/cookie/no-state-change assertions.
4. Stress results for that fix: normal ×15, CPU-starved ×10, 800 ms GET jitter + 40 ms end delay ×15, 120 ms end delay ×15; 551 DB ×3; official 44 E2E; strengthened CSRF ×5. Two earlier samples invalidated by host sleep were disclosed/excluded, not counted clean. This fixes the test trigger, **not the underlying real-client abort risk** (blocker 20).
5. Ingress stalling oversize uploader required `Connection: close` on 413 and harness counter tracking responses rather than request streams.
6. 4B scoped an advisory-lock assertion to its DB and fixed timestamp/order flakes. 5A fixed blindly expiring active chaos-test leases and the 4C double-computed timestamp. Count only final restarted loops as consecutive clean proof.

Keep server logs as a failing signal. Do not suppress ECONNRESET/aborted errors or weaken assertions just to green CI. `scripts/repro-next-body-clone-abort.mjs` exists to recheck framework behavior after upgrades. A Mac lid close can suspend tests despite idle-sleep prevention; invalid sleep-affected samples must be identified. Historical stress loop volume is not a requirement to repeat all suites indefinitely.

## 9. Constraints and unresolved preproduction blockers

The actual `docs/PRE_PRODUCTION_BLOCKERS.md` is the authoritative numbered register. Its full text was not supplied. The following captures every substantive open issue exposed in retrieved reports/plans/reviews; numbers are only attached where evidence identifies them. Do not invent descriptions for missing register numbers or mark them closed based on this summary.

| Area / known number | Remaining issue and gate |
| --- | --- |
| Client IP (register item 1) | Trustworthy proxy-to-app IP propagation not established. Better Auth DB limiter reportedly skips no-IP requests. Browser test-supplied IP headers prove wiring, not trust. Define production proxy topology and strip/spoof-proof headers. |
| Platform abuse protection | WAF/platform throttling and bounded request/connection handling needed, especially public webhook before full-body signature and login/staff mutations. |
| Authenticated mutations | No dedicated limiter on staff routes; password change/admin reset hardening and rate limiting needed before exposure. |
| Dependency packaging | Four moderate drizzle-kit/esbuild-chain findings remain, even in production-style omit-dev installation due optional peer relationships. No forced downgrade/overrides/npm audit fix; resolve or deliberately assess packaging at deployment. |
| Multi-organization operation | Schema-ready, but selector and safe global identity administration not enabled. Reject ambiguous multiple active memberships rather than choosing one. |
| Provisioning operations | Ownership-aware recovery exists by review summary; monitoring, stale-intent handling/runbook and operational readiness remain. Never automatic expiry that releases a partially owned identity. |
| Recovery/email | Email delivery and self-service password recovery deferred; public reset/signup kept closed. |
| Raw/event retention (#9 cited) | PII retention policy/job not implemented. Raw-body 30-day idea was a proposal, not adopted runtime policy; held events need special handling. Null message/status provenance before prune under NO ACTION. Alias provenance SET NULL differs. |
| Alias immutability (#16) | Unique org/BSUID does not block same-org UPDATE of contact_id. Resolver/static tests enforce immutability; no trigger. Other writers/operators require the same rule. |
| Meta evidence | H1/H2/H3 and other section 7 uncertainties unresolved; real Dashboard/live fixture capture needed. Identity-change handler stays blocked. |
| Onboarding/portfolio | No Graph-enforced one-org/one-portfolio check or completed operator onboarding/activation workflow. Account ownership and unknown historical assignments require explicit safe decisions. |
| Client abort (#20) | Real rejected POST disconnection can still log uncaughtException/aborted. Framework keeps process alive in reproduction. Body draining or excluding broader API proxy matching were documented options, not implemented; matcher change requires security review. Upstream fix unknown. CI request identity was inferred from reproduction, not directly observed in hosted CI. |
| Attribution (#21) | One row/message only application-enforced. Before another writer or go-live, decide/review a DB unique constraint migration and duplicate-data preconditions. |
| Ambiguous identity (#22) | DEAD identity failures need safe manual inspection/reconciliation/replay; no automatic merge or blind DEAD requeue. |
| Status display / 4C items 23–24 | latest_status_at may retain a provider future time; display only. Do not let future code use it for activity/window/order authority. Exact numbered mapping needs local register inspection. |
| Future outbound reconciliation / 4C items 23–24 | Outbound writer must take same advisory lock and invoke resolveStatusEventsForMessage transactionally. No writer exists yet. Exact numbered mapping needs local register inspection. |
| Status fixtures (#25) | sent/read JSON synthetic; need sanitized real/official evidence, without relabelling synthetic examples prematurely. |
| Worker hosting (5A new #26–29) | Not deployed/supervised; direct-script signal forwarding, graceful timeout/restart policy and provider limits need a reviewed deployment plan. Exact numbering of hosting/health entries needs local register read. |
| Worker operations (5A new #26–29) | No operator account activation/requeue/DEAD replay workflow. Existing low-level primitives are not a finished operator product. |
| Shared pool (#28) | Drizzle BEGIN leak workaround only in worker pool. Shared getDb pool can still leak/hang under exact transaction-start outage. Review safe shared fix or upgrade evidence before production. |
| Worker health (5A new #26–29) | Logs only; no metrics/alerts/supervisor health. Silent network blackholes rely on keepalive/deadlines. |
| Media | PENDING metadata only; downloader/storage/access controls/expiry handling absent. Do not treat pending attachments as failed webhook events. |
| Live deployment/security | HTTPS/tunnel/proxy behavior, backups, DB roles/least privilege, secret storage/rotation, retention access and operational recovery need deployment-specific validation; none is proven by local fake-data tests. |

4C explicitly mentioned register items **18, 23, 24, 25** but did not provide the full mapping for 18. 5A explicitly introduced **26–29** and identified **28** as shared-pool leak. Preserve these references without pretending to reconstruct the missing numbered file exactly.

Other constraints: conservative groups/system/unsupported handling; no service-window extension by reactions; no auto unarchive; display profiles cannot prove identity; duplicate conflict logs on retries can occur; removed profile fields indistinguishable from absent fields are retained; contacts without identity cannot be completely prevented by cross-table CHECK and must be guarded by supported creation paths/operations. Outbound to BSUID-only contacts needs a documented recipient path later, not a phone fallback.

## 10. Prioritized next actions and collaboration gates

### Immediate: review and checkpoint 5A (historical gate; 5A was reviewed and committed, see the status update in section 1)

1. Open the real local repo. Read AGENTS.md/CLAUDE.md, this file, ADR 0013, security/testing/blocker docs. Inspect branch, HEAD, working tree and full 5A diff; confirm no unrelated edits or secrets. This document does not replace code review.
2. Review enablement/schema fail-closed startup, exact MESSAGE/STATUS registry, claim stopSignal, pool ownership/reaper, outage/shutdown behavior, same-transaction writes/fencing, log whitelist and the small 4C test fix.
3. Check actual test results/artifacts and blocker updates. Run appropriate local checks if results are missing/stale or code changed; avoid repeating already-passing full suites solely because historical prompts demanded ×12.
4. Stop with a concise review report: changed files, evidence, failures/risks, current status. **Do not stage/commit/push.** If approved, provide file-scoped Git instructions for the user; never blindly include secrets/unrelated paths.
5. After the user commits/pushes, obtain commit/status/push evidence and wait for **verify, database and e2e on that commit**. Do not call this gate complete from the prior commit's green checks.

### Next checkpoint proposal: operations, not automatic 5B completion

“5B” was discussed as the next development point, not completed work. Agree its exact scope after 5A review/CI. The smallest sensible operations scope is safe account setup/activation, routed hold requeue, explicit per-event unrouted assignment, DEAD inspection/replay and a runbook, using existing primitives. Plan first; review operator authorization, portfolio confirmation, routing immutability, time limits, audit-safe output and ambiguous identity handling before implementing. Do not fold outbound, identity rotation, media, bot studio or deployment into the same checkpoint.

Then prioritize: production blockers affecting ingress/auth/worker (trusted IP/WAF, shared pool, abort behavior, retention and observability); controlled Meta Dashboard/evidence gate; sanitized live inbound smoke; deployment/supervision plan; separately scoped outbound with status reconciliation and service-window/template rules; later inbox/team/product flows. Ordering can be refined after reading the actual blocker register, but unresolved H1 never authorizes speculative identity processing.

The empty dev DB is a separate setup decision. Do not enable the worker merely because its script exists. Confirm local target and apply reviewed committed migrations only within an authorized setup checkpoint; never infer migration success from disposable test runs, and never use destructive volume reset as a shortcut.

### Established Claude Code / Codex workflow

- User leads scope and owns commit/push. Claude Code commonly implements a tightly scoped checkpoint; ChatGPT/Codex reviews architecture, evidence and reports. Codex may implement/review when explicitly assigned, but must preserve the same gates.
- New architectural work starts in **Plan Mode**: inspect current code/docs/callers and present exact scope, invariants, reuse, tests and stopping point. A plan is not implementation evidence.
- After review, switch to Agent/Edit for **one checkpoint only**. Migration work has a generated-SQL review gate **before applying** even to scratch databases when the checkpoint requires that gate.
- No future-feature implementation, incidental dependency/provider choice or credential/live Meta configuration. Stop on genuinely missing essential invariants or contradictory provider evidence; don't silently add migrations or relax security.
- Use existing operations/module boundaries and the smallest complete change. A bug fix must reach callers/tests/fixtures/docs affected; avoid duplicate frameworks and unrelated cleanup.
- Report what actually ran and passed, exact suite counts, failure causes/fixes, mutation restoration, DB/process cleanup, migration drift, audit findings and Git state. Distinguish local tests, hosted CI, synthetic fixture proof and live provider observations.
- Standard applicable checks: `npm run db:check`, `npm run db:generate` (inspect any generated changes), lint, typecheck, npm test, `CI=true npm run test:db`, build, `CI=true npm run test:e2e`, `npm audit --omit=dev`, repository Prettier check, `git diff --check`. Use verified repository scripts; do not improvise schema push.
- **Updated efficiency policy:** full applicable unit/DB/E2E suites once after implementation, repeat targeted concurrency/security/lifecycle tests only when justified by a race/new failure. Keep CI and critical mutation/security proofs; don't repeatedly rerun thousands of unrelated tests. Earlier 10–15 full-loop instructions are historical, superseded by the final efficiency discussion.
- Always stop for review, then user commit/push, then relevant hosted-green CI gate before proceeding. No automatic commits, pushes, production migrations, deployment, account activation or live number switching.

## 11. How to use this handoff locally

Place this file at the root of the real repository:

```text
/Users/Projects/Class/al-ict-whatsapp-platform/PROJECT_CONTEXT.md
```

Confirm that path on your Mac; it is the reported historical path. This handoff file transfers context, not actual conversation messages. If a PROJECT_CONTEXT.md already exists, review/merge it rather than overwrite newer facts. Adding the file to Git is the user's separate decision.

Start the local project chat with:

> (Historical starting prompt for the 5A handoff.) Read PROJECT_CONTEXT.md, AGENTS.md and CLAUDE.md, then inspect the current repository and the uncommitted Checkpoint 5A diff. Treat historical test results as reports until verified locally. Review 5A and report current status and blockers. Do not modify code, stage, commit, push, apply migrations, start the worker or configure live Meta until the next scoped task is authorized.

After later work, update this document with exact reviewed commit/CI evidence and current blockers. Keep historical decisions and superseded-policy warnings; never erase the distinction between tested, committed, deployed and live-verified.

## 12. Source landmarks for future reconciliation

Primary source: **WhatsApp API Setup**, conversation ID above. Useful turn IDs from the retrieved history:

| Landmark | Turn ID / source |
| --- | --- |
| Foundation implementation report | `bf7bb008-b43c-4e52-9b29-d4296e673f07` |
| Foundation real push / f66797c | `9fb6054a-a168-4ec1-ac37-6ad43499858c` |
| 0000 schema correction / 68 tests | `82ee3e93-f261-4783-8397-44f1f55278e3` |
| Database CI simulation | `e2e8a589-3421-4ac0-a9dc-98543268989e` |
| Password reset hardening | `a833d924-250a-459d-99e1-08108bc5cfc9` |
| Staff API report | `f4b111a8-b4ca-4c61-b804-f74d6c372b02` |
| Phase 03 browser/CI report | `f8af760a-4880-4028-a7d1-a63f19038003` |
| 0002 real PostgreSQL validation | `fb1fdb39-59b4-40d9-9451-eda6c9bf87b1` |
| Requeue no-rehoming correction | `510f0822-ce19-4168-becd-8b01699fdee7` |
| Final identity no-legacy-link correction | `6398d158-b043-4c5c-b55a-a3d5752592a2` |
| Complete abort/CSRF harness verification | `624e552e-7fca-438b-b3fc-8ef71acff341` |
| STATUS 4C report | `f521ecbf-aecb-4665-a934-aae26e69a993` |
| Worker 5A report | Latest supplied pasted-text attachment: begins “Checkpoint 5A is done and stopped for your review”; attached to the later timing discussion |
| Efficiency-policy discussion | `58c8560a-1927-47eb-909d-c66fa53a9aa3` |

The available attached reports preserve more detail than some turn previews. Later corrections in the conversation override earlier plans/reports, particularly legacy identity linking, requeue routing, current-alias uniqueness/provenance design, raw-byte signature handling and repetitive test policy. When current code differs from this record, surface the discrepancy for review; do not silently assume either the history or code is correct.
