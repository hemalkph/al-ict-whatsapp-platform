# ADR 0003: Next.js App Router with strict TypeScript

Status: Accepted

## Context

We need one codebase for UI and API, with strong typing.

## Decision

Next.js (App Router), React, Tailwind CSS, shadcn/ui, TypeScript with `strict`, `noUncheckedIndexedAccess` and `noImplicitOverride`; `any` is banned by ESLint. Node.js LTS (24). Vitest for unit/integration tests, Playwright for E2E.
