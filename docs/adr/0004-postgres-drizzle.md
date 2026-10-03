# ADR 0004: PostgreSQL via Drizzle; hosting provider TBD

Status: Accepted

## Context

Relational data with strict integrity fits the domain. The production PostgreSQL hosting provider is not chosen at Foundation stage.

## Decision

Access PostgreSQL through Drizzle ORM using standard PostgreSQL only, with no provider-specific coupling. The production provider is decided in the database/deployment milestone (candidates include Supabase PostgreSQL and Neon PostgreSQL). Optional local PostgreSQL via Docker. Drizzle is not installed during Foundation.
