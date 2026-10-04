# ADR 0010: Better Auth (provisional)

Status: Superseded by [ADR 0012](0012-authentication-and-authorization.md)

## Context

We need mature server-side TypeScript authentication with secure sessions, without Supabase Auth.

## Decision

Better Auth is the provisional choice and is not installed yet. Confirm during the authentication milestone. Fall back to another mature server-side TypeScript auth library if Better Auth cannot meet session security, Drizzle/PostgreSQL integration, or maintenance needs. The roles/permissions model is deliberately not decided here (see DATABASE_DESIGN.md).
