# Security

Security is a first-class requirement. The authentication and authorization architecture is decided in [ADR 0012](adr/0012-authentication-and-authorization.md) (schema defined; services, routes and UI not implemented yet). Targets for the implementation milestones:

- Server-side authorization on every operation; organization isolation; protection against IDOR, privilege escalation and mass assignment.
- Secure authentication and session cookies; password hashing handled by the auth library (Better Auth 1.7.7, scrypt; no custom crypto). Database sessions with the cookie cache disabled; HttpOnly, SameSite=Lax, Secure in production.
- No public sign-up. Staff are provisioned only through a private, never-HTTP-mounted Better Auth instance, guarded by a unique provisioning intent so one organization can never claim another's identity. The Drizzle adapter must use `transaction: true`.
- Organization context is derived from the session plus an ACTIVE `organization_memberships` row, never from browser input; fixed roles ADMIN / STAFF / VIEWER with a permission matrix in code; 404 for foreign-organization ids.
- Provisioning order (see ADR 0012): acquire the unique provisioning intent → private Better Auth provisioner (`transaction: true`) → one application transaction that sets `auth_user_id`, creates `user_security_state` (`password_change_required = true`) and the ACTIVE membership, then deletes the intent. Every failure leaves the intent in place and the user with zero ACTIVE memberships; another organization can never claim the identity.
- **Unresolved before production:** `npm audit --omit=dev` reports 4 moderate findings (optional `drizzle-kit` peer of `better-auth` → `@esbuild-kit` → old `esbuild` dev-server advisory); not harmless-by-assumption, no mitigation applied yet.
- Implemented (checkpoint 3): `requireUser` / `requireAccess` / `requirePermission` build an `AccessContext` only from the validated session plus the ACTIVE membership read from PostgreSQL on every call (0 ACTIVE: 403, >1 ACTIVE: 409, `password_change_required`: 403). Security events go through `emitSecurityEvent` (whitelisted fields only; no passwords, tokens or bodies). Same-origin and redirect validators live in `src/shared/security`. `src/app/**` cannot import `@/db` or the private provisioner.
- Generic user-mutation endpoints (`/update-user`, `/change-email`, `/delete-user`, `/link-social`, password-reset and `/set-password`) stay disabled unless explicitly introduced.
- **Deployment blocker:** Better Auth's rate limiter skips requests without a client IP and ignores server-side calls. Before production exposure, define trustworthy client-IP propagation and platform/WAF rate limiting; do not trust arbitrary proxy headers meanwhile.
- Secrets only in server-side environment variables; nothing in frontend bundles; never logged.
- Webhook `X-Hub-Signature-256` verification before any processing.
- Zod validation at every trust boundary; parameterized database access only.
- CSRF protection where applicable; API rate limiting; output encoding.
- Audit logging for sensitive actions; safe structured logs without credentials or needless message content.
- Secure media/file handling (object storage, validated types and sizes).
- Least privilege for database roles and API tokens.

Reporting: this is an internal project; report issues to the repository owner.
