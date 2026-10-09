# WhatsApp operations runbook

Audience: the operator of this platform. Everything here is a local command-line tool that talks only to the platform's own PostgreSQL database (`DATABASE_URL`). **Nothing here calls Meta, sends a message, connects a real WhatsApp account or configures a webhook subscription**, and nothing starts the worker for you. The platform is **not production-ready** (see `PRE_PRODUCTION_BLOCKERS.md`).

All commands print **exactly one JSON document on stdout** (the result). Audit and diagnostic log lines, such as `operator.account_activated`, go to **stderr**, so `npm run whatsapp:status | jq` and scripts that parse stdout are safe; capture stderr separately if you want the log. Tests run the real scripts and parse stdout as one document. **Every command that changes state is a dry run unless you add `--apply`**: it runs the real code in a transaction and rolls it back, so the preview is exactly what `--apply` would do. Exit codes: `0` success, `1` refused (nothing changed), `2` usage error.

| Command                                                | Purpose                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `npm run whatsapp:accounts -- <command>`               | register, inspect, list, activate, enable, disable, archive WhatsApp accounts |
| `npm run whatsapp:events -- <command>`                 | inspect and release held events, review DEAD events                           |
| `npm run whatsapp:status [-- --check]`                 | pipeline health and the findings that need attention                          |
| `WHATSAPP_WORKER_ENABLED=true npm run whatsapp:worker` | the opt-in worker (see `WHATSAPP_INTEGRATION.md`)                             |

Run any of them without arguments to see its usage.

## 1. Onboarding a WhatsApp account

Prerequisites you must establish yourself, outside this system: the organization exists; you know the WhatsApp Business Account (WABA) id and the `phone_number_id` from Meta's dashboard; **the WABA belongs to the same Meta Business Portfolio as the organization's other WABAs** (one organization = one Meta Business Portfolio, because BSUIDs are scoped to a portfolio and the schema keys them by organization). This cannot be verified without an authenticated Graph call, so you confirm it explicitly.

```
npm run whatsapp:accounts -- register --organization <slug-or-id> --waba-id <waba> --phone-number-id <id> \
    --display-phone-number "+94 77 000 0000" [--verified-name "..."] [--credential-ref WHATSAPP_TOKEN_NAME] \
    --confirm-single-portfolio            # dry run: validates and previews
... --apply                               # creates the account as PENDING
```

What registration enforces (and never overrides):

- `organization_id`, `phone_number_id` and `waba_id` are **written once**. No command changes them; there is no move, merge or re-home. The only columns later commands update are `status`, `archived_at` and `updated_at` (a static test pins this).
- A `phone_number_id` can belong to one account in the whole system. A second registration is refused whether it names the same or another organization.
- A WABA can belong to one organization. Registering a WABA that another organization already owns is refused; the same organization may register several numbers on one WABA. (The database has no constraint for this, so it is checked under an advisory lock; a direct SQL insert bypasses it and is re-detected at activation.)
- Ids are 6 to 30 digits. `--credential-ref` is a **name** such as `WHATSAPP_TOKEN_ALPHA` (UPPER_SNAKE_CASE, at most 64 characters), never a token; a value that looks like a Meta token is rejected, and no command reads or prints the secret it points to. Tokens are not needed until outbound messaging exists.
- The account starts `PENDING`. Events for a `PENDING` account are stored and held (`account_pending`), not processed.
- Registering does **not** release anything. If events for this `phone_number_id` arrived earlier (held as `unknown_account`) the output reports how many are `unroutedEventsAwaitingReview`; they stay held (section 3).

### Activate

```
npm run whatsapp:accounts -- activate <account-id>            # dry run: shows how many events would be released
npm run whatsapp:accounts -- activate <account-id> --apply
```

Activation re-checks that the organization is not archived and that no other organization owns the WABA, sets `ACTIVE`, and, in the same transaction, releases **only** `account_pending` events that are already routed to **exactly this account** and were received within the last **30 days**. Older ones stay held and are counted (`staleHeldLeft`), never discarded. It releases nothing else: not `unknown_account`, not `waba_mismatch`, not `account_disabled` or `account_archived` history, and nothing belonging to another account or organization. Routing columns are never rewritten.

