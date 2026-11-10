# Phase 08G-7B C1 — Platform operator identity and authorization (implementation plan)

Status: **REVISION 2 — PLAN FOR OWNER IMPLEMENTATION REVIEW. NOT IMPLEMENTATION AUTHORIZATION.** Prepared by static
inspection of the repository and of the installed `better-auth` 1.7.7 package only: no database connection, SQL, migration,
code or test change, test run, worker, browser, Meta call or WhatsApp send. The permanent `al_ict_whatsapp` database was not
touched. Production activation: **NOT AUTHORIZED.**

Inputs: owner approval of **OD-MT-4** (2026-11-06, quoted in 3.0); [ADR 0012](adr/0012-authentication-and-authorization.md);
[ADR 0022](adr/0022-internal-multi-tenant-first.md); [policy decisions](PHASE_08G-7B_PRIVACY_POLICY_DECISIONS.md);
[S1 design](PHASE_08G-7B_S1_ERASURE_RESTORE_DESIGN.md) §12 and §19 (checkpoint C1). None of those documents is changed.

**Revision history.**

- Revision 1 (2026-11-06): first plan, one C1 slice.
- Revision 2 (2026-11-06): owner-side review accepted the direction and required refinements. C1 is split into **C1A**
  (identity and authorization foundation) and **C1B** (protected entry points); emergency access, operator account security,
  audit, action permissions and CLI authentication are refined. Removed from revision 1: an emergency **flag** as
  authorization; a security admin directly assigning an operator's password; "session created within 15 minutes" described as
  if it were a separate re-authentication; one permission covering all account maintenance; denial audit described as
  mandatory.

Baseline (verified for revision 2): branch `Bot-Foundation`, HEAD `ca8470c89bd03eb6cdd2691344ceffe070189542` (=
`origin/Bot-Foundation`), nothing staged, no tracked modification; only this document untracked.

## 1. Verified existing architecture

