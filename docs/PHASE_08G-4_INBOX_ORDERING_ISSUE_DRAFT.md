# Inbox timeline can display inbound replies before preceding bot prompts

Priority: P3. Scope: Inbox timeline display and ordering. Status: DRAFT for the owner to record in the project tracker (not created anywhere).

## Observed

In Phase 08G-4 synthetic PostgreSQL acceptance, `listMessages()` returned a student's list selection before the bot's welcome and category list that preceded it (IN keyword, IN selection, OUT welcome, OUT list, OUT notice).

## Cause (from source)

- Inbound `occurred_at` is the provider's epoch-seconds timestamp (`src/modules/whatsapp/time.ts` `parseProviderTimestamp`, stored in `src/modules/whatsapp/inbound/handler.ts`).
- Outbound `occurred_at` is the server's millisecond clock at enqueue (`src/modules/messaging/enqueue.ts`, `occurredAt: now`).
- `listMessages()` orders by `occurred_at` with an id tie-breaker (`src/modules/inbox/timeline.ts`).
- A reply recorded in the same second as a prompt can therefore sort before that prompt. Clock skew between provider and server could do the same.

## Impact

Genuine user-facing impact is plausible but has NOT been reproduced in a browser or with real provider events. Persistence and Bot Runtime state are not known to be corrupted; only display order is affected. The test that exposed it used a kit that floors the student's timestamp to the second.

## Possible directions (need separate evaluation)

Provider timestamps versus server arrival time, causal relationships (reply-to links), pagination cursors, and historical ordering of existing rows. Clamping timestamps is not assumed to be safe: it changes cursors and stored history semantics.

## Not done

No production change. No existing test documents or covers mixed inbound/outbound ordering within one second.
