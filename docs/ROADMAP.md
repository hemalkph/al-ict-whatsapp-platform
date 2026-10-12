# Roadmap

Status as of Phase 06 (the original plan is kept; each line says where it stands).

1. **Foundation:** done. Next.js + strict TS app, tooling, docs, ADRs, health endpoint, baseline tests, CI.
2. **Database milestone and authentication/authorization:** done (Phases 02-03). Drizzle on standard PostgreSQL, core schema with organization isolation, fixed roles and the access module. Production hosting provider still to be decided with deployment.
3. **WhatsApp integration:** done in the backend (Phases 04-05). Webhook intake, signature check, idempotent PostgreSQL queue, inbound messages and statuses, BSUID identity, and secure outbound messaging (single messaging service, window/consent policy, unknown-outcome handling). Nothing is deployed and no live Meta account is connected; templates outside the 24-hour window and BSUID sending remain blocked pending decisions (see PRE_PRODUCTION_BLOCKERS.md).
4. **Inbox:** done (Phase 06). Conversations, assignment, internal notes, tags, quick replies, unread tracking, status workflow, reply composer on the Phase 05 endpoint; bounded polling instead of realtime (the upgrade path is in ADR 0015).
5. **Leads and ad attribution:** next; attribution rows are already stored from referrals, lead creation is not built.
6. **Bot runtime, then Bot Studio.**
7. **Campaigns, consent and opt-out controls.**
8. **Registrations, batches, payments, attendance, analytics.**