### Disable, re-enable, archive

- `disable`: `PENDING` or `ACTIVE` to `DISABLED`. What it does and does not do, precisely (each point is covered by a test):
  - **New deliveries** for the number are stored and ignored (`account_disabled`), not processed. Ingress takes a share lock on the account row until the event is inserted, so the classification cannot be stale.
  - **New claims**: a worker that claims an event for a disabled (or archived) account ignores it (`account_disabled` / `account_archived`) without running a handler.
  - **A worker that has claimed an event but not yet reached its handler's own account check** sees `DISABLED`, rolls back and the event is ignored on its retry.
  - **A handler that is already authorized and inside its transaction** (it has passed the account check) is **not cancelled**. Disabling only prevents _newly authorized_ processing; this handler may complete and commit, so a message or status for the just-disabled account can still be written. It lasts at most 60 seconds per event and one event per worker lane.
  - **The command may wait.** `disable`, `archive`, `activate` and `enable` lock the account row `FOR UPDATE`. A handler transaction that has already inserted rows for the account holds a conflicting lock on that row (through the foreign keys of the rows it wrote), so the command waits until that transaction ends, then proceeds. A handler that has passed the account check but has not written anything yet holds no such lock, so the command does not wait for it and that handler may still commit afterwards. In neither case does any command forcibly cancel a transaction. (Tested: a disable waits for a handler that already wrote, which then commits.)
  - **Emergency stop.** Disabling alone is a stop for new work, not an instant cut-off of work in flight. To be sure nothing more is written for an account: disable it, then stop the worker (`SIGTERM`: it finishes the event in flight and exits), and start it again only when that is wanted. If the command seems to hang, a long-running handler transaction is the likely cause; check `whatsapp:status` and the worker's logs. Cancelling in-flight handlers when an account changes would be a redesign and has not been approved.
- `enable`: `DISABLED` to `ACTIVE`. **Releases nothing**: events ignored while it was disabled are released only by an explicit command (section 3).
- `archive`: sets `archived_at` and `DISABLED`. Irreversible with these tools, and archived accounts' held events are never released. Use it for numbers that will not be used again.

`list` shows every account with its organization; `inspect <id>` shows the account, its events by state and reason, its message count, other numbers on the same WABA and the unrouted events awaiting review. Neither shows a secret or a payload.

## 2. Is the pipeline healthy? (stuck or failing pipeline)

```
npm run whatsapp:status            # JSON report with findings
npm run whatsapp:status -- --check # exit 1 when a finding needs attention (for cron or a supervisor)
```

The report reuses the queue statistics and adds counts. Each finding says what it means and what to do next.

| Finding                                       | Meaning                                                                                          | Look at                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `expired_leases`                              | events are `PROCESSING` with an expired 120 s lease: a worker died or stalled                    | start/restart the worker; the next claim reclaims them. If they recur, read the worker's `worker.*` log lines                      |
| `queue_not_draining`                          | the oldest due MESSAGE/STATUS event has waited over 120 s and nothing was processed in 5 minutes | is the worker running (`WHATSAPP_WORKER_ENABLED=true`)? `worker.fatal`, `worker.database_unavailable` lines; database connectivity |
| `dead_events`                                 | events failed permanently or used all 8 attempts                                                 | section 4                                                                                                                          |
| `failed_events_waiting`                       | transient failures waiting for their scheduled retry (30 s to 32 min)                            | normal after a short outage; if growing, find the failure code in the worker logs                                                  |
| `held_events` / `unrouted_events_need_review` | `UNROUTABLE` / `IGNORED` events; unrouted ones mean traffic for a number nobody registered       | section 3                                                                                                                          |
| `no_active_account`                           | work exists but no account is `ACTIVE`                                                           | `whatsapp:accounts list`                                                                                                           |
| `unclaimable_events_waiting`                  | `IDENTITY` / `OTHER` events: no handler exists, the worker never claims them                     | expected until identity handling exists                                                                                            |

