# ADR 0008: Provider-neutral deployment

Status: Accepted

## Context

Cloudflare-compatible hosting is preferred, but the host is not final.

## Decision

No Cloudflare/OpenNext/wrangler configuration during Foundation. Avoid unnecessary Node-only dependencies where reasonable. Deployment integration happens in the deployment milestone.
