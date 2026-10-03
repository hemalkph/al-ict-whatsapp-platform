# A/L ICT WhatsApp Platform

Internal WhatsApp management platform for an A/L ICT education class: shared inbox, contacts, leads and students, a deterministic bot, and campaigns. It uses **only** the official Meta WhatsApp Business Platform Cloud API.

## Current stage

**Foundation only.** There are no WhatsApp features, database schema or authentication yet. See [docs/ROADMAP.md](docs/ROADMAP.md).

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

No `.env`, database or Docker is needed to run, test or build. `.env.example` lists reserved names only. Optional local PostgreSQL: `docker compose up -d`.

## Scripts

| Script                            | Purpose                                     |
| --------------------------------- | ------------------------------------------- |
| `npm run dev` / `build` / `start` | Next.js dev server, production build, start |
| `npm run lint`                    | ESLint                                      |
| `npm run typecheck`               | `tsc --noEmit`                              |
| `npm test`                        | Vitest (unit)                               |
| `npm run test:e2e`                | Playwright (no specs yet)                   |
| `npm run format` / `format:check` | Prettier                                    |