How to read it:

- **Worker status.** There is no heartbeat (that would need a schema change). A running worker is inferred from due events being completed (`workerActivity.processedLast5Minutes`) and from the `worker.stats` queue-depth line it logs at start and every minute.
- **Pending media attachments are not failures.** `attachments.pendingMediaFetch` counts provider media that exists but has not been fetched; no downloader exists yet, so these rows are informational and never a queue problem. (Media ids expire after about 7 days: blocker 12.)
- **Investigating.** (1) `whatsapp:status`. (2) The worker's JSON log: `worker.started/stopping/stopped`, `worker.database_unavailable` with a short code, `worker.fatal`, and the per-event `webhook.event_*` lines (`reason` is a fixed code, never content). (3) `whatsapp:events dead summary` / `counts`. (4) Database: `select status, count(*) from webhook_events group by 1`.
- **Worker restart.** SIGTERM or Ctrl-C: it stops claiming, finishes the event in flight and exits 0. After a crash the leases expire (120 s) and any worker reclaims the events; idempotency prevents duplicate rows. Exit 2 means refused (disabled, bad configuration, unmigrated database); exit 1 means a fatal runtime condition (5 minutes without database access, shutdown deadline, uncaught exception).
- **Safe database maintenance.** Stop the worker (SIGTERM) before a migration or restart. Webhook ingress keeps storing events while the worker is down; they wait in the queue. Do not run `UPDATE`/`DELETE` on `webhook_events` by hand: the operator commands exist so that routing and ownership are never edited.

### Webhook data retention (requirements; no job exists)

`whatsapp:status` reports, under `retention`, how many raw requests (and bytes) and events are older than 30 days. **No retention or deletion job exists**, and none may be added until a policy is decided. Whatever is added must: keep events that are `PENDING`, `FAILED`, `PROCESSING`, `UNROUTABLE`, `IGNORED` (releasable ones) or `DEAD` awaiting review; handle the `NO ACTION` provenance foreign keys from messages and status history to events (deleting an event that a message references is refused by design); and treat `webhook_requests.raw_body` (exact bytes, personal data) as the first candidate for expiry. Raw bodies and payloads are never logged or returned by these tools.

## 3. Held events

States: `UNROUTABLE` (a hold: pending account, unknown account, WABA mismatch) and `IGNORED` (disabled/archived account, or nothing to process).

```
npm run whatsapp:events -- counts                                  # by status, reason, account; shows how each can be released
npm run whatsapp:events -- list [--status ...] [--reason ...] [--account ...] [--limit n]   # ids and state, never payloads
```

Every count and listing carries a `releasePath`:

| Reason                                                                                            | Routed? | How it can be released                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `account_pending`                                                                                 | yes     | automatically when that account is activated (30 days), or `requeue-routed`                                                      |
| `account_disabled`, `account_archived`                                                            | yes     | only `requeue-routed`, explicit, and only while the account is `ACTIVE` and not archived (so archived history is never released) |
| `unknown_account`, `waba_mismatch`                                                                | no      | only `requeue-unrouted`, one event at a time, with approval                                                                      |
| `status_not_mirrored`, `unsupported_field`, `group_unsupported`, `system_message_pending_h1`, ... | n/a     | nothing to process; not releasable                                                                                               |

```
# routed events: preview, then apply with the count the preview reported
npm run whatsapp:events -- requeue-routed --account <id> --reason account_disabled [--max-age-days 30]
npm run whatsapp:events -- requeue-routed --account <id> --reason account_disabled --apply --expect <n>

# an unrouted event: you decide it belongs to a registered, ACTIVE account
npm run whatsapp:events -- requeue-unrouted --event <id> --account <id>                       # preview + review data
npm run whatsapp:events -- requeue-unrouted --event <id> --account <id> --apply --approve-ownership [--reviewed-waba-mismatch]
```

