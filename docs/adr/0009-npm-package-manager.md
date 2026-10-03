# ADR 0009: npm as package manager

Status: Accepted

## Context

No concrete need for pnpm or yarn.

## Decision

Use npm with a committed `package-lock.json`; CI uses `npm ci`.
