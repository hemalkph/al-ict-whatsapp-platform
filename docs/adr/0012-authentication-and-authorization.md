# ADR 0012: Authentication, organization membership and authorization (Phase 03)

Status: Accepted (supersedes [ADR 0010](0010-better-auth-provisional.md))

## Context

The platform is an internal staff system (not a commercial SaaS) but `organization_id` is a hard security boundary (ADR 0005, ADR 0011). Authentication and authorization must exist before contacts, leads, conversations, messages or WhatsApp accounts are exposed. The database provider is undecided, so identity must not depend on Supabase or any provider. Library behavior below was verified empirically against the installed packages (Phase 03, checkpoint 1) rather than assumed.

## Decision

**Library.** Better Auth **1.7.7** with the separate Drizzle adapter **`@better-auth/drizzle-adapter` 1.7.7**, email + password only, plus `zod` 4.6.5 for input validation. Versions are pinned exactly; the schema-generation CLI is always `npx auth@<installed version> generate` (the CLI depends on the exact same `better-auth` version). **No Better Auth Admin plugin and no Organization plugin**: roles are per-organization application data, impersonation is unwanted, and `organizations` already exists. No Auth.js, no Supabase Auth, no custom crypto.

**Sessions.** Database sessions (opaque token in an HttpOnly, SameSite=Lax cookie, `Secure` + `__Secure-` prefix over HTTPS). The session cookie cache stays **disabled** so suspension, role changes and revocation apply on the next request. Roles and permissions never live in the cookie or session; they are resolved from `organization_memberships` per request.

**Two Better Auth instances built from one shared base configuration** (allowed differences listed explicitly):

- **Public auth instance** — the only instance ever passed to `toNextJsHandler()` at `/api/auth/*`. Email/password enabled, **`disableSignUp: true`**, normal sign-in / sign-out / get-session / change-password.
- **Private provisioning instance** — server-only, **never mounted to any HTTP route**. Sign-up is enabled on it solely because Better Auth core has no create-user API (verified: `disableSignUp` blocks the server-side `auth.api.signUpEmail` too), and `autoSignIn: false`. Used only by the staff-provisioning and first-admin bootstrap services. It must not be exported from the public auth module barrel; an ESLint import boundary will forbid `src/app/**` from importing the provisioner (implemented with the instances).
- Because `autoSignIn: false` makes a duplicate email return a successful-looking response with a fabricated user id, provisioning code must itself check that the email is unused beforehand and verify afterwards that the returned id matches the stored user.

**Required invariant: the Drizzle adapter MUST be configured with `transaction: true`.** The adapter default (`false`) was shown to leave a user without its credential account when a failure occurs between the two inserts; with `true` they roll back together. Better Auth's transaction cannot join an application transaction, so atomicity across "auth user + membership" is NOT available; recovery is handled by provisioning intents (below). Every adapter wiring must also pass an explicit `schema` mapping with `usePlural: false` and explicit model names (`users`, `sessions`, `accounts`, `verifications`, `rate_limits`; the adapter looks tables up by model name, so `rate_limits: rateLimits`). Do not combine plural model names with `usePlural: true` (it looks for `userss`).

**Application-owned tables** (migration `0001_auth_and_access_foundation`):

- `organization_memberships` — user ↔ organization with `role` (ADMIN, STAFF, VIEWER) and `status` (ACTIVE, SUSPENDED), `UNIQUE (organization_id, user_id)` and `UNIQUE (organization_id, id)`. No invitations, no REMOVED state; offboarding is SUSPENDED. FK actions are NO ACTION. A user with no ACTIVE membership has zero application access. Users are global identities, memberships are organization-specific; multi-organization account management is not enabled (an org admin never gains authority over a shared identity).
- `user_security_state` — global per-user application security state (`password_change_required`); not an additional field of the library `users` table, and without `organization_id`.
- `staff_provisioning_intents` — a short-lived, recoverable coordinator (not an audit log, not a workflow engine). Every provisioning path must insert the intent **before** calling the private instance; `email_key` (trim + lowercase) is globally unique; `requested_by_membership_id` is nullable (first-admin bootstrap) and, when set, must belong to the same organization (composite FK); `auth_user_id` is filled once Better Auth has created the user. The row is deleted only after the membership exists. If the process dies after Better Auth committed the user but before the membership was created, a retry holding the same organization's intent reconciles the existing user; no other organization can insert an intent for that email, so no other organization can claim the identity. No credential material is stored.

**Mandatory provisioning order (future `createStaff` and first-admin bootstrap).**

1. Acquire the globally-unique `staff_provisioning_intents` row for the normalized (trim + lowercase) email.
2. Call the **private**, server-only Better Auth provisioner (a duplicate email returns a fabricated success, so check the email is unused first and verify the returned id matches the stored user).
3. Better Auth runs on the Drizzle adapter with `transaction: true`, so the user and its credential account are atomic with each other.
4. After Better Auth succeeds, run **one application database transaction** that: locks and revalidates the intent; reconciles/sets `auth_user_id`; creates `user_security_state` with `password_change_required = true`; creates the ACTIVE `organization_memberships` row; and deletes the intent only after the membership and security state exist.
5. Commit. The ACTIVE membership and `password_change_required = true` therefore become visible atomically.

Fail-closed behavior: if Better Auth fails, the intent remains and there is no membership. If the process dies after Better Auth commits, the intent remains and the user has zero ACTIVE memberships. If the application transaction fails, the intent remains and the user has zero ACTIVE memberships. A retry by the **same** intent/organization may reconcile the user; another organization may never claim that global identity. A reconcile step must additionally refuse a user that already has any membership in any organization (the intent being deleted after completion means the uniqueness of `email_key` alone does not protect an established identity: that is covered by this guard and by the existing-user check).