Rules enforced by the approved requeue functions (`queue/requeue.ts`), unchanged:

- A routed event is released only against the account it is already routed to, and only if its stored organization, `phone_number_id` and WABA agree with that account. It is **never moved to another organization or account**.
- `requeue-routed` applies only with `--expect <n>` equal to the preview; if the selection changed it is refused and nothing changes. `--max-age-days` defaults to 30 (1 to 365).
- `requeue-unrouted` gives one event the target account's organization and account, after independently verifying that the target exists, is `ACTIVE` and not archived, that its `phone_number_id` is the event's, and that the WABAs agree. A `waba_mismatch` event also needs `--reviewed-waba-mismatch`; because WABA and number are immutable, such an event is refused for as long as the WABAs differ. An event that already has an owner can never be moved again.
- The preview prints both sides (the event's reason, phone number id and WABA; the target's organization slug, phone number id and WABA) so the decision is informed.
- Contacts are never merged and identities are never resolved by these commands.

## 4. DEAD events

```
npm run whatsapp:events -- dead summary
npm run whatsapp:events -- dead list [--reason <code>] [--limit n]
npm run whatsapp:events -- dead inspect <event-id> [--reveal-payload]
```

Read-only. By default nothing a customer wrote is shown: reason code, category, attempts, routing ids, a hashed provider id, the Meta field, the message type or status word, and payload size. `--reveal-payload` prints the stored payload, labelled as personal data, and logs `operator.payload_revealed` with the event id only. Do not paste it into tickets or chats.

**Payload reveal is UNAPPROVED FOR REAL CUSTOMER DATA.** `--reveal-payload` prints a stored payload (message text, phone numbers, names, BSUIDs). It is **refused** unless the environment variable `WHATSAPP_ALLOW_PII_REVEAL` is exactly the string `true` (unset, `false`, `TRUE`, `1`, `yes` and everything else mean disabled). The refusal is enforced inside `inspectDead`, before the database is read, prints `{"ok": false, "refused": "pii_reveal_disabled"}` with no payload, logs `operator.payload_reveal_refused` on stderr and never logs the variable's value. Without `--reveal-payload`, inspection works as before whatever the variable is.

**That variable is defense in depth, not authorization.** It makes a reveal a deliberate act, nothing more. It does not identify the person (the process runs as whatever OS user started it; a command-line "name" argument would be unverified and is deliberately not accepted), it is not an access control (anyone who can run the tool can set it), and the `operator.payload_revealed` log line goes to stderr and is only as durable as wherever that stream is sent. **A console log is not an accountable audit trail**, and this tool must not be described as one. Do not set the variable in a shared or production environment, and do not use `--reveal-payload` on real customer data until the controls below exist; use it only with synthetic or consented test data. Without `--reveal-payload` the command never shows content.

What would have to exist before real-data use is approved (infrastructure and process, not code in this repository):

1. **Restricted execution**: the operator tools run only from a hardened host (bastion or jump host) reachable by a named, short list of staff, with no shared accounts and no copy of production `DATABASE_URL` on laptops.
2. **Attribution to a verified person**: every session is tied to an individual identity by the platform (SSO/IAM, personal SSH certificates, `sudo` with per-user logging, or a PAM-recorded session), so the log can name the human.
3. **Retained, tamper-resistant audit collection**: stderr and the host's session records are shipped to append-only storage with a retention period set by the privacy policy, and reviewed.
4. **Access to personal data granted deliberately**: a database role for the tools that is separate from the application's, granted only to authorized staff, with the privacy officer's approval of who may read customer content and why.
5. **An authorization process**: a recorded reason or ticket per reveal, and a rule that revealed content is not copied into tickets, chats or logs.

The remaining option is a **real** fix: a durable audit table plus a verified operator identity, which needs a migration and an operator-authentication design (neither is started). The environment switch above is the only code-level restriction implemented.

