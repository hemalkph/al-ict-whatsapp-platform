# ADR 0005: Organization isolation from day one

Status: Accepted

## Context

Only one organization exists now, but retrofitting isolation later is costly and risky.

## Decision

Important records carry `organization_id` and every query is scoped by organization. This is isolation, not a commercial multi-tenant SaaS: no subscriptions, billing, reseller management or per-plan limits.
