# Deployment

Production deployment is **provider-neutral during Foundation**. No Cloudflare/OpenNext/wrangler configuration exists. Detailed deployment integration is handled in the deployment milestone.

## Preferences

- Cloudflare-compatible hosting preferred; avoid Node-only dependencies where reasonable.
- Database: standard PostgreSQL accessed through Drizzle. Production hosting provider **TBD** in the database/deployment milestone (candidates include Supabase PostgreSQL and Neon PostgreSQL; neither is selected).
- Realtime for the shared inbox (e.g. Supabase Realtime) is a later evaluation, not an architectural dependency.
- Media: Cloudflare R2 is a future candidate.
- GitHub and GitHub Actions for source and CI. No Redis, Kafka, or Kubernetes.

## Local development

No database or Docker is needed to run, test or build. Optional local PostgreSQL: `docker compose up -d` (see `docker-compose.yml`), or a hosted development database. `DATABASE_URL` (and optionally `DATABASE_MIGRATION_URL`, a direct connection used only by `npm run db:migrate`) are placeholders in `.env.example`.

## Deployment blockers (must be resolved before production exposure)

- **Client IP and rate limiting:** Better Auth's database-backed rate limiter keys on the client IP and silently skips requests that have none. The topology (proxy/CDN/platform) must define a trustworthy client-IP header and platform/WAF rate limiting before the login endpoint is exposed. Proxy headers are not trusted until then.

- **Migration 0002 must be applied before any webhook data exists.** It adds `webhook_requests.raw_body bytea NOT NULL` with no default and no backfill and then drops `raw_payload`, so it fails (safely, atomically, SQLSTATE 23502) if the table already holds a row. Apply `0002` first, then deploy the version that contains the webhook route. If webhook data could already exist, stop and decide its fate; never convert the jsonb into pretend wire bytes. See ADR 0013.

## CI

`.github/workflows/ci.yml` has two jobs, neither needs secrets. `verify`: install, lint, typecheck, test, build. `database`: a disposable `postgres:17` service container with test credentials only; runs `db:check`, a schema/migration drift check (`db:generate` must leave `src/db/migrations/` untouched, including untracked files), `db:migrate` from an empty database, then `test:db`.

## Worker shutdown reliability checkpoint

All three standalone workers require Node **24 or newer** (`.nvmrc`: 24) and the locked runtime dependency **tsx 4.23.15**. Run from the repository root so the loader finds `tsconfig.json`, `@/*` aliases and the optional `.env.local`. The worker commands are:

```sh
node --env-file-if-exists=.env.local --import tsx scripts/bots-worker.ts
node --env-file-if-exists=.env.local --import tsx scripts/whatsapp-worker.ts
node --env-file-if-exists=.env.local --import tsx scripts/whatsapp-outbound-worker.ts
```

These are also the corresponding `bots:worker`, `whatsapp:worker` and `whatsapp:outbound-worker` package commands. A production supervisor must execute the Node command directly, or use a shell that `exec`s it, with the repository root as its working directory. Supervising `npm` adds a signal-forwarding boundary that has not been validated. Do not use the tsx CLI for these long-running workers: the controlled comparison on Node 24.21.0/tsx 4.23.15 observed its application child being killed with SIGKILL after missing the CLI's two 30 ms acknowledgement windows, with wrapper exit 143/130. See the [checkpoint evidence](WORKER_SHUTDOWN_RELIABILITY.md).

The first SIGTERM/SIGINT stops new claims. Claims already started settle under their existing lease/fencing rules; in-flight work drains before the pool closes once. The original **35 s bot / 70 s webhook / 30 s outbound** deadline includes pool closure. Repeated signals do not restart it. Exit 0 requires successful closure; rejection, synchronous cleanup failure or deadline expiry exits 1; existing configuration refusals exit 2. Fixed-field drain/close telemetry distinguishes those phases; raw errors and credentials are never printed.

On forced termination, inbound events remain durably leased and bot transactions roll back with fenced lease recovery. Interrupted outbound `SENDING` requests recover after the existing five-minute recovery age to final `UNKNOWN_OUTCOME`; they are never automatically resent. Recovery does not establish whether a remote recipient received the request.

**OPEN PRE-PRODUCTION GATE:** No actual production supervisor or host is selected in this repository. Before live activation, validate its signal forwarding, PID/process-group targeting, normal stop, restart, rolling replacement if applicable, force-kill behavior, connection cleanup and durable recovery in an isolated deployment-equivalent environment. The previously suggested 90-second external timeout remains provisional and unapproved. Local process tests do not close this gate. A fresh target-host install, OS behavior and supervisor configuration still require deployment validation; no production deployment was performed.
