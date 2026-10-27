# Phase 08F acceptance record (working draft)

**Status: NOT CLOSED.** 08F-3 is awaiting independent code review. Browser acceptance has not been executed. Final owner validation has not happened. Nothing here authorizes activation, a database other than the approved disposable test server, a Meta call, a worker start or live sending.

Authoritative sources: V3.2 section J.4 and I.5 (indicator), O.1 layer 6 (browser E2E for the Inbox indicator), the 08F paragraph of the phase table, [ADR 0021](adr/0021-bot-runtime.md) (phase boundaries), and the deferred items in [PRE_PRODUCTION_BLOCKERS.md](PRE_PRODUCTION_BLOCKERS.md).

## Checklist

| Item                                                                                                                                         | State                                     | Evidence                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| **08F-1** `bots:retention` (privacy redaction) and terminal-trigger retention                                                                | Done, committed                           | `6c0e5f9`                                                                         |
| **08F-2** Inbox indicator, Bot Attention filter, operator listings (sessions, DEAD triggers, deployments), redaction marker, notice warnings | Done, committed                           | `4aef8c3`                                                                         |
| **08F-3** BOT hold-reason wording (every code `bot_request_hold_code`, the claim and the final authorization can write)                      | Implemented, uncommitted, awaiting review | `inbox/display.ts` `HOLD_REASONS`; `unit.test.ts`; `inbox-interactive.db.test.ts` |
| **08F-3** Interactive labeling from stored direction (timeline placeholder, reply preview, list preview)                                     | Implemented, uncommitted, awaiting review | `describeMessage({ direction })`, `list.ts` `fallbackPreview`                     |
| **08F-3** Operator-listing cursor: calendar-invalid timestamps rejected before SQL, microseconds preserved                                   | Implemented, uncommitted, awaiting review | `bot-control/listings.ts`; `listings-cursor.test.ts`                              |
| **08F-3** QUEUED/SENDING notice wording ("has not been confirmed yet")                                                                       | Implemented, uncommitted, awaiting review | `inbox/bot-indicator.ts`; `bot-indicator.test.ts`                                 |
| **Browser acceptance** (V3.2 O.1 layer 6; ADR 0021 "browser-level interactive rendering")                                                    | **NOT EXECUTED**                          | Plan below; needs owner authorization                                             |
| Independent review and final owner validation of 08F                                                                                         | Pending                                   |                                                                                   |

## Display rules the architecture does not specify (behavior preserved, reported)

- V3.2 gives no wording for hold reasons or interactive labels. The wording added in 08F-3 is new product text and needs owner approval at review.
- Hold wording is by code only. Severity stays `warning` for every HELD request, as before. The code does not separate "internal bot processing" from "staff-visible" states by severity, only by wording.
- A BUTTON row stored as OUTBOUND is labelled "Unsupported message". The platform never sends a BUTTON message, so the row is not a real case.

## Browser acceptance plan (proposed, not run)

Infrastructure found (`playwright.config.ts`, `scripts/e2e.ts`, `e2e/support/*`, `scripts/e2e-seed.ts`):

- `npm run test:e2e` creates one disposable `al_ict_e2e_<random>` database through the shared guarded harness (admin URL from `TEST_DATABASE_ADMIN_URL` only, local host, PG 17 check), migrates, seeds, builds, serves over HTTPS with a throwaway certificate, runs Chromium, and drops the database in `finally`. It never reads `DATABASE_URL`. An `al_ict_e2e_*` database is therefore **required** for any browser run.
- Users and organizations are created by `scripts/e2e-seed.ts` (ORG_A..ORG_H; ADMIN, STAFF and VIEWER identities per area). Tests own distinct identities.
- Servers run with `WHATSAPP_LIVE_SEND_ENABLED=false`, no Graph version, no token, and no outbound or bot worker process. `WHATSAPP_OUTBOUND_ENABLED` is true only on the first server. Nothing can reach Meta.
- **Gap 1:** `e2e/support/server-env.ts` blanks `WHATSAPP_`, `META_`, `WA_`, `GRAPH_`, `DATABASE_` and `BOOTSTRAP_` names but not `BOTS_*`. `BOTS_RUNTIME_ENABLED` would be inherited from the shell or `.env.local`. It starts no worker, but the gate must be pinned to `"false"` explicitly before any bot fixture runs.
- **Gap 2:** no bot fixture exists in the seed (no bot, deployment, session or interactive message). `bot-control/boundaries.test.ts` allows only `scripts/bots-admin.ts` and `scripts/bots-retention.ts` to import `@/modules/bot-control`, so seeding sessions needs either a reviewed boundary amendment or direct SQL fixtures. Either is a change that needs owner approval.

