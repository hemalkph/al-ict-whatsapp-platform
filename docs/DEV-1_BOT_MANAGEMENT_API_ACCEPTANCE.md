# DEV-1: Bot management API — implementation and acceptance note

Prepared 13 November 2026 (Asia/Colombo) by the main developer (Claude) under the owner's DEV-1 implementation authorization.
Baseline: branch `Bot-Foundation`, HEAD `9c55a520c3e4b86fb50abe6bbd66aa9e347e3525`, clean tree before the first edit.

Documentation reconciled 14 November 2026 (Asia/Colombo) against the supplied independent reviewer report. This cleanup does
not rerun database tests or personally inspect the raw execution logs.

Owner decision recorded 14 November 2026: DEV-1 **accepted with notes by Hemal Pramuditha**, acknowledging the evidence gaps
listed under "Remaining evidence gaps". The acceptance covers the DEV-1 development milestone only. Deployment, live messaging
and DEV-2 implementation remain separately unauthorized.

## Status

| State                                | Value                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Implemented                          | Yes (working tree only)                                                                                                    |
| Database-free checks (developer-run) | Passed: see "Evidence"                                                                                                     |
| **Database tests (developer-run)**   | Subsequent runs reported; the independent reviewer says they inspected the saved logs. See "Subsequent database evidence". |
| Independent review                   | **APPROVED FOR OWNER VALIDATION**; no new confirmed P1/P2 product defect found within the reviewed scope.                  |
| Owner acceptance                     | **Accepted with notes by Hemal Pramuditha, 14 November 2026** (DEV-1 development milestone only)                           |
| Committed / pushed                   | Pending; nothing staged, committed or pushed by this cleanup (owner-operated).                                             |
| Hosted CI                            | Pending                                                                                                                    |
| Provider / deployment validation     | Not applicable to this checkpoint; not done                                                                                |

Owner acceptance is recorded above, with the evidence gaps preserved. The initial stopped-container attempt and later developer-executed runs
are separate events. The independent verdict is scoped to the reviewed DEV-1 implementation and authorizes no commit,
deployment or live messaging. Execution evidence below is attributed to its source rather than presented as a new run.

## What was built

Five handlers in four route files over the existing `bot-control` services. Nothing publishes, activates, runs a bot or sends.

| Endpoint                                                     | Permission | Success                                                 | Specific refusals                                   |
| ------------------------------------------------------------ | ---------- | ------------------------------------------------------- | --------------------------------------------------- |
| `GET /api/bots?limit=&cursor=`                               | `bot.read` | 200 `{ items, nextCursor }`                             | 400                                                 |
| `POST /api/bots` `{ key, name, description? }`               | `bot.edit` | 201 bot summary                                         | 400, 409 `BOT_KEY_TAKEN`                            |
| `GET /api/bots/[botId]`                                      | `bot.read` | 200 summary + `draft` (parsed JSON or `null`)           | 400, 404                                            |
| `PUT /api/bots/[botId]/draft` `{ expectedRevision, config }` | `bot.edit` | 200 `{ botId, draftRevision, canonicalBytes, changed }` | 400, 404, 409 `STALE_REVISION`, 422 `DRAFT_INVALID` |
| `GET /api/bots/[botId]/draft/validation`                     | `bot.read` | 200 `{ draftRevision, ok, diagnostics }`                | 400, 404, 409 `NO_DRAFT`                            |

Common answers (unchanged `handleApi`): 401 no session; 403 foreign origin, missing permission, no ACTIVE membership or pending
password change; 409 `ACTOR_CHANGED` / `ORGANIZATION_SELECTION_REQUIRED`. Every response is `Cache-Control: no-store` with the
existing `{ error: { code, message, fields? } }` envelope. `DRAFT_INVALID.reason` is deliberately not exposed over HTTP.

