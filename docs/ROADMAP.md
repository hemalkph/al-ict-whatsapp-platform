# Roadmap

1. **Foundation (current):** Next.js + strict TS app, tooling, docs, ADRs, health endpoint, baseline tests, CI.
2. **Database milestone:** Add Drizzle and use standard PostgreSQL with optional local development, and choose the production hosting provider (candidates include Supabase PostgreSQL and Neon PostgreSQL; decided with deployment). Design and implement the core schema and tenant isolation. Decide the roles model and assignment history. Then implement authentication/authorization before WhatsApp webhook functionality.
3. **WhatsApp integration:** webhook intake, signature check, idempotent async processing, messaging service and compliance guard, templates.
4. **Inbox:** conversations, assignment, notes, tags, quick replies; evaluate realtime options (e.g. Supabase Realtime) if needed.
5. **Leads and ad attribution.**
6. **Bot runtime, then Bot Studio.**
7. **Campaigns, consent and opt-out controls.**
8. **Registrations, batches, payments, attendance, analytics.**