| Concern                    | What exists (source)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication             | Better Auth 1.7.7, email + password only; public instance at `/api/auth/*` with `disableSignUp`; private provisioning instance never mounted (ADR 0012; `src/modules/auth`). No plugin configured (Admin, Organization, two-factor, bearer all unused), no impersonation                                                                                                                                                                                                                                                                                                                               |
| Sessions                   | Database sessions, HttpOnly cookie, cookie cache **disabled**, 7-day sliding (`updateAge` 1 day). `session.freshAge` is not set, so the library default (24 h, `context/create-context.mjs:149`) applies to its own fresh-session endpoints                                                                                                                                                                                                                                                                                                                                                            |
| Sign-in gate               | `databaseHooks.session.create.before` refuses a session to a user with no ACTIVE membership (`auth/base-config.ts:75-91`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tenant authorization       | `requireAccess()` resolves exactly one ACTIVE membership per request (0 → 403, >1 → 409); `can(role, permission)` over a fixed in-code matrix (`access/permissions.ts`). **ADMIN holds every permission** (`const ADMIN = PERMISSIONS`). No platform role or permission exists                                                                                                                                                                                                                                                                                                                         |
| Credential-changing paths  | Public route closes `/sign-up/email`, `/update-user`, `/change-email`, `/delete-user`, `/delete-user/callback`, `/link-social`, `/request-password-reset`, `/reset-password`, `/set-password` (`auth/public-instance.ts:17-27`); `changeEmail` and `deleteUser` disabled by option; no `sendResetPassword` on the public instance. Open: `/change-password` (current password required), `/sign-in/email`, `/sign-out`, session listing and revocation. App routes: `POST /api/account/change-password` (own password), `POST /api/staff/{id}/reset-password` (tenant ADMIN, via the private instance) |
| Library endpoints present  | `/verify-password` is `scope: "server"` (`api/routes/password.mjs:172-180`); `/update-session`, `/account-info`, `/list-accounts`, `/unlink-account`, `/get-access-token`, `/refresh-token`, `/send-verification-email`, `/verify-email` exist in the package and are **not** in the closed list (their inertness without configuration was not verified; 2, C1-G10)                                                                                                                                                                                                                                   |
| Operator CLIs              | `scripts/*.ts` run in-process with `DATABASE_URL` (`getDb()`); no sign-in, no human identity (1.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Database credentials       | One privileged application role for web, workers and CLIs (ADR 0012 "RLS deferred"; ADR 0022)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Security and audit logging | `emitSecurityEvent` writes whitelisted structured log lines; "the future audit-log table will plug in here" (`shared/security/events.ts:1-3`). Durable actor columns only inside domains (`conversation_events`, `bot_deployment_events`, `lead_events`)                                                                                                                                                                                                                                                                                                                                               |
| Administrator bootstrap    | `auth:bootstrap-admin` creates the first organization and ADMIN; refuses if any user exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Service identities         | Webhook, outbound and bot workers, `bots:retention`, `leads:reconcile`: processes holding `DATABASE_URL`; domain rows record "system" as a NULL actor where modelled                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Admin password reset       | `resetStaffPassword` is allowed for an identity whose **single** membership is in the actor's organization; it sets `password_change_required`, revokes sessions and replaces the password through the private instance (ADR 0012 checkpoint 4)                                                                                                                                                                                                                                                                                                                                                        |

### 1.1 Existing operator entry points

| Script                                           | Commands                                                            | Scope                        | Authentication today               | Data shown                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `auth:bootstrap-admin`                           | create first organization + ADMIN                                   | Platform (one-time)          | `DATABASE_URL`                     | None beyond inputs                                              |
| `auth:intents`                                   | list, inspect, resume, remove provisioning intents                  | Platform (identity recovery) | `DATABASE_URL`                     | Intent ids, email key, organization                             |
| `whatsapp:accounts`                              | list, inspect, register, activate, enable, disable, archive         | Platform (account to tenant) | `DATABASE_URL`                     | Account ids, business phone-number and WABA ids, secret _names_ |
| `whatsapp:events`                                | counts, list, requeue-routed, requeue-unrouted, dead                | Platform (shared queue)      | `DATABASE_URL`                     | Ids, states, codes; payload never selected (`events.ts:73`)     |
| `whatsapp:status`                                | pipeline health                                                     | Platform                     | `DATABASE_URL`                     | Counts, ages, codes (`health.ts:9`)                             |
| `whatsapp:outbound`                              | counts, health, list, inspect, templates (register)                 | Platform                     | `DATABASE_URL`                     | No body, recipient or payload (`messaging/operator.ts:8`)       |
| `bots:admin`                                     | drafts, publish, deployments, stop-sessions, retire, emergency-stop | **Tenant**, acts as a member | `DATABASE_URL` + `--actor <email>` | Ids, codes, counts                                              |
| `bots:retention`, `leads:reconcile`, the workers | bounded passes                                                      | Service                      | `DATABASE_URL`                     | Counts                                                          |
| `e2e-*`                                          | test harness                                                        | Test only                    | Disposable database                | —                                                               |

## 2. Security gaps

| ID     | Gap                                                                                                                                                                                                                                 | Closed by                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| C1-G1  | No platform identity: every platform operation is "whoever holds `DATABASE_URL`"                                                                                                                                                    | C1A (identity); C1B (operations)                               |
| C1-G2  | `bots:admin --actor <email>` lets any credential holder act as **any** ACTIVE member, ADMIN included                                                                                                                                | Separate checkpoint (tenant routes)                            |
| C1-G3  | A database credential is not individual accountability; its holder can write any row, including grant and audit rows                                                                                                                | C1B credential withdrawal (OD-C1-4); never by application code |
| C1-G4  | No durable audit of privileged actions                                                                                                                                                                                              | C1A (operator changes); C1B (operations)                       |
| C1-G5  | Sign-in requires an ACTIVE membership                                                                                                                                                                                               | C1A                                                            |
| C1-G6  | A tenant ADMIN can reset the password of a user whose single membership is in that organization: once operators exist, a takeover path                                                                                              | C1A                                                            |
| C1-G7  | No second factor; the library's freshness rule is based on session **creation** time                                                                                                                                                | C1A freshness (5.2); MFA pre-production (OD-C1-2)              |
| C1-G8  | Rate limiting skips requests without a client IP and all server-side `auth.api` calls                                                                                                                                               | Deployment (ADR 0012 blocker); C1B prerequisite                |
| C1-G9  | No enforceable emergency path: today "emergency" and "normal" access are the same credential                                                                                                                                        | C1B with infrastructure (section 6)                            |
| C1-G10 | Public library endpoints not in the closed list (`/update-session`, `/account-info`, `/list-accounts`, `/unlink-account`, `/get-access-token`, `/refresh-token`, `/send-verification-email`, `/verify-email`) were not proven inert | C1A test (C1A-T15); close if not inert                         |

## 3. Identity design

### 3.0 Approved policy (OD-MT-4)

Separate from tenant roles; every human individually authenticated; privileged operations explicitly authorized and auditable;
least privilege; no automatic tenant-content access; operators are trusted members of the internal team; no super-admin
dashboard, impersonation, billing, self-service onboarding or SaaS administration.

### 3.1 The five concepts, kept apart

| Concept                  | Representation                                                                                   | Never implies                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Human identity           | The existing Better Auth `users` row and its session. No second login system                     | Any authorization                                |
| Platform authorization   | New `platform_operator_roles` rows (user, role, status) + an in-code matrix, checked per request | Organization membership, tenant data access      |
| Organization membership  | Existing `organization_memberships`, unchanged                                                   | Any platform permission (tenant ADMIN gets none) |
| Temporary support access | **Not built.** A future, separately approved grant per (operator, organization, purpose, expiry) | —                                                |
| Service identity         | A named worker or job recorded as `actor_kind = SERVICE` with `service_name`                     | A human, or a platform role                      |

### 3.2 Where the authority runs

While an operator holds the database credential, any check inside the CLI process can be skipped (C1-G3). The chosen design:
platform operations run as authenticated server routes `/api/platform/*` in the existing app, and the CLIs become thin HTTP
clients (C1B). Only the web process holds the credential. Alternatives rejected: an in-process sign-in prompt (no enforcement
against a credential holder); a separate operator service with its own login (a second system).

**Honest scope.** C1A gives operator identity, roles, revocation and audit for **operator-management** actions. It does not
close any legacy CLI bypass: until C1B ships and operators no longer hold `DATABASE_URL`, every gap in section 9 stays open.

## 4. Permissions

Two fixed roles, matrix in code like ADR 0012, one permission per action, only operations that exist today.

| Permission                                | Action                                                                   | Introduced | `PLATFORM_OPERATOR`      | `PLATFORM_SECURITY_ADMIN` |
| ----------------------------------------- | ------------------------------------------------------------------------ | ---------- | ------------------------ | ------------------------- |
| `platform.operator.read`                  | List operators and grants (ids, roles, status, times)                    | C1A        |                          | ✓                         |
| `platform.operator.grant`                 | Grant a role to another existing user                                    | C1A        |                          | ✓                         |
| `platform.operator.revoke`                | Revoke another user's grant (anyone may revoke their **own**)            | C1A        |                          | ✓                         |
| `platform.audit.read_own`                 | Read one's own audit rows                                                | C1A        | ✓                        | ✓                         |
| `platform.audit.read_all`                 | Read all platform audit rows                                             | C1A        |                          | ✓                         |
| `platform.health.read`                    | `whatsapp:status`; events, outbound counts and health                    | C1B        | ✓                        |                           |
| `platform.whatsapp_account.read`          | Account list and inspect (ids, statuses; secret **names**, never values) | C1B        | ✓                        |                           |
| `platform.whatsapp_account.register`      | Register an account for an organization (assigns tenant ownership)       | C1B        | ✓                        |                           |
| `platform.whatsapp_account.change_status` | Activate, enable, disable, archive                                       | C1B        | ✓                        |                           |
| `platform.webhook_event.read`             | Event list, dead list (no payload)                                       | C1B        | ✓                        |                           |
| `platform.webhook_event.requeue_routed`   | Release held events of their own account                                 | C1B        | ✓                        |                           |
| `platform.webhook_event.assign_unrouted`  | Give one unrouted event an owner (an ownership decision)                 | C1B        | ✓ (OD-C1-3 may restrict) |                           |

- No permission reveals a secret value, a message body, a phone number, a BSUID or a provider payload; no permission creates a
  tenant `AccessContext`. Account maintenance does not include credential disclosure or tenant-content access.
- Not created: template registration and staff-intent recovery (later slices with their own permission); `erasure.*`, ledger
  custody, backup restoration (C4, C5, C7); tenant support access (separate approval).
- Tenant permissions and platform permissions are separate types checked by separate helpers. Holding both roles does not
  satisfy a rule that requires two distinct humans (S1 §12.3): those rules count humans, not roles.

## 5. Operator account security

### 5.1 Enrollment, self-assignment and bootstrap

| Topic                   | Contract                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First security admin    | One-time CLI `platform:bootstrap-operator --user-email <existing user>`, run by a credential holder at initialization. Grants `PLATFORM_SECURITY_ADMIN` (and, if OD-C1-3 allows, `PLATFORM_OPERATOR`) to one **existing** user named by the owner. Audited `actor_kind = BOOTSTRAP`                                                                 |
| Bootstrap is single-use | The bootstrap transaction inserts the only row of `platform_bootstrap(singleton boolean PRIMARY KEY CHECK (singleton))` and the grants together. A second or concurrent run fails on the primary key and changes nothing, whether earlier grants are ACTIVE or REVOKED. The command is kept only for audit; it can never run again on that database |
| Identity of the human   | Verified out of band by the owner (internal team, in person); the grant stores a short `verification_ref`, never the evidence. The server takes the actor only from the validated session; an email, header or id from a caller is never proof                                                                                                      |
| Additional operators    | `platform.operator.grant` with a re-authenticated session (5.2), for an existing user, one role per call                                                                                                                                                                                                                                            |
| No self-assignment      | Refused in the service when actor = target; enforced again by a CHECK (`granted_by_user_id <> user_id` for `grant_kind = NORMAL`) and by the guard trigger. A security admin cannot grant themself `PLATFORM_OPERATOR` either; another security admin must                                                                                          |

### 5.2 Recent re-authentication

**Finding.** Better Auth's `freshSessionMiddleware` compares `now` with `session.createdAt` against `freshAge`
(`api/routes/session.mjs:331-343`). A session's `createdAt` is set when a password sign-in (or the password change that replaces
the session) creates it and is not moved by sliding renewal, so "recently created" here means "password verified recently". It
is not a per-action prompt.

Contract for C1A: every platform **mutation** requires the session to have been created by a password sign-in within the last
**10 minutes** (database clock); otherwise 403 `REAUTHENTICATION_REQUIRED` and the operator signs in again through the normal,
rate-limited `/sign-in/email`. The check is ours (`requirePlatformPermission`), not the library's `freshAge` (whose default 24 h
also governs `list-sessions` and other library endpoints and is not changed).

