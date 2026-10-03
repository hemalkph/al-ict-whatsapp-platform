# Deployment

Production deployment is **provider-neutral during Foundation**. No Cloudflare/OpenNext/wrangler configuration exists. Detailed deployment integration is handled in the deployment milestone.

## Preferences

- Cloudflare-compatible hosting preferred; avoid Node-only dependencies where reasonable.
- Database: standard PostgreSQL accessed through Drizzle. Production hosting provider **TBD** in the database/deployment milestone (candidates include Supabase PostgreSQL and Neon PostgreSQL; neither is selected).
- Realtime for the shared inbox (e.g. Supabase Realtime) is a later evaluation, not an architectural dependency.
- Media: Cloudflare R2 is a future candidate.
- GitHub and GitHub Actions for source and CI. No Redis, Kafka, or Kubernetes.

## Local development

No database or Docker is needed to run, test or build. Optional local PostgreSQL: `docker compose up -d` (see `docker-compose.yml`), or a hosted development database.

## CI

`.github/workflows/ci.yml`: install, lint, typecheck, test, build. No secrets required.
