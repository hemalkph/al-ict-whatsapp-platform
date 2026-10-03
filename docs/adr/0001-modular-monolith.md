# ADR 0001: Modular monolith

Status: Accepted

## Context

A small team needs fast delivery and simple operations, but domains (messaging, bots, campaigns) must stay separable.

## Decision

One repository and one deployable Next.js app, organized into domain modules with public APIs (`src/modules/<name>/index.ts`). No microservices. Boundaries are enforced by convention plus a simple lint rule.