`/verify-password` exists but is server-scoped; calling it from our route would be a server-side `auth.api` call, which bypasses
the rate limiter (C1-G8). It is **not** used in C1A. A per-action password prompt is a possible later refinement only with its
own limiter.

### 5.3 Credential changes and recovery

| Path                                         | Contract                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant ADMIN resets an operator's password   | **Refused** whenever the target holds any ACTIVE platform role (`resetStaffPassword` check inside its transaction, under the role row lock)                                                                                                                                                                                                               |
| Security admin "sets" an operator's password | **Not provided**                                                                                                                                                                                                                                                                                                                                          |
| Lost or compromised operator account         | Established recovery, in order: (1) revoke every platform role of that user (5.4), so no privilege travels through recovery; (2) the normal account recovery the user already has (tenant ADMIN reset with forced password change, or the user's own change); (3) the owner re-verifies the person; (4) a **different** security admin grants roles again |
| Own password change                          | Existing flows unchanged (`revokeOtherSessions: true`); a new session restarts the 10-minute window                                                                                                                                                                                                                                                       |
| Email or account-recovery data               | `changeEmail` disabled, `/update-user` and `/change-email` closed: no route changes an email. Any future email-change feature must refuse users with ACTIVE platform roles. C1-G10 endpoints are proven inert or closed in C1A (C1A-T15)                                                                                                                  |
| MFA                                          | Not in C1A. A `two-factor` plugin directory exists in the installed package; whether it is suitable, and whether adopting it is compatible with ADR 0012's "no plugin" decision, is unverified. Pre-production decision OD-C1-2                                                                                                                           |

### 5.4 Revocation and consistency

- `platform.operator.revoke`: ACTIVE → REVOKED (one way), `revoked_by_user_id`, `revoked_at`. Refuses the last ACTIVE
  `PLATFORM_SECURITY_ADMIN`.
- **Sessions:** the revocation transaction deletes **all** of the user's sessions (forced sign-out everywhere), whether or not
  they keep tenant membership. Tenant access returns at the next sign-in; platform access does not.
- **In-flight operations:** every platform mutation re-reads the actor's ACTIVE role row `FOR SHARE` in its own transaction;
  revocation takes it `FOR UPDATE`. A mutation commits before the revocation or is denied after it; never both.
- Authorization is read from the database on every request (no cookie cache), so a revoked operator is denied at the next
  request even before session deletion.

## 6. Emergency (break-glass) access

An emergency is any operation performed without the normal authenticated route, for example when the application is down or
no security admin can act. A flag or command-line option is **never** authorization.

| Requirement            | Contract                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential custody     | A separate emergency database credential (distinct from the application's runtime credential and from any operator's), held in sealed custody by the owner (or two named custodians), never on operator laptops or in repository, CI or deployment variables. Requires the database-role split (INF / OD-P18) |
| Execution boundary     | Used only from a designated emergency environment (an isolated, access-logged host or the provider's audited console); the choice is infrastructure (OD-C1-6). Normal operator environments cannot reach the database once OD-C1-4 is done                                                                    |
| Explicit authorization | Owner authorization recorded before use (who, what, why, until when), with a reference number                                                                                                                                                                                                                 |
| Human attribution      | The named person, the authorizer and the reference are written into `platform_audit_events` (`actor_kind = EMERGENCY`) by the emergency tooling when the database is writable                                                                                                                                 |
| Audit unavailable      | If the database cannot take the audit row (the reason for the emergency), the same record is written out of band (the authorization record plus a timed operator log) and inserted into the audit table after recovery, marked as reconstructed                                                               |
| After use              | The emergency credential is **rotated** after every use; a review records what was done and whether the normal path needs a fix                                                                                                                                                                               |
| Unavoidable limitation | Whoever holds a database credential can bypass every application control, including the audit trigger. Break-glass can be constrained by custody, environment and rotation, and detected only by database- or provider-level logging (OD-P18); it cannot be prevented by application code                     |

No emergency mechanism is implemented in C1A or C1B until OD-C1-6 and the database-role split exist. Until then the legacy
CLIs remain the de facto emergency path and are listed as gaps (section 9).

## 7. Authorization and audit contracts

### 7.1 Authorization

`requirePlatformPermission(headers, permission, { mutation })`: validated session → ACTIVE role rows of that user → matrix →
for mutations, 10-minute re-authentication (5.2) and the role row locked `FOR SHARE` in the operation's transaction. No
organization context is created. Requests never carry the actor. Targets are resolved server-side. Every route: same-origin
guard, content-type and size limits, strict Zod, dry run by default with explicit `apply`, existing typed confirmations kept.

### 7.2 Audit

`platform_audit_events` (insert-only):

`id, occurred_at (database clock), correlation_id, actor_kind (HUMAN | BOOTSTRAP | EMERGENCY), actor_user_id, action,
permission, outcome (SUCCEEDED | DENIED | FAILED), dry_run, target_organization_id, target_whatsapp_account_id, target_ref,
approval_ref, result_code, details jsonb, reconstructed boolean`

| Outcome              | Rule                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SUCCEEDED (a change) | Inserted **in the same transaction** as the change. No change commits without its audit row; an audit failure rolls the change back                                                                                         |
| Dry run              | Audited the same way with `dry_run = true` (nothing else commits)                                                                                                                                                           |
| DENIED, FAILED       | Written in a separate short transaction after the refusal or rollback, **best effort**. If that write fails, a security log line is emitted. A failed log write does not and cannot undo a denial; the request stays denied |
| No ATTEMPTED         | No C1 action has an external side effect, so success, denial and failure are exhaustive. An action with an external effect must add a write-ahead attempt row                                                               |

- **Service operations** (workers, retention, reconciler) are not human actions and are not written here; they keep their
  domain rows and logs. If a service later writes platform audit, it uses a distinct `actor_kind = SERVICE` with a service name,
  never a user id.
- `details` holds only whitelisted counts and fixed codes. Never message content, phone numbers, BSUIDs, names, tokens,
  passwords, secret values or request bodies.
- **Integrity:** an insert-only trigger (own function) refuses UPDATE and DELETE through the application. It does not stop a
  database credential holder or direct SQL; this plan does not claim coverage of direct SQL. Export to an append-only store
  belongs to C4.
- **Retention:** security-audit retention is a **pending owner decision** (OD-C1-5, with L-5). It is separate from the approved
  14-day diagnostic-log default (`P-LOG`) and from the other provisional defaults, none of which applies to this table.

## 8. Minimum schema and application changes (later migration; none made now)

| Change                                                                                                                                                                                                                                                                                                                                                                                                                               | Slice |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `platform_operator_roles(id, user_id → users.id, role CHECK (PLATFORM_OPERATOR, PLATFORM_SECURITY_ADMIN), status CHECK (ACTIVE, REVOKED), grant_kind CHECK (NORMAL, BOOTSTRAP, EMERGENCY), granted_by_user_id → users.id NULL only for BOOTSTRAP/EMERGENCY, verification_ref, granted_at, revoked_by_user_id, revoked_at)`; partial unique `(user_id, role) WHERE status = 'ACTIVE'`; CHECKs for revocation fields and no self-grant | C1A   |
| Guard trigger on it: UPDATE only ACTIVE → REVOKED setting `revoked_*`; no DELETE                                                                                                                                                                                                                                                                                                                                                     | C1A   |
| `platform_bootstrap(singleton)`                                                                                                                                                                                                                                                                                                                                                                                                      | C1A   |
| `platform_audit_events` (7.2), insert-only trigger, indexes `(occurred_at)`, `(actor_user_id, occurred_at)`; no `organization_id` column on any of these tables (platform-level)                                                                                                                                                                                                                                                     | C1A   |
| `src/modules/platform/`: `permissions.ts`, `access.ts` (`requirePlatformPermission`), `operators.ts` (grant, revoke, list), `audit.ts`                                                                                                                                                                                                                                                                                               | C1A   |
| Sign-in gate: ACTIVE membership **or** ACTIVE platform role                                                                                                                                                                                                                                                                                                                                                                          | C1A   |
| `resetStaffPassword`: refuse targets with an ACTIVE platform role                                                                                                                                                                                                                                                                                                                                                                    | C1A   |
| Routes `/api/platform/operators…` and `/api/platform/audit` through a platform variant of `handleApi`                                                                                                                                                                                                                                                                                                                                | C1A   |
| `platform:bootstrap-operator` CLI (single-use)                                                                                                                                                                                                                                                                                                                                                                                       | C1A   |
| Routes `/api/platform/{health,whatsapp-accounts,webhook-events}…` calling the existing services                                                                                                                                                                                                                                                                                                                                      | C1B   |
| CLI client (`scripts/platform.ts`, section 10)                                                                                                                                                                                                                                                                                                                                                                                       | C1B   |
| Legacy `whatsapp:accounts` / `whatsapp:events` removed from operator environments, or reduced to read-only, once the routes exist                                                                                                                                                                                                                                                                                                    | C1B   |

Transactions: one application transaction per mutation (role re-check, service call, SUCCEEDED audit). The migration is
additive; rollback before first use drops the new tables and functions; after use, audit rows are kept (forward-fix only).

## 9. Gaps that remain open after C1A (until C1B and beyond)

| Path                                                                           | Status after C1A                                                                 | Owner of the fix                      |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------- |
| `whatsapp:accounts`, `whatsapp:events`, `whatsapp:status`, `whatsapp:outbound` | **Open**: still `DATABASE_URL`, no individual authentication                     | C1B                                   |
| Direct SQL and any credential holder                                           | **Open**; also able to bypass C1A grants and audit                               | C1B + OD-C1-4 (credential withdrawal) |
| Emergency access                                                               | **Open** (legacy CLIs are the de facto emergency path)                           | C1B + OD-C1-6                         |
| `bots:admin --actor <email>`                                                   | **Open** (C1-G2)                                                                 | Separate checkpoint                   |
| `auth:bootstrap-admin`, `auth:intents`                                         | **Open**                                                                         | Provisioning track                    |
| Template registration                                                          | **Open**                                                                         | Later slice                           |
| Workers, `bots:retention`, `leads:reconcile`                                   | Service identities with `DATABASE_URL` (by design until the database-role split) | Infrastructure                        |
| MFA                                                                            | **Open**                                                                         | OD-C1-2                               |

C1A must not be reported as closing any of these.

## 10. CLI authentication (C1B prerequisite)

**Finding (static).** For requests carrying a cookie, Better Auth validates `Origin`/`Referer` against `trustedOrigins` (here
the single configured app origin) and rejects a missing or `null` origin (`api/middlewares/origin-check.mjs:96-117`). A first
sign-in without a cookie goes through the form-CSRF check, which reads browser Fetch-Metadata headers. A non-browser client
could therefore probably sign in by posting to `/sign-in/email` and then send the returned `__Secure-` cookie with an `Origin`
equal to the app origin. **This is not verified** (no request was made). The `bearer` plugin exists in the package but is not
configured and is not proposed.

Contract, to be proven before C1B is implemented:

- The password is read from a hidden interactive prompt only: never a shell argument, environment variable, file, log line or
  URL. The session cookie is held in process memory only, never written to disk or printed, and the CLI signs out at exit.
- HTTPS only, to the configured app origin; the CLI sends that origin explicitly and refuses any other base URL.
- Sign-in goes through the public, rate-limited `/sign-in/email`; the rate-limit deployment blocker (C1-G8: trustworthy client
  IP) must be resolved for this path.
- **C1B-P1:** an isolated test (disposable database, HTTPS with a throwaway certificate, like the existing E2E harness) proves
  the sign-in, the origin check, rate limiting and sign-out for a non-browser client. If it fails, or needs extra Better Auth
  configuration (for example another trusted origin, `bearer` or a CSRF change), that becomes an owner-reviewed decision; no
  working mechanism is assumed.

## 11. Slices and acceptance tests (future; not run)

**U** unit; **PG** isolated PostgreSQL with the real routes and Better Auth (never `al_ict_whatsapp`); **E2E** real HTTPS
harness.

### 11.1 C1A — Operator identity and authorization foundation

Scope: section 8 rows marked C1A. No operational route, no CLI client, no legacy change.

| ID      | Scenario                                                                                                                               | Expected                                                             | Type   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| C1A-T1  | Security admin (re-authenticated) grants `PLATFORM_OPERATOR` to another existing user                                                  | 200; grant row; SUCCEEDED audit in the same transaction              | PG     |
| C1A-T2  | Signed-in user without a platform role calls a platform route                                                                          | 403; DENIED audit (best effort)                                      | PG     |
| C1A-T3  | Tenant ADMIN (every tenant permission) calls platform routes                                                                           | 403                                                                  | PG + U |
| C1A-T4  | `PLATFORM_OPERATOR` calls grant, revoke-other, `audit.read_all`                                                                        | 403 each                                                             | PG + U |
| C1A-T5  | Spoofed identity in body, header or query; forged or foreign cookie                                                                    | Ignored or 401; actor is the session user                            | PG     |
| C1A-T6  | Self-assignment of any role, including the second role by a security admin                                                             | 409; no row; CHECK and trigger also refuse a direct insert           | PG     |
| C1A-T7  | Revocation: next request of the revoked operator; all sessions deleted                                                                 | 403 / 401; tenant access returns only after a new sign-in            | PG     |
| C1A-T8  | Mutation with a session created more than 10 minutes ago; expired or invalid session                                                   | 403 `REAUTHENTICATION_REQUIRED` / 401                                | PG     |
| C1A-T9  | Operator without membership calls tenant conversation and message routes                                                               | 403 (no AccessContext)                                               | PG     |
| C1A-T10 | Audit insert made to fail in a grant                                                                                                   | Grant rolled back; nothing committed                                 | PG     |
| C1A-T11 | Audit and role UPDATE or DELETE through the application role (other than ACTIVE → REVOKED)                                             | Refused by triggers                                                  | PG     |
| C1A-T12 | Concurrent revocation and grant by the revoked security admin                                                                          | One order only                                                       | PG     |
| C1A-T13 | Bootstrap run twice, concurrently, and after all grants were revoked; revoking the last security admin                                 | Exactly one bootstrap ever; later runs and last-admin revoke refused | PG     |
| C1A-T14 | Tenant ADMIN resets the password of a user holding a platform role                                                                     | Refused; after revocation of every role the normal reset works       | PG     |
| C1A-T15 | Every public `/api/auth/*` path that can change a credential, email, linked account, session data or token (including the C1-G10 list) | 404 or proven inert; any that is not is closed before C1A merges     | PG     |
| C1A-T16 | Operator without membership signs in; user with neither membership nor role signs in                                                   | Session created / refused                                            | PG     |
| C1A-T17 | Audit rows and responses scanned for content, phone, BSUID, token, password and secret fields                                          | None                                                                 | U + PG |
| C1A-T18 | Tenant and platform permission types are disjoint; tenant ADMIN set unchanged; matrix pinned                                           | Pinned                                                               | U      |

### 11.2 C1B — Protected operational entry points

Scope: section 8 rows marked C1B; prerequisite C1B-P1 (section 10) and OD-C1-4.

| ID     | Scenario                                                                                                              | Expected                                                             | Type   |
| ------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| C1B-T1 | Each action of section 4 marked C1B with exactly its permission; each with one fewer permission                       | Allowed with audit / 403                                             | PG     |
| C1B-T2 | `register` and `assign_unrouted` with targets validated server-side; ownership never re-homed                         | Existing refusals preserved                                          | PG     |
| C1B-T3 | Responses never contain secret values, payloads, phone numbers, BSUIDs or message content                             | None                                                                 | U + PG |
| C1B-T4 | CLI client: hidden password prompt only; no cookie on disk; sign-out at exit; refuses non-HTTPS and foreign base URLs | Verified                                                             | E2E    |
| C1B-T5 | Non-browser sign-in, origin check and rate limit (C1B-P1)                                                             | As section 10                                                        | E2E    |
| C1B-T6 | Concurrent revocation and requeue                                                                                     | One order only                                                       | PG     |
| C1B-T7 | Operator environment inspected: no `DATABASE_URL` or other privileged credential present                              | Verified by checklist and, where possible, by the deployment         | INFRA  |
| C1B-T8 | Legacy CLIs in an operator environment                                                                                | Absent or read-only; a state change through them is impossible there | INFRA  |
| C1B-T9 | End to end: sign in, re-authenticate, requeue, read own audit                                                         | Audit row matches the action                                         | E2E    |

## 12. Explicit exclusions

Any UI or dashboard; impersonation; tenant support access; billing, onboarding, SaaS administration; erasure approver
credentials and signed artifacts (C5); ledger custody, audit export, restoration (C4, C7); creating organizations or
membership-less users (provisioning track); `bots:admin` replacement (separate checkpoint); C2, C3, C4 work. Ordinary staff see
no operator concept anywhere in the Inbox.

## 13. Owner decisions and dependencies

| ID      | Decision                                                               | Recommendation (**RECOMMENDED, NOT YET OWNER-APPROVED**)                                                                                                                                | Needed for     |
| ------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| OD-C1-1 | Initial security admin                                                 | One explicitly designated **existing** Better Auth user, named by the owner at bootstrap time (no email or id is proposed here)                                                         | C1A            |
| OD-C1-3 | Roles                                                                  | Two roles as in section 4; one person may hold both while the team is small; this never satisfies a two-human rule; `assign_unrouted` may be restricted to security admins if preferred | C1A            |
| OD-C1-2 | MFA for operators                                                      | Required before production; mechanism chosen after verifying library support against ADR 0012                                                                                           | Pre-production |
| OD-C1-4 | Withdrawing privileged database credentials from operator environments | As part of C1B and hosting (OD-P18)                                                                                                                                                     | C1B            |
| OD-C1-5 | Security-audit retention                                               | Owner decision with L-5; separate from `P-LOG`                                                                                                                                          | Pre-production |
| OD-C1-6 | Emergency credential custody and execution environment                 | Sealed custody by the owner; isolated, access-logged environment; rotation after use                                                                                                    | C1B            |

Dependencies: hosting and trustworthy client IP for rate limiting (ADR 0012 deployment blocker, OD-P18); the database-role
split; the `npm audit` finding recorded in ADR 0012.

**Verdict: C1A READY FOR SEPARATE IMPLEMENTATION AUTHORIZATION once OD-C1-1 and OD-C1-3 are owner-approved. C1B is not ready:
it depends on C1B-P1, OD-C1-4 and OD-C1-6.**
