# Deployment

Production deployment is **provider-neutral during Foundation**. No Cloudflare/OpenNext/wrangler configuration exists. Detailed deployment integration is handled in the deployment milestone. The owner has selected **Cloudflare + Cloudflare Tunnel** as the target ingress (Phase 08G-7B C1B-P3); nothing of it is deployed or configured (see "Target ingress" below).

## Preferences

- Cloudflare-compatible hosting preferred; avoid Node-only dependencies where reasonable.
- Database: standard PostgreSQL accessed through Drizzle. Production hosting provider **TBD** in the database/deployment milestone (candidates include Supabase PostgreSQL and Neon PostgreSQL; neither is selected).
- Realtime for the shared inbox (e.g. Supabase Realtime) is a later evaluation, not an architectural dependency.
- Media: Cloudflare R2 is a future candidate.
- GitHub and GitHub Actions for source and CI. No Redis, Kafka, or Kubernetes.

## Local development

Signing in on a local development server needs `BETTER_AUTH_LOCAL_INGRESS=loopback` in `.env.local` (there is no Cloudflare in front to supply the client IP; see "Target ingress"). Start it with `npm run dev`, which binds to `127.0.0.1` only. The fallback does not verify who is connecting: never use it with `next dev` on another hostname (`-H 0.0.0.0`), port forwarding, a tunnel or a development server other people can reach. No database or Docker is needed to run, test or build. Optional local PostgreSQL: `docker compose up -d` (see `docker-compose.yml`), or a hosted development database. `DATABASE_URL` (and optionally `DATABASE_MIGRATION_URL`, a direct connection used only by `npm run db:migrate`) are placeholders in `.env.example`.

## Deployment blockers (must be resolved before production exposure)

- **Client IP and rate limiting:** the application side is implemented, the ingress side is not. See "Target ingress" below; every item under "Required infrastructure" and "Acceptance gates" is open.

- **Migration 0002 must be applied before any webhook data exists.** It adds `webhook_requests.raw_body bytea NOT NULL` with no default and no backfill and then drops `raw_payload`, so it fails (safely, atomically, SQLSTATE 23502) if the table already holds a row. Apply `0002` first, then deploy the version that contains the webhook route. If webhook data could already exist, stop and decide its fate; never convert the jsonb into pretend wire bytes. See ADR 0013.

## Target ingress: Cloudflare + Cloudflare Tunnel (selected, NOT deployed)

```
Internet -> Cloudflare edge -> Cloudflare Tunnel -> Next.js -> Better Auth -> PostgreSQL
```

**Implemented in application code (Phase 08G-7B C1B-P3, ADR 0012 amendment):**

- The client IP (sign-in limiter bucket, `sessions.ip_address`) is read only from `CF-Connecting-IP`. `X-Forwarded-For`, `X-Real-IP` and `Forwarded` are ignored.
- `/api/auth/*` and `POST /api/account/change-password` answer 403 `CLIENT_IP_REQUIRED` / `FORBIDDEN` when the header is missing, malformed or carries more than one value. Nobody can sign in through a path that does not supply it. This is intended: a 403 on sign-in after deployment means the ingress is not delivering the header.
- `BETTER_AUTH_LOCAL_INGRESS` must not be set in any deployed environment; the application refuses to start its auth instance if it is set with `NODE_ENV=production` or a non-loopback `BETTER_AUTH_URL`.

**Required infrastructure (NOT implemented; none of it exists):**

1. Cloudflare must control `CF-Connecting-IP`: the edge sets it to the connecting client and overwrites any value the client sent. Verify how the chosen plan and any Cloudflare-to-Cloudflare or Worker hop treat a client-supplied value.
2. Cloudflare Tunnel (`cloudflared`) is the only authorized ingress to the application.
3. Direct-origin access is prevented by network topology: the application listens only where `cloudflared` can reach it (loopback or a private network), with no public listener, port mapping or alternative hostname. A header name or a shared secret is not a substitute, and no proxy IP ranges are trusted by the application.
4. Cloudflare edge throttling on `POST /api/auth/sign-in/email` (and ceilings for `/api/auth/*`, `/api/account/*`, `/api/staff/*`), configured and tested. The in-app limiter is per client IP only; there is no per-account throttle.
5. Staging tests that prove the above (next list).

**Acceptance gates on a real staging Cloudflare + Tunnel deployment (all open):**

- A sign-in through the public hostname records the tester's real public address in `sessions.ip_address` and in the `rate_limits` key (IPv4, and IPv6 as its /64).
- A client that sends its own `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP` and `Forwarded` through the public hostname still gets its real address recorded, and six attempts with varying forged values end in 429.
- Two clients on different networks have separate buckets; one client's 429 does not affect the other.
- The origin cannot be reached from the internet or from another tenant of the host network except through the tunnel (port scan and direct requests with a forged `CF-Connecting-IP`).
- Edge throttling triggers at its configured threshold and is visible in Cloudflare's logs; the application's 429 still works behind it.
- The Meta webhook, `/api/health` and the staff application work through the tunnel; the webhook signature check is unaffected.
- `BETTER_AUTH_LOCAL_INGRESS` is absent from the staging and production environments.

Until these pass, the client-IP spoofing weakness is closed only for requests that actually arrive through a correctly configured tunnel, which today is none.

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
