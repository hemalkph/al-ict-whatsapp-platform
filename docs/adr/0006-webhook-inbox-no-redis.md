# ADR 0006: Webhook inbox in PostgreSQL, async processing, no Redis

Status: Accepted

## Context

Meta requires fast webhook acknowledgment, may deliver events more than once, and may reorder them.

## Decision

Verify the signature, persist the raw event in `webhook_events` keyed by Meta identifiers (idempotency), acknowledge immediately, and process asynchronously. Use PostgreSQL as the queue/inbox for now; no Redis, Kafka or other infrastructure until measured need.
