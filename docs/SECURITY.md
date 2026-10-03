# Security

Security is a first-class requirement. Targets for the implementation milestones (none implemented yet):

- Server-side authorization on every operation; organization isolation; protection against IDOR, privilege escalation and mass assignment.
- Secure authentication and session cookies; password hashing handled by the auth library (Better Auth is provisional).
- Secrets only in server-side environment variables; nothing in frontend bundles; never logged.
- Webhook `X-Hub-Signature-256` verification before any processing.
- Zod validation at every trust boundary; parameterized database access only.
- CSRF protection where applicable; API rate limiting; output encoding.
- Audit logging for sensitive actions; safe structured logs without credentials or needless message content.
- Secure media/file handling (object storage, validated types and sizes).
- Least privilege for database roles and API tokens.

Reporting: this is an internal project; report issues to the repository owner.