| Category                   | Typical codes                                                                                           | What it means                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `invalid_provider_payload` | `invalid_timestamp`, `invalid_event_payload`, `invalid_status`, `invalid_message`, `unsupported_status` | the payload failed validation; replay cannot help unless our parser was wrong  |
| `retries_exhausted`        | `max_attempts_exhausted`, `exhausted_*`                                                                 | 8 transient failures; fix the cause first                                      |
| `ambiguous_identity`       | `phone_only_identity_ambiguous`, `missing_sender_identity`, `invalid_sender_identity`                   | the sender cannot be tied to one contact without guessing; nothing was written |
| `routing_inconsistent`     | `missing_routing`, `account_missing`                                                                    | the event's account no longer exists                                           |
| `permanent_failure`        | anything else                                                                                           | a handler reported a permanent failure                                         |

**There is no replay.** DEAD events are never re-queued automatically and no command re-queues them. This is a deliberate, **unresolved policy decision**: replaying `retries_exhausted` events after the cause is fixed would be safe because every handler is idempotent, but `ambiguous_identity` events must not be replayed until the identity has been resolved by a person (and the contact-merge tooling of blocker 14 exists), and `invalid_provider_payload` events only after a parser change that is tested against the stored bytes. Until the policy is written, keep DEAD events (they are exempt from any future retention job) and decide per category.

## 5. Unresolved Meta documentation questions (do not work around them)

Recorded in `WHATSAPP_G0_EVIDENCE.md` and resolved only by a real, approval-controlled Meta test, never by guessing: how identity changes (a phone-number change regenerates the BSUID) are delivered and whether a structured previous BSUID exists (H1; the `system.body` text is never parsed); whether an old BSUID stays valid (H2); whether one delivery can carry several senders (H3); whether Meta sends literal UTF-8 or escaped text on the wire; whether a reaction resets the 24-hour window; the exact `sent` and `read` status JSON; the WABA/entry-id relationship on a live delivery; which secret signs overridden-callback deliveries.

## 6. Applying migration 0003 (one attribution per message)

Migration `0003_lead_attribution_message_unique` adds the partial unique index `lead_attributions_org_message_uidx` on `(organization_id, message_id) WHERE message_id IS NOT NULL`: PostgreSQL then refuses a second attribution row for the same referring message (rows with no message are unconstrained). The application already wrote at most one row per message; this makes it a database guarantee. This project's tools never apply migrations to your development or any persistent database for you: you run `npm run db:migrate` yourself, deliberately, against the database you choose.

1. **Preflight (read-only), before deploying.** Any row returned is a duplicate that the migration will refuse to pass:
   ```sql
   SELECT organization_id, message_id, count(*) AS rows, array_agg(id ORDER BY created_at) AS attribution_ids
   FROM lead_attributions
   WHERE message_id IS NOT NULL
   GROUP BY organization_id, message_id
   HAVING count(*) > 1;
   ```
2. **Duplicates are never resolved automatically.** The migration begins with a check that raises `migration 0003 refused: N (organization_id, message_id) pair(s) ... no rows were changed` (SQLSTATE 23505) and the whole migration rolls back: no row is deleted or merged, the index is not created and the migration is not recorded. Review the rows by hand (the earliest touch is the first-touch attribution), decide which to keep, delete the others yourself, then retry.
3. **Locking.** `CREATE UNIQUE INDEX` inside the migrator (a transaction) cannot be `CONCURRENTLY`, so it takes a SHARE lock on `lead_attributions` while it builds: inserts, updates and deletes on that table wait, reads continue. The table only grows with Click-to-WhatsApp referrals and is normally small, but do not assume it is instant: look at `select count(*) from lead_attributions` first, apply in a quiet period, and stop the webhook worker beforehand (webhook ingress keeps storing events; they wait in the queue). A `CONCURRENTLY` build would have to be run by hand outside the migrator and is not part of this migration.
4. **Order.** Apply `0002` before the webhook route (existing rule), then `0003`. A new database (tests, CI) gets every migration automatically.