- **List.** Tenant-scoped, ascending `key`, default 50 / max 100 (the existing `LISTING_LIMIT_*`), cursor = base64url of
  `[lastKey]`. Items are `{ id, key, name, description, draftRevision, hasDraft, draftUpdatedAt, createdAt }`; the draft column
  is never selected (`hasDraft` is `draft_updated_at IS NOT NULL`, tied to the draft by `bots_draft_shape_check`). Timestamps
  in list items are microsecond UTC strings (the existing listings' format); the detail and create responses keep the
  millisecond ISO strings of `BotSummary`. The CLI's `listBots` is untouched.
- **Query.** `pageQuery` (HTTP boundary) refuses a repeated key and any `limit` that is not `^[1-9]\d{0,2}$`, converts it to
  a number, and passes other keys on for the service's strict schema. `listBotsPage` itself takes a numeric limit, exactly
  like the three existing listings, whose input contracts are unchanged.
- **Cursor.** Malformed encoding, shape or key: 400. A well-formed cursor holding a different valid key only chooses where
  the caller's own page starts. Pagination is not a snapshot: a replay reflects current data. Bot keys are not
  database-immutable; no approved operation renames or deletes one.
- **IDs.** The path id is the only target (`withTarget(body, botId, "botId")`); a body `botId` is 400. A malformed id is 400
  `fields: ["botId"]` for a permitted caller; a missing id and another organization's id share one 404.
- **Order of checks.** Same-origin (mutations) → session and membership → expected-actor → body → service. The two write
  services parse before the permission check (existing behaviour, preserved): a caller without `bot.edit` gets 403 for valid
  input and 400/422 for malformed input. The read path checks the permission first, then the id.

## Intentional compatibility changes

1. **The default body limit of every `handleApi` / `handlePlatformApi` route is now 16,384 raw bytes as received.** It was
   16,384 UTF-16 code units of the decoded text (plus a declared-Content-Length check). Whitespace and escaping count. The
   body is read as a stream and abandoned at the chunk that crosses the limit. Decoding is unchanged (`request.text()`
   semantics: BOM dropped, malformed UTF-8 replaced, never refused). The 17 affected handlers are listed in the DEV-1 addendum.
   Requests newly refused with 400 `fields: ["body"]` (they were accepted before when Content-Length was absent or understated):
   - any body over 16,384 bytes but at most 16,384 code units, for example multibyte text padded with whitespace;
   - **staff text messages near the application limit in 4-byte characters**: the schema's `.max(4096)` counts code points, so
     4,096 emoji are schema-valid, but that text alone is 16,384 bytes. This corrects the planning addendum, which wrongly
     stated that every schema-valid text message fits;
   - **template submissions with large multilingual parameters**: the schema allows 20 × 1,024 units; the request must fit in
     16,384 bytes (it already had to fit in 16,384 characters).
     Not every schema-valid representation fits, and compact-JSON estimates are not guarantees. No figure here is an API contract
     or a provider limit. The messages route limit was not raised.
2. **Draft saves have an explicit 524,288-byte raw allowance.** It is a transport cap at the handler layer only. The canonical
   draft limit remains 65,536 UTF-8 bytes, enforced by `draftCanonical` and the database CHECK.
3. **`getBot` / `validateDraft` refuse a malformed bot id** with `VALIDATION_ERROR` (`fields: ["botId"]`) after the `bot.read`
   check. The CLI's `show` and `validate` now print that instead of surfacing a database error.

## Files

Created: `src/app/api/bots/route.ts`, `src/app/api/bots/[botId]/route.ts`, `src/app/api/bots/[botId]/draft/route.ts`,
`src/app/api/bots/[botId]/draft/validation/route.ts`, `src/modules/bot-control/routes.db.test.ts`,
`src/lib/route-helpers.test.ts`, this note.

Modified: `src/lib/route-helpers.ts` (byte reader, `maxBodyBytes`, `withTarget` key parameter, `pageQuery`, exported
`MAX_BODY_BYTES`), `src/modules/bot-control/listings.ts` (`listBotsPage`), `drafts.ts` (id check), `index.ts` (exports,
comment), `boundaries.test.ts`, `listings.db.test.ts`, `listings-cursor.test.ts`, `services.db.test.ts`.

Focused regression additions only (one test each, no production change): `src/modules/messaging/routes.db.test.ts`
(multilingual text, emoji and template-parameter byte boundaries) and `src/modules/inbox/routes.db.test.ts` (multilingual
note and quick reply).

No migration, dependency, proxy, Next.js config, error-mapper, UI, worker or CLI source change.

## Earlier database-free evidence (developer-reported; not independently reproduced here)

| Check                                                                                         | Result                                                                   |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Typecheck                                                                                     | Passed, developer-reported; not rerun for this cleanup.                  |
| Lint                                                                                          | Passed with no findings, developer-reported; not rerun for this cleanup. |
| Database-free unit suite                                                                      | 126 files, 3,085 tests passed, developer-reported.                       |
| of which `route-helpers.test.ts`, `bot-control/boundaries.test.ts`, `listings-cursor.test.ts` | 73 tests passed                                                          |
| Build                                                                                         | Passed, developer-reported; the four bot routes were listed as dynamic.  |
| Earlier formatting check on changed source and test files                                     | Passed, developer-reported.                                              |
| One-off scratch script (outside the repository, no database)                                  | Confirmed the pure expectations the route tests rely on: see below       |

These check names identify the reported verification, not independently verified command transcripts. Full log paths,
exact run commands and execution dates are unavailable in this handoff. The supplied reviewer report states that
typecheck and lint were not repeated after the response-consumption test corrections. This cleanup runs formatting only.

The database-free tests cover: the byte reader (exact 16,384 / 16,385 and 524,288 / 524,289 boundaries; Sinhala and emoji
bodies; padded and `\u`-escaped bodies; declared, understated, overstated and absent Content-Length; cancellation at the
crossing chunk; a failing stream; multibyte characters split across chunks at every offset; parity with `request.text()` for
malformed UTF-8 and a BOM; empty bodies and content type), `withTarget`, `pageQuery`, bot-list cursor validation before any
SQL, the numeric-limit contract of `listBotsPage`, and the boundary inventories (exactly four route files and five methods, one
service per method, no publish/deploy/stop/run import, mutation flags, the single raised body allowance, four read-only
listings that name no sensitive column).

The scratch script confirmed without a database: `validateFlow(minimalFlow())` has no diagnostics; the marker-seeded broken
flow yields 4 diagnostics and none contains the marker; strict schemas refuse a top-level `__proto__` key and a nested one is
canonicalised as ordinary data; nesting of 32 is accepted and 33 is `DRAFT_INVALID` / `CONFIG_TOO_DEEP` for arrays and
objects; **`JSON.parse` on this runtime parses 250,000 nested arrays successfully**, so the depth refusal is the shape guard's
422, not a parser failure; the 65,536 / 65,537-byte canonical boundaries (ASCII and Sinhala) and `1e400` behave as the tests
assert.

## Initial database attempt: stopped before any connection (historical record)

The original implementation note recorded the following developer-reported safety inspection. These are historical
observations, not a fresh inspection or a claim about the container's current state. No connection was attempted in that
initial attempt, and no credential was read or printed:

- Container `al-ict-phase08c-test-pg`, ID `35d7e9e35f3ffce9484085c76515b7d28b58140068a98487765a6216bf4689d2`: matches.
- Image `postgres:17`: matches. Port binding `127.0.0.1:55432 -> 5432/tcp`: matches. One anonymous data volume.
- **State: `exited` (finished 2026-11-13T06:29:00Z). Not running.** No container was running on the host.
- `TEST_DATABASE_ADMIN_URL` was not set in the session.

The authorization required a positively verified running target and forbade restarting containers without owner approval,
so the developer stopped that initial attempt. Nothing was created, migrated or dropped in that attempt. The original
note reported that the permanent database was never referenced.

## Subsequent database evidence

The supplied independent reviewer report records these as **developer-executed results whose saved logs the reviewer says
they inspected**. The documentation-cleanup author has not personally inspected those raw logs or reproduced these runs.

| Evidence named in the reviewer report | Result                                                   |
| ------------------------------------- | -------------------------------------------------------- |
| `run1.log`                            | 20 passed; two response-body failures before correction. |
| `run2.log`                            | Corrected route suite: 22 passed.                        |
| `run3.log`                            | Bot-control suites: 13 files, 283 passed.                |
| `run4.log`                            | Related route regressions: five files, 145 passed.       |

The route suite is included in the broader bot-control run. These counts must not be added together as independent test
counts. Full log paths, exact run commands and execution dates are **unavailable in this handoff**; the basenames and
results above are the available evidence references.

Earlier static-only uncertainties included the platform-only grant fixture, draft metadata changes, database key ordering
and concurrency assertions. The reviewer subsequently assessed the implementation and reported passing-suite evidence;
these suites are no longer described as unexecuted.

### Closed response-consumption test defects

- **403 comparison: CLOSED.** Each response is read once into `refusalTexts`; the captured strings are reused for the
  equality assertions. The status assertions remain.
- **404 comparison: CLOSED.** Both bodies are captured once; the strings are reused for byte-equality and marker-exclusion
  checks. Both 404 status assertions remain.

These were response-consumption test errors, not demonstrated tenant-isolation failures.

### Preflight provenance and limits

The reviewer reported a manual container/version-check ordering lapse. The exact sequence is unavailable in the supplied
report and is not reconstructed here. The reviewer reported inspecting harness safeguards: maintenance-target validation
before pool creation and a PostgreSQL 17 check before disposable-database creation. The saved test summaries do not
independently establish container identity or before/after database cleanup.

### Side-effect test wording cleanup

Both side-effect test titles now distinguish unchanged fingerprints for version, deployment and session rows from unchanged
row counts for deployment events, triggers, session events, outbound requests and messages. The deployed-draft test also
checks other bot rows. The final test checks that no external fetch was recorded. All assertions and test behavior are
preserved; counts alone are not presented as proof that every counted row's contents stayed unchanged.

## Documentation-cleanup verification (developer-executed)

- **Latest available typecheck:** passed, developer-reported in the supplied review; not rerun during this cleanup.
- **Latest available lint:** passed with no findings, developer-reported in the supplied review; not rerun during this cleanup.
- **Formatting:** passed, developer-executed Prettier check of this note and `src/modules/bot-control/routes.db.test.ts` during this cleanup.
- No database rerun, container operation, memory update, deployment, commit/push or live messaging is part of this cleanup.

## Remaining evidence gaps and pending items

- Full log paths, exact run commands and execution dates are unavailable in this handoff.
- The cleanup author has not personally inspected raw logs or independently reproduced verification results.
- The supplied report does not establish the exact manual preflight sequence, container identity from saved summaries or
  before/after database cleanup.
- The original owner authorization and plan/addendum were not supplied separately to the reviewer; scope was assessed
  against the review assignment and this note.
- Owner acceptance was given with these gaps acknowledged; it does not close them or any existing production gate.
- Commit/push and hosted CI remain pending. Deployment, live messaging and DEV-2 implementation are not authorized by this
  acceptance.

## Limitations and follow-ups (not addressed here)

- The 512 KiB cap is enforced in the handler. `src/proxy.ts` runs on `/api/bots`, and Next.js buffers request bodies for the
  proxy separately (default 10 MiB, not configured). No end-to-end 512 KiB memory or ingress bound is claimed.
- `POST /api/account/change-password` reads its body with `request.json()` outside the shared reader and has no handler-level
  size limit. Pre-existing; out of scope.
- A stream that fails mid-upload answers a generic 500 and logs the error name only (existing `toErrorResponse` behaviour).
- The three read handlers rely on the per-request access context; only writes re-validate the actor under lock (existing
  design for every read in the application).
- Leads and Inbox list routes still accept repeated query keys (last wins); not retrofitted.
- Cursor decode failures report `fields: ["body"]`, as the existing listings do.
- `next build` loads the project's environment files as usual; no database test did.
