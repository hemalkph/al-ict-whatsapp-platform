# A/L ICT WhatsApp Platform

Internal WhatsApp management platform for an A/L ICT education class: shared inbox, contacts, leads and students, a deterministic bot, and campaigns. It uses **only** the official Meta WhatsApp Business Platform Cloud API.

## Current stage

**Backend and staff inbox implemented; not deployed.** The database schema, staff authentication, the inbound WhatsApp pipeline, secure outbound messaging (queue only, real sending is off by default) and the staff inbox at `/inbox` exist. There is no live Meta connection, bot, campaign or student workflow, and nothing is production-ready. See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/PRE_PRODUCTION_BLOCKERS.md](docs/PRE_PRODUCTION_BLOCKERS.md).

## Architecture

Modular monolith: one Next.js (App Router) + strict TypeScript codebase.

- `src/app/`: routes (UI and API)
- `src/modules/`: domain modules, imported only through their public `index.ts`
- `src/shared/`: small cross-cutting code (errors, logging)

Direction: Next.js → Drizzle → PostgreSQL (standard PostgreSQL; production hosting provider TBD). Details in [docs/](docs/): [ARCHITECTURE](docs/ARCHITECTURE.md), [DATABASE_DESIGN](docs/DATABASE_DESIGN.md), [SECURITY](docs/SECURITY.md), [WHATSAPP_INTEGRATION](docs/WHATSAPP_INTEGRATION.md), [BOT_ENGINE](docs/BOT_ENGINE.md), [TESTING_STRATEGY](docs/TESTING_STRATEGY.md), [DEPLOYMENT](docs/DEPLOYMENT.md), and decisions in [docs/adr/](docs/adr/).

## Local setup

Requires Node.js 24 (`.nvmrc`).

```bash
npm ci
npm run dev   # http://localhost:3000, health: /api/health
```

Building and the unit tests need no `.env`, database or Docker. Using the app (`/login`, `/inbox`) and `npm run test:db` / `npm run test:e2e` need PostgreSQL (`docker compose up -d`; the tests create and drop their own disposable databases and never touch your development database). `.env.example` lists the variables, including the inbox polling intervals (`INBOX_POLL_LIST_MS`, `INBOX_POLL_CHAT_MS`, optional). The staff inbox is at `/inbox` after signing in; it can queue replies only when `WHATSAPP_OUTBOUND_ENABLED=true`, and nothing is sent to WhatsApp unless the separate outbound worker is also enabled (see [docs/RUNBOOK_WHATSAPP.md](docs/RUNBOOK_WHATSAPP.md)).

## Scripts

| Script                            | Purpose                                     |
| --------------------------------- | ------------------------------------------- |
| `npm run dev` / `build` / `start` | Next.js dev server, production build, start |
| `npm run lint`                    | ESLint                                      |
| `npm run typecheck`               | `tsc --noEmit`                              |
| `npm test`                        | Vitest (unit)                               |
| `npm run test:e2e`                | Browser E2E (Playwright + disposable DB)    |
| `npm run format` / `format:check` | Prettier                                    |