**Library-owned tables**: `users`, `sessions`, `accounts` (credential password hash: `provider_id = 'credential'`, `account_id = user id`, scrypt `salt:key`), `verifications`, `rate_limits`. Shapes follow the generated schema; conventions applied: uuid PKs (`generateId: "uuid"`), `timestamptz`, snake_case index names. Plain `UNIQUE(email)` as the library requires; the library lowercases emails and our inputs are normalized with trim + lowercase. No `citext`, no `CHECK (email = lower(email))`, no plugin columns. The Drizzle schema in the repository is authoritative: the Better Auth CLI only generates into a scratch file for diffing, `drizzle-kit` produces migrations, and Better Auth's own `migrate` is never run.

**Roles and permissions.** Fixed roles ADMIN / STAFF / VIEWER with a permission matrix defined in application code and queried only through `can(ctx, permission)`; no raw role comparisons outside the access module; no permission tables.

**Public auth surface.** The public instance keeps sign-in, sign-out, get-session, change-password and the session operations the app needs. The following must be disabled unless explicitly introduced later: `/sign-up/email`, `/update-user`, `/change-email`, `/delete-user`, `/link-social`, `/request-password-reset`, `/reset-password`, `/set-password`. Verified defaults: change-email, delete-user and password reset are already disabled/inert; `/update-user` allows self-editing `name`/`image` and must be closed; `/sign-up/email` is blocked by `disableSignUp`. Closing paths additionally via `disabledPaths` is defense in depth, never the primary sign-up protection.

**Authorization.** Server-side only: organization context comes from the validated session plus an ACTIVE membership; `organization_id`, role and membership ids from the browser are never trusted; foreign-organization resource ids yield 404. `proxy.ts` is optimistic (cookie presence via `getSessionCookie()`) and never an authorization decision.

**Rate limiting.** Better Auth's database-backed limiter (`rate_limits`) with a strict sign-in rule; no `login_throttles` table. It applies to HTTP requests only (server-side `auth.api` calls bypass it), is enabled by default only in production, and **skips requests that carry no client IP**.

**Deployment blocker.** Before production exposure the deployment topology must define trustworthy client-IP propagation (so the limiter keys on a real IP, and a missing IP cannot silently disable it) and platform/WAF rate limiting. Proxy/forwarded headers are not trusted until then.

**RLS** is deferred (one privileged application DB role; composite FKs already protect references; revisit when the first read-heavy module lands and the deployment provider is known).

## Implementation notes (checkpoint 3: auth core + access core)

- Code: `src/modules/auth` (`env.ts`, `base-config.ts`, `public-instance.ts`, `provisioning.ts`, `session.ts`) and `src/modules/access` (`permissions.ts`, `access.ts`); helpers in `src/shared/errors/http-errors.ts` and `src/shared/security/*`.
- Auth environment (`BETTER_AUTH_SECRET` >= 32 chars, `BETTER_AUTH_URL`, https required in production) is validated only when an instance is first created; importing modules and building the app need no auth env. `.env.example` has commented placeholders only.
- The shared base configuration pins: adapter `transaction: true`, explicit schema mapping, `usePlural: false`, uuid ids, database sessions, cookie cache disabled, 7-day sliding sessions (`updateAge` 1 day), 12-128 character passwords, database rate limiter (sign-in 5 per 60 s per IP), and the `session.create.before` gate. Tests assert that the public and private options differ only in `disableSignUp`, `autoSignIn` and `disabledPaths`.
- Public surface closed via `disabledPaths`: `/sign-up/email`, `/update-user`, `/change-email`, `/delete-user`, `/delete-user/callback`, `/link-social`, `/request-password-reset`, `/reset-password`, `/set-password`; changeEmail and deleteUser are also disabled by option and no `sendResetPassword` exists. The parameterized `/reset-password/:token` callback cannot be listed (exact-path matching) and is inert; this is tested.
- `session.create.before` refuses a session for a user without an ACTIVE membership. Trade-off: a user who supplies the **correct** password but has no ACTIVE membership receives `FAILED_TO_CREATE_SESSION` instead of the generic invalid-credentials error. This reveals nothing to someone without the password. It is defense in depth only; `requireAccess()` is authoritative on every request.
- `requireAccess()` resolves the ACTIVE membership from PostgreSQL each call: 0 ACTIVE -> 403, >1 ACTIVE -> 409 (no selector yet), `password_change_required = true` -> 403 `PASSWORD_CHANGE_REQUIRED` (missing row = false; only the explicit `allowPasswordChangeRequired` option used by the future password-change flow bypasses it).
- Deferred: per-request memoization of session lookups (React `cache`) and the `nextCookies()` plugin until routes/server actions exist; no organization switching; no absolute session cap (7-day sliding only).

## Known unresolved issue (must be resolved before production deployment)

`npm audit --omit=dev` reports **4 moderate** findings: `better-auth` declares `drizzle-kit` as an optional peer dependency, so a production-style `npm ci --omit=dev` installs `drizzle-kit` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild@0.18.20`, which is affected by the esbuild dev-server advisory (GHSA-67mh-4wv8-2f99). No application code imports `drizzle-kit`, but this is not considered harmless: it is recorded as unresolved, with no override or dependency change made yet.

## Consequences

Provisioning is safe against a failed partial create and against cross-organization identity capture, at the cost of one small coordination table and an explicit two-instance configuration that must be kept in sync (shared base config; differences enumerated and tested). The production dependency tree includes `drizzle-kit` (and its older `esbuild`) because `better-auth` declares it as an optional peer; this is evidence recorded for review, not mitigated here.
