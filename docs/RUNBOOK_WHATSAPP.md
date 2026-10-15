# WhatsApp operations runbook

Audience: the operator of this platform. Everything here is a local command-line tool that talks only to the platform's own PostgreSQL database (`DATABASE_URL`). **Nothing here calls Meta, sends a message, connects a real WhatsApp account or configures a webhook subscription**, and nothing starts the worker for you. The platform is **not production-ready** (see `PRE_PRODUCTION_BLOCKERS.md`).

All commands print **exactly one JSON document on stdout** (the result). Audit and diagnostic log lines, such as `operator.account_activated`, go to **stderr**, so `npm run whatsapp:status | jq` and scripts that parse stdout are safe; capture stderr separately if you want the log. Tests run the real scripts and parse stdout as one document. **Every command that changes state is a dry run unless you add `--apply`**: it runs the real code in a transaction and rolls it back, so the preview is exactly what `--apply` would do. Exit codes: `0` success, `1` refused (nothing changed), `2` usage error.

| Command                                                 | Purpose                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run whatsapp:accounts -- <command>`                | register, inspect, list, activate, enable, disable, archive WhatsApp accounts |
| `npm run whatsapp:events -- <command>`                  | inspect and release held events, review DEAD events                           |
| `npm run whatsapp:status [-- --check]`                  | pipeline health and the findings that need attention                          |
| `WHATSAPP_WORKER_ENABLED=true npm run whatsapp:worker`  | the opt-in worker (see `WHATSAPP_INTEGRATION.md`)                             |
| `LEADS_RECONCILER_ENABLED=true npm run leads:reconcile` | one bounded pass of the lead reconciler (section 9)                           |

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

### Applying migration 0006 (leads lifecycle and attribution evidence)

Migration `0006_leads_lifecycle_and_attribution_integrity` adds the rule "a contact has at most one open lead", lead history, reconcile decisions and the protection of attribution evidence (ADR 0016). It is additive. It has been applied to disposable test databases only: not to the local development database (which has 0000-0005) and not to any production database.

1. **Preflight (read-only), before deploying.** Any row returned is a contact with more than one open lead, which the migration will refuse to pass:
   ```sql
   SELECT organization_id, contact_id, count(*) AS open_leads, array_agg(id ORDER BY created_at) AS lead_ids
   FROM leads
   WHERE status IN ('NEW', 'QUALIFIED', 'INTERESTED', 'REGISTRATION_STARTED', 'REGISTERED', 'PAID')
   GROUP BY organization_id, contact_id
   HAVING count(*) > 1;
   ```
2. **Nothing is resolved automatically.** The migration begins with a check that raises `migration 0006 refused: N contact(s) have more than one open lead; no rows were changed` (SQLSTATE 23505) and the whole migration rolls back: no lead is closed, merged or deleted, no column, table, index or trigger is created, and the migration is not recorded. Decide by hand which lead stays open, close the others (before the migration a plain `UPDATE leads SET status = ..., status_changed_at = now()` is enough), and retry.
3. **What it does to existing rows.** Only the new columns of `leads` are filled (`revision` 0; `closed_at` = `status_changed_at` for a lead in a closed status; `cycle_started_at` = the earlier of `created_at` and `status_changed_at`; `initiating_attribution_id` stays NULL). No touch is linked, unlinked or rewritten, and no history is invented. A touch that was already linked stays linked and becomes immutable like every other touch.
4. **After it.** Attribution touches can no longer be updated or deleted by hand (only linked once, with their history event), lead history cannot be edited, a lead's status cannot be changed without its history event, a lead cannot be inserted at a revision other than 0, and a reconcile decision cannot be deleted by hand (a terminal one never, a `RETRY` one only by the transaction that links its touch): any manual correction of these tables from now on is a reviewed migration, not an ad-hoc statement.
5. **Locking.** Short ACCESS EXCLUSIVE locks on `leads` and `lead_attributions` and index builds inside the migration transaction. Both tables are small; apply it in a quiet period with the webhook worker stopped (events wait in the queue).

## 7. Outbound messaging (Phase 05)

Nothing sends until you deliberately enable it. All commands below are read-only unless noted.

**Enable (only after review; needs approval).** Set on the worker host only: `WHATSAPP_OUTBOUND_ENABLED=true`, `WHATSAPP_LIVE_SEND_ENABLED=true`, `WHATSAPP_GRAPH_API_VERSION=vNN.N`, `DATABASE_URL`, and the token variable named by the account's `credential_ref`. Leave `WHATSAPP_BSUID_RECIPIENT_ENABLED` off until a live test with a test number proves the `recipient` request shape. Start `npm run whatsapp:outbound-worker` under a supervisor (run the script directly; `npm` may not forward SIGTERM). The API (web) host needs only `WHATSAPP_OUTBOUND_ENABLED=true` to accept requests.

**Health and inspection.** `npm run whatsapp:outbound -- health --check` (non-zero exit when something needs attention: UNKNOWN_OUTCOME requests, stuck SENDING, a queue that is not draining; HELD and REJECTED requests are reported as information; the output names each finding and the next step), `counts`, `list --state HELD|UNKNOWN_OUTCOME|...`, `inspect <request-id>` (ids, state, codes, timestamps; no text or recipient).

**HELD requests.** The reason code says why (`window_closed`, `no_identity`, `bsuid_send_unavailable`, `deadline_passed`, ...). A HELD request is never retried; staff send a new request deliberately, if it is still wanted and eligible. **An expired free-form window does not become sendable by switching to an approved template.** Under the current project rule a template to a phone-only contact is also sent only while a recent qualifying inbound message keeps the 24-hour window open (including the 10-minute safety margin); BSUID sending is disabled; so proactive sending outside the window is blocked and `window_closed` stays `window_closed` whichever message type is tried. This is our conservative rule, not a statement that Meta cannot send an approved template outside the 24-hour window (Meta can). Making such sends available needs a future approved decision on recipient identity, consent and proactive templates: blocker 44. Until then the customer has to write first.

**UNKNOWN_OUTCOME (the important one).** The request may or may not have been delivered. Do **not** create a duplicate and do **not** guess a provider message id. Two different situations must not be confused:

- **Case A: the id arrived, only the order differed.** Meta answered the send with the message id `W`, and a STATUS webhook (or a customer reply) for `W` was processed before that answer was stored. Nothing is lost: when the acceptance is stored the application links the earlier statuses and back-resolves earlier replies automatically. No operator action.
- **Throttled by Meta (HTTP 429 with a rate-limit code).** Also UNKNOWN_OUTCOME (`failure_code` `rate_limited_semantics_unverified`, the code in `provider_error_code`): Meta's documentation does not say that nothing was created when it answers this way, so the application does not retry. Treat it exactly like Case B below.
- **Case B: the id was lost.** Meta may have accepted the message, but the response containing `W` never reached the application (timeout, connection reset, crash, malformed or unusable answer, a result that could not be written). The application does **not** know `W`. A later STATUS webhook for `W` carries no link to the request, so nothing can tell which UNKNOWN_OUTCOME request owns it: it stays an unlinked status event (`message_id` NULL) and the request stays UNKNOWN_OUTCOME. **There is no automatic recovery for Case B.**

Steps for a request in UNKNOWN_OUTCOME: (1) `inspect <id>` for the time and `failure_code`; (2) look in the WhatsApp Business Manager message log / conversation for that customer around `send_started_at` and decide from **independently verified provider evidence** whether the message was delivered; (3) never pick a wamid from unlinked status events by timing or similarity; (4) only if you have confirmed it was not delivered, staff send a new request with a **new** idempotency key. **Replacing is a risk the application cannot remove:** if the first message was in fact delivered (or is delivered late), the customer receives both. **Before you consider a replacement for any UNKNOWN_OUTCOME request, do all of this, in order:** (a) stop or terminate the original outbound worker process; (b) verify that it cannot resume (a frozen, paused or detached process, a container that can be unfrozen, or a second supervisor that could restart it can all still send after a replacement has gone out: a request that was in flight when the process stopped can still be delivered); (c) investigate the available provider evidence (WhatsApp Business Manager message log, the customer's conversation); (d) review whether a message may already have been delivered; (e) obtain an explicit operator decision. Even all of this does not provide mathematical exactly-once delivery. Never replace in bulk, and there is no resend command. There is intentionally no resend command and no command that attaches a provider id to a request; recording who resolved it needs an audit design (blocker 36).

**Templates.** `templates register ...` creates a `PENDING_ATTESTATION` row (dry run unless `--apply`). After you have confirmed in the Meta dashboard that this exact name and language is APPROVED for that WhatsApp account, `templates approve <id> --attest-approved-in-meta --apply`. `templates disable <id> --apply` stops use. The platform cannot verify approval. Approving a template does not by itself make a message eligible: a phone-only contact still needs an open 24-hour window (blocker 44).

**Emergency stop.** Unset `WHATSAPP_LIVE_SEND_ENABLED` (or `WHATSAPP_OUTBOUND_ENABLED`) and restart the worker; the transport also re-reads both gates before every request, so a changed environment stops the next send, but a request already on the wire cannot be recalled.

**Applying migration 0004.** Additive; creates two tables, a trigger function and a trigger; no existing table is altered and no data is touched. Apply with `npm run db:migrate` to a database that already has 0000-0003. It has been applied to the local development database by the developer, and never to a production database (none exists yet; see `DATABASE_DESIGN.md`, "Where the migrations have been applied").

**Retention and personal data (outbound).** Outbound content exists in more than one place, and each copy is personal data that has to be covered by the same retention, deletion, access-control and personal-data decisions:

- `messages` (the OUTBOUND row): `body` (the full text of a free-form message) or, for a template, `content` (template name, language, category and the **parameter values**), plus the recipient conversation, reply link and, once accepted, the provider id and delivery status.
- `outbound_requests.payload`: a second copy of the **message text** (`body`, and the reply target's provider id) or of the **template parameter values**. Parameters are free text supplied by staff and may contain names, amounts, dates or other personal data. The same row holds the exact recipient identifier (`recipient_id`, a phone number or BSUID), the requesting staff member, the idempotency key and request fingerprint, and the dispatch history (states, attempt count, provider error code and HTTP status, hold/failure reasons).
- `message_status_events` and `webhook_events` / `webhook_requests` (delivery statuses and inbound replies, as for Phase 04).

Deleting or anonymising a message therefore means handling **both** `messages` and `outbound_requests.payload` (the fingerprint is a one-way hash but is derived from the content). No deletion job exists and none may be added before a policy is approved; whatever is added must keep `SENDING` and `UNKNOWN_OUTCOME` requests until they are resolved. `whatsapp:outbound` prints none of this content.

## 8. The staff inbox (Phase 06)

Staff use `/inbox` after signing in. What an operator needs to know:

- **Nothing in the inbox sends by itself.** A reply is queued through the Phase 05 endpoint; it is sent only by the separate outbound worker, and only when both gates are on (section 7). With `WHATSAPP_OUTBOUND_ENABLED` off the composer says sending is switched off and is disabled.
- **What staff see for a reply:** Queued (not sent yet), Sending, Accepted by WhatsApp (not yet delivered), Sent / Delivered / Read / Failed (from WhatsApp's own status reports), Rejected, Not sent (with the reason) or **Outcome unknown**. For an unknown outcome the screen warns that the message may have been sent and offers no resend; follow section 7 (verify in WhatsApp Business Manager, stop the original worker, and only then decide).
- **Closed 24-hour window:** the composer explains it and will not queue a reply; switching to a template does not help under the current rule (blocker 44). The customer has to write first.
- **Assignment and suspended staff:** suspending a staff member does not unassign their conversations. The inbox shows the assignee as inactive; a colleague can reassign or unassign. Use the "Assigned to me" and "Unassigned" filters to find them.
- **Unread** is per staff member and internal; it is not a WhatsApp read receipt and nothing is sent to the customer when someone opens a conversation.
- **Notes** are internal, append-only (they cannot be edited or deleted from the application) and contain personal data: treat them like the messages for retention and access decisions (blocker 45).
- **Refresh interval:** the screen polls (15 s list, 5 s open conversation by default; `INBOX_POLL_LIST_MS` / `INBOX_POLL_CHAT_MS`). A message can appear a few seconds late. If staff report the inbox is slow, raise the intervals before anything else.
- **Applying migration 0005** (additive: two columns on `conversations`, four tables, a trigger function and two triggers, a few indexes) is a normal `npm run db:migrate` to a database that has 0000-0004. It was validated on disposable test databases and has been applied to the local development database by the developer; it has never been applied to a production database (none exists yet).

## 9. The lead reconciler (Phase 07C)

`npm run leads:reconcile` reads confirmed Meta ad referral evidence that the webhook worker already stored (touches of **inbound** messages only) and either links it to the contact's open lead or creates a lead from it (ADR 0016). It is **opt-in in every way**: it does nothing unless `LEADS_RECONCILER_ENABLED=true` is set; nothing starts it (not the web server, the build, migrations, tests or the webhook worker; it is not exported from the leads module); and **there is no scheduler, supervision or alerting**: each invocation is one bounded pass and the automatic leads are only as current as the last one. This is not production-ready reconciliation (blocker 67). It never calls Meta, sends nothing, never changes the schema and writes only leads, lead history, the link of a touch and its reconcile decision. It checks that the database is migrated to 0006 before reading anything (`schema_not_ready`, exit 1).

- **Configuration** (environment; problems name the key, never a value): `LEADS_RECONCILER_ENABLED`, `DATABASE_URL`, `LEADS_RECONCILE_FRESHNESS_DAYS` (1-90, default 14), `LEADS_RECONCILE_BATCH_SIZE` (touches processed per run, 1-1000, default 100), `LEADS_RECONCILE_MAX_SECONDS` (run budget, 1-600, default 30), `LEADS_RECONCILE_SCAN_LIMIT` (candidates examined per run, 1-100000, default 5000), `LEADS_RECONCILE_STATEMENT_TIMEOUT_SECONDS` (1-120, default 20), `LEADS_RECONCILE_LOCK_TIMEOUT_SECONDS` (1-60, default 3).
- **Time and query limits.** The **run budget** (`LEADS_RECONCILE_MAX_SECONDS`) and the **batch size** are **admission control, not a deadline**: they are checked before every candidate scan, every new page and every candidate, and a run that has used one up starts none of them (`time_limit` / `batch_limit`). Statements already admitted have their own limits. Every statement the command issues (readiness check, candidate scan, the count of remaining work, handling a touch, recording a failure) is bounded by PostgreSQL itself: a **lock timeout** (a statement waiting for a table lock, such as a running migration's, is cancelled after it) and a **statement timeout** (any statement, lock waits included). Both are set per transaction and never stay on a pooled connection. A statement that is already running when the budget expires finishes or fails within those limits, and the final count of remaining work is always attempted afterwards under the same timeouts; so one run can last **longer than its budget** (by a scan or count waiting up to the lock timeout, a statement up to the statement timeout, and the final count), and the budget is not a process deadline. (A) Candidate processing waits for no lock: row locks are `NOWAIT` and the contact's lock is only tried (a contact in use is passed over at once). (B) Only the recording of a failure may wait for a lock, and then only up to the lock timeout. (C) The final count of remaining work also runs under both timeouts and reads as unknown if it fails. There is no guaranteed processing latency and no guaranteed maximum elapsed retry delay. While a migration holds a lock on a lead table the command ends within the lock timeout: `database_timeout` (exit 1) from the readiness check, or a report with `stopReason: "query_failed"` (exit 1) from the scan; nothing is printed but fixed words and codes.
- **Exit codes:** 0 a pass completed (also when there was nothing to do or work remains); 1 the pass could not run or its scan failed (`database_unreachable`, `database_timeout`, `schema_not_ready`, `run_failed`, `uncaught_exception`, or a report with `outcome: "failure"`); 2 refused (disabled or invalid configuration; nothing was read).
- **Output:** one JSON line of counts (stdout), never an identifier, a name or text of any kind: `fetched`, `scanned`, `processed`, `linked`, `created`, `skipped` (`stale`, `beforeCycle`, `converted`, `archived`), `retryScheduled`, `parked`, `busy`, `waiting`, `conflicts`, `gone`, `failuresUnrecorded`, `failuresUncertain`, `errors` (a count per fixed code such as `pg_23514`, `pg_55p03`, `pg_57014`), `stopReason` (`exhausted`, `batch_limit`, `time_limit`, `scan_limit`, `query_failed`), `remaining` (`known`, `due`, `dueCapped`, `retryWaiting`, `parked`) and `durationMs`. **A run does not promise to finish everything**: while `remaining.due` is above zero, or `stopReason` is not `exhausted`, run it again. `remaining.known: false` means the count itself timed out.
- **What the counts mean, each candidate counted once.** `busy`: the contact or a row of it was in use (lock contention): passed over, nothing spent. `waiting`: the first-touch policy (below) held it back: NOT lock contention. `skipped.*`: touches that will never be linked automatically (they stay as contact-level evidence). `parked`: a touch failed its fifth attempt in this run. `scanned = processed + busy + waiting + conflicts + gone`. **Three different numbers:** `fetched` is candidates RETURNED by the scan queries (some stay unexamined when the run stops mid-page), `scanned` is candidates examined (this is what the scan limit bounds; the index entries PostgreSQL looks at to find them are not counted and not reported), `processed` is touches that received a decision, a link, a lead or a recorded failure. A contact whose lock is held when the scan runs, a touch held back by the policy, and a touch of an organization that is busy then are not returned at all (so they appear only in `remaining.due`). `failuresUnrecorded`: a failure whose recording timed out on a lock (the touch is tried again). `failuresUncertain`: a failure whose recording was deliberately NOT repeated because it cannot be told whether it already happened (see below): nothing was written twice. An **organization** whose row staff management holds (a suspension or role change in progress) is skipped by the scan query itself (`FOR KEY SHARE ... SKIP LOCKED` on the organization row, inside the scan's own short transaction), however many organizations are held and without any state between runs: its touches are simply not returned and cost no scan budget, and the next run picks the organization up once the staff change has committed. **Because SKIP LOCKED does not report how many rows it skipped, the report has no count of unavailable organizations** (the former fields `organizationsUnavailable` and `deferredByOrganization`, and the probe limit, were removed): a run that returns nothing while `remaining.due` is above zero is the signal that everything left is held or held back. An organization that turns busy between the scan and the attempt shows up as `busy` (one attempt per candidate, nothing waited for). `remaining.retryWaiting` and `remaining.parked` count only confirmed Meta ad touches of inbound messages.
- **Failures and retries.** A failed attempt rolls back everything it did (to a savepoint inside its own transaction, which keeps the contact locked) and the failure is recorded in that same transaction as a RETRY with its attempt count and a fixed error code: due after 1 minute, then 5 minutes, 30 minutes, 2 hours (nominal back-off, not a promise of when it will be tried: that is when a run happens); the fifth failure is `PARKED`. **One actual failure consumes at most one attempt, even when the acknowledgement of a COMMIT is lost** (the outcome is then unknown: the command re-reads the committed state and records only if it is unchanged; otherwise it writes nothing and counts `failuresUncertain`). A parked touch is **final** (the database refuses to change it): there is no unpark command (blocker 61). To count parked touches: `SELECT count(*) FROM lead_reconcile_decisions WHERE decision = 'PARKED'`.
- **Freshness (default 14 days; linking and creation alike).** A touch whose evidence (the earlier of its receipt time and its message's provider time) is older than the window when it is **first considered** is skipped for good (`SKIPPED_STALE`). The first-consideration time is read from the database clock while the attempt holds the contact, and kept with the RETRY row, so a retry that was fresh when first tried stays eligible and no other run can judge the touch between the failure and its recording. A **recoverable failure** keeps the anchor and the contact lock. If the connection or process is lost mid-attempt, the uncommitted anchor is lost with it and cannot always be preserved (the touch is then judged afresh): that is a different thing and is not recoverable without independently durable state. A **service outage longer than the window** (the command not being run for that long) therefore turns old evidence into skips rather than leads: choose the window before the first run on a backlog (a larger window is a deliberate decision about old inquiries). Skips are never resurrected.
- **First-touch policy (approved).** With an open lead, a touch is linked at once. To create a lead, an earlier touch of the contact that is in its retry back-off holds a later one for at most 15 minutes from the earlier touch's first consideration; after that a later touch may start the lead on a later run, and the earlier one is judged by the normal cycle rule (typically skipped as before the cycle). Receipt order is not proof of the order of the ad clicks.
- **Archived contacts.** Touches of an archived contact are skipped for good (`SKIPPED_ARCHIVED`); un-archiving later does not bring them back, but touches received after that are considered normally.
- **Invalid legacy rows.** The reconciler ignores an attribution row whose message is not inbound (none is written by the application). To count any: `SELECT count(*) FROM lead_attributions a JOIN messages m ON m.organization_id = a.organization_id AND m.id = a.message_id WHERE a.source_type = 'META_AD' AND m.direction <> 'INBOUND'`. Neither the due count nor the waiting and parked counts include a decision row tied to one. They stay as untouched contact-level evidence; evidence is never rewritten. **Wrong-contact rows** (a touch whose message belongs to a conversation of ANOTHER contact of the organization; the schema allows it, the application never writes it) are ignored the same way: never a candidate, never linked, never a lead, no decision, no hold, not counted. To count any: `SELECT count(*) FROM lead_attributions a JOIN messages m ON m.organization_id = a.organization_id AND m.id = a.message_id JOIN conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id WHERE a.source_type = 'META_AD' AND c.contact_id <> a.contact_id`. A `RETRY` or `PARKED` row already stored for one is not shown in the report's counts (operator visibility is only this read-only query); nothing repairs or rewrites such evidence.
- **Two runs at the same time** are safe (a contact in use is passed over, never waited for, and every decision is re-checked under the locks), but they do not make a pass faster.