Mandatory tests for 08F closure (all new, none passing yet):

1. **Authorized staff (STAFF, ADMIN):** a conversation row shows the bot indicator for each of: handling, finished, asked for a human, handed over by the system, stopped with an error; a `bot_error` handover is a warning without a "may not have received" claim.
2. **VIEWER restriction:** a VIEWER (no `bot.read`) sees no indicator, no "Bot attention" view, and the API responses contain no `bot` key. Another organization's staff sees none of this organization's sessions.
3. **Bot Attention:** the view lists exactly the unresolved HANDED_OVER/FAILED conversations, filters before paging, and resolving a conversation removes it.
4. **Session details:** the detail panel shows reason, notice outcome (including HELD/REJECTED/UNKNOWN_OUTCOME warnings and the QUEUED/SENDING wording), the redacted marker, and no variables, tokens or message text.
5. **Display corrections:** a bot interactive message reads "Interactive message" with its option titles; the customer's reply reads "Interactive reply"; a HELD bot message shows curated wording for `staff_took_over`, `bot_step_superseded` and one other bot code; no raw code or underscore appears.
6. **Safety assertions in every file:** before browsing, record the baseline outbound request IDs and states. Fixture rows already in `SENDING` (for example the notice fixture) are permitted and are not a new send. After browsing, assert: no outbound request exists beyond the baseline; no baseline request changed state, and none newly entered `SENDING` because of browsing; no messaging worker or transport attempt was triggered; gates unchanged.

Safety preflight before execution:

- `git status` clean apart from the reviewed change; HEAD recorded.
- `TEST_DATABASE_ADMIN_URL` built in memory from container `al-ict-phase08c-test-pg`, `server_version_num` in 170000-179999 (PostgreSQL 17.x exactly, not merely >= 17), host `127.0.0.1:55432`, database `postgres`; `DATABASE_URL` unset; the seven existing `al_ict_test_*` databases counted before and after.
- A fresh, independently verified disposable `al_ict_e2e_*` database: name, host, port and PG 17.x checked on the connection the servers will use, and no other `al_ict_e2e_*` database present before the run.
- All three gates pinned to `false` for the server and every child process: `BOTS_RUNTIME_ENABLED`, `WHATSAPP_OUTBOUND_ENABLED`, `WHATSAPP_LIVE_SEND_ENABLED`. Today `serverEnv` pins only the last explicitly; the first server sets outbound `true` for the composer, and `BOTS_RUNTIME_ENABLED` is not pinned at all. Both need an owner-approved E2E infrastructure change (or running the bot specs on the outbound-off server) before execution.
- Verified, not assumed, that no child process can inherit an enabled value from the shell or `.env.local`: print the effective values of the three gates from the spawned server's own environment, and confirm no `BOTS_*`, `WHATSAPP_*` or `META_*` name is set in the shell.
- No real Meta credentials, transport, workers or live sending: no token, no Graph version, no outbound or bot worker process running.
- Host sleep and clamshell state checked before and after (a sleeping host invalidates timing).
- The run drops its `al_ict_e2e_*` database; the drop is confirmed.

## Remaining operational restrictions

All automation gates stay OFF. Migrations 0007-0009 are not applied to any persistent database. `bots:worker` is not deployed. No alert exists on `bots.trigger_capture_failed`. The retention job is not scheduled. Production activation is not authorized (blockers 75-80).

## Phase 08G (not started)

The five remaining bot definitions and the six-bot closed loop (A-6BOT, mandatory before activation); combined stop, takeover, pause and suspension scenarios; security and privacy review; the reviewed activation plan; Meta interactive verification. Only `enquiryFlow` exists.
