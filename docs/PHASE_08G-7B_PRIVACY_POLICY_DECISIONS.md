# Phase 08G-7B — Privacy and data-lifecycle policy decisions (corrected proposal for owner decisions)

Status: **REVISION 4 (S0B POLICY BASELINE). NOT IMPLEMENTATION-READY AND NOT IMPLEMENTATION AUTHORIZATION.** It was prepared
by static inspection of the repository only. No database was connected to and no SQL was run (the permanent `al_ict_whatsapp`
database was not touched). No schema, migration, runtime, fixture or test was changed. No browser, Meta or WhatsApp call, live
send, worker, retention run or scheduler configuration was made. Sections 4–14 name periods as placeholders (`P-…`). Section 19
records the owner-approved durations: **APPROVED PROVISIONAL ENGINEERING DEFAULTS — NOT FINAL LEGALLY APPROVED PRODUCTION
POLICY.** They authorize no implementation, migration, deletion, redaction or activation. Section 16 is kept as the option
history from which they were chosen. Production activation: **NOT AUTHORIZED.**

It builds on, and does not replace, `PHASE_08G-7_READINESS_AUDIT.md` (G7-4, G7-5) and `PHASE_08G-7_DATA_LIFECYCLE_INVENTORY.md`.
Earlier acceptance evidence is unchanged and is not re-stated as new evidence.

**Revision history.**

- Revision 1 (2026-10-31): first proposal. Independent review verdict: **DESIGN CORRECTIONS REQUIRED** (four P2 findings, one P3).
  The owner accepted all five.
- Revision 2 (2026-11-04): every finding is answered in section 1. Revision 1 statements that were wrong are removed, not kept
  alongside the correction: "send `register` after Student Enquiry ends", "Cancel stores nothing further", the flat
  `phoneNumberId` stub field, backup erasure "by expiry" as sufficient for individual erasure, and the R0–R12 order.
- Revision 3 (2026-11-04): aligned with owner decision AD-08G-MT-01 ([ADR 0022](adr/0022-internal-multi-tenant-first.md)).
  Added section 15 (tenant-aware retention, including the configuration evaluation), section 16 (owner retention decision table
  with engineering-proposed options), the OD-MT and L-9 decisions, and tenant items in S0, S4 and S14. Rule 9.1.4 now resolves
  periods per organization (15.3). The five review corrections (sections 1, 6–11) are unchanged.
- Revision 4b (2026-11-06): consistency only: the owner approved the S1 design (revision 3b) at design level; the S1 row of
  section 12 and the verdict now say so. No duration, clock or owner decision changed.
- Revision 4a (2026-11-04): consistency only, after the S1 design's revision 2: note at the top of section 10; 15.5 shared-body
  rule; EN-6 pointer; 19.2 record-retention pointer. No duration, clock or owner decision changed.
- Revision 4 (2026-11-04, S0B): the owner approved AD-08G-MT-01 and ADR 0022, Option C of section 15.3 (OD-MT-1), and a set of
  provisional engineering retention durations. Section 19 records them with their retention clocks, exceptions and the
  ambiguities still needing an owner decision. Statuses in section 13.1 are updated to match. The individual-erasure and
  restoration design (stage S1) is in [`PHASE_08G-7B_S1_ERASURE_RESTORE_DESIGN.md`](PHASE_08G-7B_S1_ERASURE_RESTORE_DESIGN.md);
  section 10 here remains the summary of its requirements. No legal question is closed by this revision.

## 0. Baseline (verified 2026-11-04)

| Item                    | Result                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Branch                  | `Bot-Foundation`                                                                                                    |
| HEAD                    | `fa4c0a089eaeec80c7eef71305232b2a57d8b904` "Enforce safe bot deployment routing with account-scoped locks"          |
| `origin/Bot-Foundation` | `fa4c0a0…` (the local remote-tracking ref; no `git fetch` was run)                                                  |
| Working tree            | Untracked: this document, ADR 0022 and (revision 4) the S1 design document. Nothing staged                          |
| 08G-7A                  | **Git checkpoint complete at `fa4c0a0`** (routing guard, GI-CL-14a, both 08G-7 documents, the 08G-6 reconciliation) |

`PHASE_08G-7_READINESS_AUDIT.md` section 10.7 still reads "OWNER GIT CHECKPOINT PENDING" because it was written before the
commit. That record is left unchanged as historical evidence; this line records that the checkpoint has since been made.

## 1. Independent-review response matrix

| Finding                                   | Original design problem                                                                                                                                                                 | Corrected decision or proposed contract                                                                                                                                                                                                                                 | Section       | Remaining owner choice                                                       | Future verification             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| **P2-1** SE → Registration transition     | Told students to send `register` after SE ended. A live session makes any text a continuation; END starts a 30-minute cooldown; a handover blocks every start until staff resolve it    | Path A (direct `register` as a first eligible message starts Registration). Path B (inside SE: explicit offer of staff handover; no bot-to-bot promise). SE collects no name, grade or `wants_call`                                                                     | 7             | OD-P11 (journey), OD-P11a (handover wording), OD-P11b (keyword-in-SE policy) | SE-CL-1 … SE-CL-8 (section 7.6) |
| **P2-2** Cancellation and consent wording | Claimed Cancel "stores nothing further" and implied Continue is consent                                                                                                                 | Precise cancellation statement; consent-stage versus post-collection cancellation distinguished; Continue recorded as an acknowledgement of a notice only, not a lawful basis                                                                                           | 8             | OD-P12, OD-P12a, OD-P13; legal L-2, L-3                                      | RE-CX-1 … RE-CX-5 (section 8.4) |
| **P2-3** Incomplete content lifecycle     | Redaction covered only `messages.body/content`                                                                                                                                          | Inventory of every text-bearing copy (error fields, status events, previews, reply previews, browser memory, `sessionStorage`, redeliveries); provider error text sanitized before persistence; invalidation by a server retention generation, not a reload requirement | 4.2, 6        | OD-P15, OD-P16                                                               | LC-1 … LC-6 (section 6.5)       |
| **P2-4** Erasure reversed by restore      | Backups were "erased by expiry"; nothing re-applies an accepted erasure after a restore                                                                                                 | An independently protected, append-only erasure-decision record outside the database's restore lineage; restore stays closed until every decision is re-applied and verified                                                                                            | 4.9, 10       | OD-P8, OD-P10, OD-P17, OD-P18; legal L-4, L-5                                | ER-RESTORE-1 (section 10.7)     |
| **P3-1** Webhook event stub               | Proposed a flat `phoneNumberId`; the readers use `metadata.phone_number_id` and `wabaId` (`envelope.ts`). Multi-account requests, statuses and requests without events were not covered | Exact stub shape from `normalize.ts` and `envelope.ts`; status-by-status eligibility; request eligibility computed over all child events, globally; separate rule for requests without events                                                                           | 4.1, 4.6, 9.3 | OD-P5, OD-P5a, OD-P1a                                                        | WH-1 … WH-8 (section 9.3)       |
| Reviewer note: outbound immutability      | A one-way exception is possible but not approved                                                                                                                                        | Control list for any future guard change; no migration, no bypass                                                                                                                                                                                                       | 9.4           | OD-P4, OD-P4a                                                                | OB-1 … OB-7 (section 9.4)       |
| Reviewer note: scheduler                  | `remaining: false` treated as completion; the run lock ignored connection pooling                                                                                                       | Backlog measured independently of the batch loop; pinned lock connection; global bounds; durable run records; restricted role                                                                                                                                           | 11            | OD-P14                                                                       | SC-1 … SC-8 (section 11.3)      |
| Reviewer note: sequencing                 | Erasure late; logs and backups after jobs; one ordering inconsistent with stage IDs                                                                                                     | Re-numbered S0–S14 in execution order                                                                                                                                                                                                                                   | 12            | —                                                                            | Stage acceptance criteria       |
| Reviewer note: legal timeline             | Only noted that a 2022 Act exists                                                                                                                                                       | Timeline with references and explicit limits on what is known                                                                                                                                                                                                           | 3.2           | L-1 … L-8                                                                    | Counsel's written advice        |

## 2. Executive privacy risk summary

1. **Personal data is copied into at least seven database places, and only one of them expires.** A student's typed name
   reaches `webhook_requests.raw_body`, `webhook_events.payload`, inbound `messages.body/content`, the rendered outbound
   `messages.content`, `outbound_requests.payload` and `bot_sessions.variables`. Provider error descriptions can reach
   `messages.error_message` and `message_status_events.error_message`. Only the session variables are redacted (30-day
   development default, operator-run).
2. **The users are very likely to include minors** (A/L ICT students; the synthetic Student Enquiry asks for a grade from 1 to 13).
   The legal consequences are legal question L-3.
3. **Student Enquiry collects a name and a grade with no notice step (SE-2).**
4. **Nothing runs on a schedule;** the existing job's completion signal can understate the backlog (section 11).
5. **Copies outside the database are uncontrolled:** host logs, provider backups (no provider chosen), Meta's own copy, staff
   browser memory and `sessionStorage`.
6. **No erasure route exists, and a future one could be undone by a backup restore** unless it is designed against that (section 10).

Redaction in place is feasible for the text-bearing categories without breaking references, deduplication or idempotency. It is
**content redaction, not anonymization**: identifiers, timing and pseudonymous links remain, and nothing here may be described to
students as full deletion while those remain.

## 3. Legal versus engineering

### 3.1 What this document does and does not claim

- **Legal obligations: none asserted.** Everything marked **LEGAL ADVICE REQUIRED** (section 13.3) needs qualified Sri Lankan
  legal advice. This document has no legal clearance, and none is implied.
- **Engineering preferences (proposed):** minimization, redaction in place, single-source period functions, bounded batches, run
  records, alerting, an erasure-decision record.
- **Development defaults (not approved policy):** 30 days session redaction (`0007` `bot_session_redaction_after()`), 14 days
  trigger deletion (`TRIGGER_RETENTION_DAYS`, D-1), the 30-minute cooldown and 3-sessions-per-24-hours cap (`RUNTIME_POLICY`,
  owner-approved product limits, not privacy periods).

### 3.2 Sri Lankan PDPA timeline (as reported; to be confirmed by counsel)

| Date        | Event                                                                                                                                                           | Reference                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 2022        | Personal Data Protection Act, No. 9 of 2022 enacted                                                                                                             | Act text (Government Publications Bureau); Data Protection Authority, `https://dpa.gov.lk` |
| 17 Jul 2023 | Part V (the Data Protection Authority) in force, per the Authority's own background page                                                                        | `https://dpa.gov.lk/Background.php`                                                        |
| —           | An earlier commencement date of 18 March 2025 for the main parts was announced, later reported as withdrawn                                                     | `https://dpa.gov.lk/est.php` (older announcement); secondary commentary                    |
| Oct 2025    | Personal Data Protection (Amendment) Act, No. 22 of 2025, reported certified 30 Oct 2025 and gazetted 31 Oct 2025                                               | Secondary commentary (for example readme.lk Digital Policy Watch)                          |
| 22 Jul 2026 | Extraordinary Gazette No. 2498/16, reported to appoint **1 January 2027** for sections 2 and 3, Part I and Part III of the Act as amended                       | DPA statement as reported by Daily FT, 10 Aug 2026; secondary commentary                   |
| 1 Jan 2027  | Reported commencement of those provisions only. Commentary reports that other Parts (for example Part II rights and Part VII) are **not** covered by that order | As above                                                                                   |

Limits: the Gazette text itself and the Amendment Act text were **not** read for this document; part numbering and scope differ
between secondary sources. Counsel must confirm (L-1) which provisions apply to this platform, from when, and what the
uncommenced Parts mean for the design. Nothing here implies that every Part has commenced or that the project complies.

## 4. Data-category decision matrix (nine categories)

Common to every category: **may include information about minors — yes** (section 2.2).

### 4.1 Raw inbound webhook requests

| Field               | Finding                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location            | `webhook_requests.raw_body bytea NOT NULL` (`0002:19`), `payload_sha256`, `ingest_status`, `ingest_error_code`, `received_at`                                                                                                                                                                                                |
| Personal data       | Everything Meta sent: `wa_id`/phone, BSUID, profile name, message text, reply titles, media ids, referral data, status recipients, provider error text                                                                                                                                                                       |
| Purpose             | Exact signed-bytes evidence; diagnosis of non-ACCEPTED deliveries                                                                                                                                                                                                                                                            |
| Current behaviour   | Kept forever (blocker 9)                                                                                                                                                                                                                                                                                                     |
| Readers in code     | None at runtime (`ingest.ts:67` writes; `operator/health.ts:81` counts bytes)                                                                                                                                                                                                                                                |
| Dependencies        | `webhook_events.request_id` → `NO ACTION`. No trigger. `NOT NULL` allows `''::bytea`. **A request is delivery-level: it has no organization and can carry events for several accounts and organizations** (`schema/webhooks.ts`). A Meta redelivery is stored as a **new** request row (the hash is deliberately not unique) |
| Approaches          | (a) Redact in place to empty bytes, keep hash and headers (marker column recommended, section 9.3). (b) Delete (blocked by child events). (c) Keep                                                                                                                                                                           |
| Eligibility         | Global, not per organization: older than `P-RAW` **and every child event is in a redaction-eligible state** (section 9.3). Requests with no child events (all non-ACCEPTED requests, and any ACCEPTED request that produced none) follow OD-P1a                                                                              |
| Owner decision      | OD-P1, OD-P1a                                                                                                                                                                                                                                                                                                                |
| Proposed acceptance | WH-1 … WH-8                                                                                                                                                                                                                                                                                                                  |

### 4.2 Inbound student messages

| Field               | Finding                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location            | `messages` (`INBOUND`): `body`, `content`, `wamid`, `reply_to_wamid`; `message_attachments` (media id, filename, MIME type)                                                                                                                                                                                                                                                                                         |
| Personal data       | Anything the student writes, including the trigger keyword, Registration answers and unsolicited content                                                                                                                                                                                                                                                                                                            |
| Purpose             | Staff timeline (the only staff-readable record of bot answers, 08G-0 L7); bot input; unread state; lead attribution                                                                                                                                                                                                                                                                                                 |
| Current behaviour   | Kept forever                                                                                                                                                                                                                                                                                                                                                                                                        |
| Copies of the text  | Conversation list preview (`inbox/list.ts:150-159`, `lm.body`); reply preview (`inbox/timeline.ts:72`, `pm.body`); parsed copy in `webhook_events.payload`; raw bytes; browser memory (section 6)                                                                                                                                                                                                                   |
| Dependencies        | `NO ACTION` references from nine tables (`bot_triggers`, `bot_session_events`, `bot_sessions` ×2, `message_reads`, `message_attachments`, `message_status_events`, `lead_attributions`, `outbound_requests`, `messages.reply_to_message_id`). Deduplication: `messages_account_wamid_uidx` plus the handler's wamid lock and existence check (`inbound/handler.ts:91-96`). The 08E first-message rule reads headers |
| Approaches          | (a) Redact in place (`body`, `content`, attachment filename → NULL; a `redacted_at` marker); keep `id`, `wamid`, direction, type, timestamps. (b) Delete (nine-table cascade, loses dedup). (c) Keep                                                                                                                                                                                                                |
| Removal impact      | Previews and reply previews read the same column, so one redaction covers them, but they must render a marker, not the generic "Message" fallback (`list.ts:48-53`). Live sessions, unprocessed triggers and non-terminal requests must be excluded                                                                                                                                                                 |
| Owner decision      | OD-P2, OD-P13, OD-P16                                                                                                                                                                                                                                                                                                                                                                                               |
| Proposed acceptance | LC-3 … LC-6; wamid dedup after redaction                                                                                                                                                                                                                                                                                                                                                                            |

### 4.3 Outbound bot and staff messages

| Field               | Finding                                                                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location            | `messages` (`OUTBOUND`): `body`, `content` (incl. `content.interactive` option titles, `display.ts:94-99`), `error_code`, **`error_message`**, `client_request_id`                                                                                                            |
| Personal data       | Staff replies; template parameters; rendered bot text including the Registration summary and SE "Thank you, {{student_name}}"; provider error descriptions (section 6.1)                                                                                                      |
| Purpose             | Staff timeline; the Registration summary is the durable staff record of an enquiry (08G-5, D-15)                                                                                                                                                                              |
| Current behaviour   | Kept forever                                                                                                                                                                                                                                                                  |
| Late updates        | `db/ops/message-status.ts` `applyToMessage` updates `latest_status`, `latest_status_at`, `error_code`, `error_message`, `updated_at` on a matching outbound message whenever a higher-priority status arrives, with no regard to redaction. It never touches `body`/`content` |
| Approaches          | As 4.2. Placeholder-only redaction is not feasible (the stored text does not mark placeholder spans)                                                                                                                                                                          |
| Owner decision      | OD-P3, OD-P15                                                                                                                                                                                                                                                                 |
| Proposed acceptance | As 4.2; redacted no earlier than the request is terminal; LC-1, LC-2                                                                                                                                                                                                          |

### 4.4 Outbound request payloads

| Field               | Finding                                                                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location            | `outbound_requests.payload jsonb NOT NULL`, `recipient_kind`, `recipient_id` (CHECK 1–255), `idempotency_key`, `request_fingerprint`; codes only in `hold_reason`, `failure_code`, `provider_error_code`, `provider_http_status`                                                                                           |
| Personal data       | Second copy of the outbound text or template parameters (blocker 43); recipient phone or BSUID                                                                                                                                                                                                                             |
| Purpose             | Dispatch (`messaging/dispatch.ts:191-199, 287`); replay; UNKNOWN_OUTCOME manual reconciliation (blocker 35)                                                                                                                                                                                                                |
| Current behaviour   | Kept forever                                                                                                                                                                                                                                                                                                               |
| Dependencies        | `outbound_requests_guard` (`0008:45`) refuses any change to `payload`, recipient, key, fingerprint and 15 other columns; `BEFORE UPDATE` only. No foreign key in `0000`–`0009` references the table. Replay compares only the fingerprint (`submit.ts:130`, `enqueue.ts:148`). Terminal states have no outgoing transition |
| Approaches          | A future, separately reviewed migration under the controls in section 9.4; or keep. Disabling triggers, `session_replication_role`, ad-hoc superuser updates and any generic bypass are **excluded**                                                                                                                       |
| Owner decision      | OD-P4, OD-P4a                                                                                                                                                                                                                                                                                                              |
| Proposed acceptance | OB-1 … OB-7                                                                                                                                                                                                                                                                                                                |

### 4.5 Session variables and interactive tokens

| Field               | Finding                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Location            | `bot_sessions.variables`, `awaiting`, `awaiting_token`, `last_consumed_token`, `redacted_at`                                            |
| Personal data       | `reg_name`, `al_year`, `class_pref`; synthetic SE `student_name`, `grade`, `wants_call`                                                 |
| Current behaviour   | Redacted 30 days after `ended_at` by `redact_expired_bot_sessions` (`0007:510`) when `bots:retention --apply` runs; live sessions never |
| Development default | **30 days — development default, not approved policy**                                                                                  |
| Dependencies        | One period function read by guard and job; database-clock `ended_at`; one-way marker                                                    |
| Approaches          | Keep 30 days; another `P-SESS` (migration replacing the function); redact at termination (guard change)                                 |
| Removal impact      | Exercised by GI-CL-13 and RE-CL-11. **Does not remove copies in 4.1–4.4**                                                               |
| Owner decision      | OD-P6                                                                                                                                   |

### 4.6 Bot lifecycle records and webhook event records

| Field               | Finding                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location            | `bot_sessions` lifecycle columns, `bot_session_events`, `bot_triggers`, `bot_deployment_events`; `webhook_events` (`idempotency_key`, `status`, `payload`, `last_error`)                                                                                                                                                            |
| Personal data       | Bot rows: no free text, pseudonymous links and timing. Event payload: the full parsed item. Idempotency keys embed the receiving `phone_number_id` and the wamid (`idempotency.ts:20-27`), or a hash of the element (`:30-35`)                                                                                                      |
| Current behaviour   | Sessions forever (guard refuses DELETE); session/deployment events append-only; triggers 14 days after `processed_at` when the job runs; webhook events forever                                                                                                                                                                     |
| Event payload use   | Handlers (PENDING/FAILED claims); `queue/requeue.ts` (UNROUTABLE and IGNORED, via `envelope.ts` readers); `operator/events.ts` (`payload ->> 'wabaId'`, `payloadPhoneNumberId`); `operator/dead.ts` `describeKind` (`field`, `message.type`, `status.status`) and `--reveal-payload`. **There is no DEAD replay** (`dead.ts:11-12`) |
| Dependencies        | No trigger on `webhook_events`. `messages.source_webhook_event_id`, `message_status_events.webhook_event_id` → `NO ACTION`; `contact_bsuids.source_webhook_event_id` → `SET NULL`                                                                                                                                                   |
| Approaches          | Bot rows: keep as audit (recommended) or a later guard-lifting migration. Events: minimize `PROCESSED` payloads to the stub in section 9.3; keep row, key and status                                                                                                                                                                |
| Owner decision      | OD-P5, OD-P5a, OD-P7                                                                                                                                                                                                                                                                                                                |
| Proposed acceptance | WH-1 … WH-8                                                                                                                                                                                                                                                                                                                         |

### 4.7 Contacts, leads, notes and attribution records

| Field             | Finding                                                                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location          | `contacts`, `contact_bsuids`, `contact_consents.evidence`, `contact_tags`, `leads`, `lead_events`, `lead_attributions`, `lead_reconcile_decisions`, `conversation_notes.body`, `conversation_events`, `message_reads` |
| Personal data     | Identity, profile name, consent evidence, staff notes about students (which may quote message text), lead history                                                                                                     |
| Current behaviour | Kept forever; notes and conversation events append-only (`0005:85-93`); lead tables guarded (`0006`)                                                                                                                  |
| Dependencies      | Every table references `contacts` with `NO ACTION`; erasure needs an ordered cascade and guard-lifting migrations. Consent evidence may itself need retaining (L-5)                                                   |
| Approaches        | Anonymize after the relationship ends; per-request erasure (section 10); keep                                                                                                                                         |
| Owner decision    | OD-P8, OD-P17                                                                                                                                                                                                         |

### 4.8 Application and operational logs

| Field               | Finding                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location            | JSON lines on stdout/stderr (`shared/logging/logger.ts`); CLI JSON reports                                                                                                                            |
| Personal data       | By convention ids, codes and counts ("Never pass secrets or message content"). **The logger does not redact.** `--reveal-payload` prints a payload when `WHATSAPP_ALLOW_PII_REVEAL=true` (blocker 30) |
| Current behaviour   | Host-dependent; no host, shipping or retention configured (blockers 26, 29)                                                                                                                           |
| Approaches          | Host retention `P-LOG`; call-site audit; reveal flag off in production                                                                                                                                |
| Owner decision      | OD-P9                                                                                                                                                                                                 |
| Proposed acceptance | Recorded call-site audit; `P-LOG` configured **before real-student activation** (section 12)                                                                                                          |

### 4.9 Backups, exports, caches and other copies

| Copy                           | Finding                                                                                                                                                                                            | Decision       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Database backups / PITR        | Not configured in the repository; provider TBD (`DEPLOYMENT.md`, ADR 0008). Age-based redaction reaches backups only as they expire. **An individual erasure must survive a restore** (section 10) | OD-P10, OD-P18 |
| Meta's copy                    | Outside the platform's control; notices must not imply it is deleted                                                                                                                               | OD-P10         |
| Operator terminals             | `--reveal-payload`; scrollback                                                                                                                                                                     | OD-P9          |
| Staff browser memory           | Loaded timeline pages and the conversation list (section 6.3)                                                                                                                                      | OD-P16         |
| Staff browser `sessionStorage` | Unresolved-send journal, same tab, up to 24 h (`inbox/pending-send.ts`, blocker 55)                                                                                                                | OD-P16         |
| HTTP caches                    | Inbox API reads use `cache: "no-store"` (`inbox/api.ts:83`). Other caches (framework router cache, proxies) were not verified                                                                      | S11 check      |
| Test artifacts                 | Synthetic only; CI failure artifacts 7 days; never produced against real data                                                                                                                      | none           |
| Exports                        | No bulk export feature exists                                                                                                                                                                      | none           |

## 5. Current versus proposed retention behaviour

| Category                     | Current                     | Proposed (method; the period is the owner's)                               |
| ---------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| 4.1 Raw webhook body         | Forever                     | Redact to empty bytes after `P-RAW` when every child event is eligible     |
| 4.6 Webhook event payload    | Forever                     | `PROCESSED` only: minimize to the section 9.3 stub after `P-EVT`; keep key |
| 4.2 Inbound message text     | Forever                     | Redact in place after `P-MSG-IN`; headers and wamid kept                   |
| 4.3 Outbound message text    | Forever                     | Redact in place after `P-MSG-OUT`, never before the request is terminal    |
| 4.2/4.3 Error descriptions   | Forever, provider free text | Code-only at persistence (section 6.1), plus redaction of existing text    |
| 4.4 Outbound request payload | Forever (guard)             | Only under section 9.4 controls after a separate review; else keep         |
| 4.5 Session variables        | 30 d (dev default), manual  | Approved `P-SESS`, scheduled                                               |
| 4.6 Triggers                 | 14 d (dev default), manual  | Approved `P-TRIG`, scheduled                                               |
| 4.6 Sessions, session events | Forever                     | Keep (no text) unless the erasure policy decides otherwise                 |
| 4.7 Contacts, notes, leads   | Forever (guards)            | Erasure procedure (section 10) first; automation later                     |
| 4.8 Logs                     | Unconfigured                | `P-LOG` at the host before activation                                      |
| 4.9 Backups                  | Unconfigured                | `P-BAK`; erasure re-application on every restore                           |

Minimization: the duplicate copies with no staff use after processing (4.1, 4.4, 4.6 payload, error text) should get the shortest
periods; the staff-visible history (4.2, 4.3) longer ones. One period for every category is neither required nor recommended.

## 6. Content reappearance, error text and browser memory

### 6.1 Error fields

| Field                                 | Writer                                                                                                                                                                                                                                     | Content                                                                                     | Reader                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `messages.error_message`              | (1) status handler via `applyToMessage` (`message-status.ts:43`), value from `status-map.ts:44-58`: Meta's `errors[0].message`, else `title`, else `error_data.details`, ≤ 500 characters. (2) `dispatch.ts:519`: the internal reason code | (1) **provider-origin free text**, content not controlled by the platform. (2) a fixed code | **None found** in the Inbox API, timeline (`timeline.ts` selects `error_code` only) or app routes |
| `message_status_events.error_message` | `recordMessageStatus` (`message-status.ts:96`), same provider text                                                                                                                                                                         | Provider free text                                                                          | None found                                                                                        |
| `webhook_events.last_error`           | Queue                                                                                                                                                                                                                                      | "sanitized; never tokens" (schema comment)                                                  | Operator tooling                                                                                  |
| `outbound_requests` failure columns   | Dispatch                                                                                                                                                                                                                                   | Codes and HTTP status only                                                                  | Status API (no body)                                                                              |

Whether Meta error descriptions ever echo message text or template parameters was **not verified**. Because the stored text has
no reader, the proposed rule is **sanitize before persistence**: store only `error_code` (and, if wanted, a fixed mapped
description chosen by the platform), never provider free text, in both columns. Existing rows are cleared by the message-
redaction stage. The alternative (keep provider text under a documented exception with its own period) is OD-P15.

### 6.2 Reappearance vectors after redaction

| Vector                                                     | Behaviour today                                                                                                              | Required contract                                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Late status for a redacted outbound message                | `applyToMessage` writes `error_message` (provider text) and a new `message_status_events` row                                | With 6.1 sanitization nothing textual is written; status fields may update; `body`/`content`/`redacted_at` unchanged                   |
| Meta redelivery of an old message                          | New `webhook_requests` row with the raw bytes; the event key already exists (duplicate); the handler sees the existing wamid | No message body is re-written; the new raw row follows `P-RAW` from its own `received_at` (the raw copy does reappear for that period) |
| Reply to a redacted message                                | The reply preview reads `pm.body`                                                                                            | Preview shows the redaction marker                                                                                                     |
| Conversation-list preview whose latest message is redacted | `safeLine(preview_body)` falls back to a type label                                                                          | Marker, not "Message"                                                                                                                  |
| Open staff tab                                             | Older loaded pages are never refetched (6.3)                                                                                 | Invalidation (6.3)                                                                                                                     |
| Backup restore                                             | Restores pre-redaction text                                                                                                  | Age retention and erasure re-applied before service resumes (section 10)                                                               |
| Staff notes quoting a message                              | Append-only staff text                                                                                                       | Outside automated redaction; covered by OD-P8 and the erasure procedure                                                                |

### 6.3 Browser memory: decision

`mergeMessages` (`inbox/merge.ts:41-56`) applies only the newest page; older pages the reader loaded stay in memory unchanged for
the life of the tab. **Requiring a reload is rejected:** it cannot be enforced on an open tab. **Proposed: a server retention
generation.** Each timeline and list response carries an organization-level counter that every redaction or erasure run
increments. On a change, the client discards every loaded page, the list and any reply preview, and refetches the first page.

Limitations (to be stated in the policy): a tab that never polls again (closed laptop, offline) keeps its memory until it next
polls or closes; copies the browser or staff made themselves (screenshots, copy-paste, extensions, developer tools) are out of
reach; the `sessionStorage` journal holds unsent reply text up to 24 h and is cleared only by its own rules. These limits are
small relative to periods measured in days, but they mean the platform cannot promise that a redaction is instantly invisible
everywhere.

### 6.4 What "redacted" means in staff-facing text

The Inbox marker (OD-P16) should say content was removed under the retention policy. It must not say the data was deleted
everywhere: Meta, backups (until reconciled) and logs may still hold copies.

### 6.5 Future regression tests

| ID   | Test                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LC-1 | A FAILED status whose provider error text contains a sentinel string: neither `messages.error_message` nor `message_status_events.error_message` stores it (unit + PostgreSQL) |
| LC-2 | Redact an outbound message, then apply a late FAILED/DELIVERED/READ status: status fields change; `body`, `content`, `redacted_at` and both error columns stay redacted        |
| LC-3 | Browser: a tab with two loaded pages; redact a message on the older page; after the next poll the sentinel is absent from the DOM and the marker shows                         |
| LC-4 | Browser: list preview and reply preview of a redacted message show the marker, desktop and phone, STAFF and VIEWER                                                             |
| LC-5 | Redelivery of a redacted message's event: no body re-written; a new raw request row exists and is itself eligible after `P-RAW`                                                |
| LC-6 | Redaction excludes messages referenced by a live session, a non-terminal trigger or a non-terminal request                                                                     |

## 7. Student Enquiry — corrected SE-2 journey

### 7.1 Facts from the runtime

- **A live session makes every input a continuation.** `evaluateStartEligibility` returns `continuation` before any start rule
  (`eligibility.ts:110`). A typed `register` inside Student Enquiry is input to the awaiting node, not a keyword. On a
  BUTTONS/LIST node a typed word that matches no option is invalid; after `maxInvalidAttempts` (2) the node's `onInvalid`
  target runs (`engine.ts:599-606`), in the synthetic SE that is a handover to staff.
- **END starts a cooldown.** Rule 6: no new session until 30 minutes after the conversation's latest session ended or the latest
  staff resolution (`eligibility.ts:147-150`, `RUNTIME_POLICY.cooldownMs`). Plus at most 3 sessions per contact per 24 h.
- **A handover blocks every start until staff resolve it** (rule 2, `handover_unresolved`). After a resolution, only input that is
  newer than the resolution can start a bot (rule 3), and the cooldown runs from the resolution.
- **Inputs older than 10 minutes are stale** (rule 7a), and keyword priority applies (Registration before Student Enquiry,
  OD-1 order enforced by G7-3).

So "send `register` after Student Enquiry ends" fails for 30 minutes and may then fail on the session cap. Revision 1's
instruction is withdrawn.

### 7.2 Owner-approved direction

- **Path A — direct Registration.** `register` (or `registration`, `join`) as the first eligible message of an eligible
  conversation starts Registration Enquiry through the approved keyword priority. Promotion of this keyword (ads, posters,
  welcome text) is how students reach Registration.
- **Path B — Student Enquiry already active.** The student is offered an explicit handover to staff. No bot-to-bot transfer is
  promised.

### 7.3 Proposed production flow (synthetic until real content is approved)

1. `language_menu` (BUTTONS) → welcome → `main_menu` (LIST): Class details · Fees · **Registration help** · Talk to a person.
2. **Registration help** → `reg_help` (BUTTONS), text placeholder: "[SYNTHETIC] Our staff can help you with registration here in
   this chat. Would you like a member of staff to take over?" Options: **Yes, talk to staff** → `reg_to_staff`; **Back to menu** →
   `main_menu`. `onInvalid` → `invalid_to_staff`.
3. `reg_to_staff` (HANDOVER, reason `student_requested`), message placeholder: "[SYNTHETIC] Thank you. A member of staff will
   reply here. This does not register you for a class. I can't say how soon." The wording follows the approved Registration
   handover pattern (no claim of registration, no time promise).
4. **No QUESTION node and no `variables` in Student Enquiry.** `ask_name`, `ask_grade`, `check_grade`, `mark_call` and `confirm`
   are removed. A definition-level test asserts SE declares no variables.
5. Every other leaf is END or HANDOVER as today, with approved content under G7-6.

**End state and visibility.** `reg_to_staff` ends the session HANDED_OVER (`student_requested`). Staff see the handover notice in
the timeline, the Bot-attention indicator and the session panel reason. No personal data beyond the conversation itself was
collected by the bot.

**Consequences for eligibility.** While the handover is unresolved, no bot starts in that conversation, including Registration
(`handover_unresolved`). Once staff resolve the conversation, a fresh `register` can start Registration only if it is newer than
the resolution, after the cooldown, within the session cap and not stale. Staff may also simply handle the registration in chat;
whether staff should instead resolve and ask the student to send `register` is OD-P11a.

**Keyword typed inside SE (OD-P11b).** Recommended: accept that a typed `register` inside SE is invalid input (re-prompt, then
`invalid_to_staff`), and make the menu option the supported route. The alternative, a typed-text option match, would need an
engine capability that was not verified to exist and is not proposed.

### 7.4 Data minimization

Compared with the synthetic fixture, SE no longer collects `student_name`, `grade` or `wants_call`. The trigger message, the
contact's Meta profile data and the conversation are still stored (they are needed to answer at all) and follow the general
periods.

### 7.5 Not changed

The synthetic fixture `enquiryFlow` and the engine are unchanged. Real content goes into new definitions (G7-6), never fixtures.

### 7.6 Future closed-loop acceptance scenarios

| ID      | Scenario                                                                  | Expected                                                                                           |
| ------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| SE-CL-1 | `register` as the first eligible message                                  | Registration Enquiry starts (approved six-bot priority); SE does not                               |
| SE-CL-2 | `register` typed while SE awaits the main menu                            | Continuation: re-prompt; second invalid → `invalid_to_staff` handover; Registration does not start |
| SE-CL-3 | SE → Registration help → Yes, talk to staff                               | HANDED_OVER `student_requested`; notice text exact; no variables stored; no further bot output     |
| SE-CL-4 | SE → Registration help → Back to menu                                     | Main menu again; session continues                                                                 |
| SE-CL-5 | `register` immediately after an SE END                                    | Ignored `cooldown`; no session; no outbound request                                                |
| SE-CL-6 | `register` after the cooldown, eligible otherwise                         | Registration starts                                                                                |
| SE-CL-7 | `register` while an SE handover is unresolved                             | Ignored `handover_unresolved`                                                                      |
| SE-CL-8 | `register` after staff resolve that handover (newer input, past cooldown) | Registration starts; an input older than the resolution is ignored `input_before_resolution`       |

## 8. Registration cancellation and consent wording

### 8.1 What Cancel does (precise)

Cancellation **stops further registration questions** and **does not complete a registration**. It does **not** remove data:

- the student's Cancel tap is an inbound message, persisted in `messages` and its webhook copies (event payload, raw body);
- the cancellation notice ("Your registration enquiry has been cancelled…") is an outbound message with an `outbound_requests`
  row;
- the session ends (END, `cancelled` node) and its variables are redacted only by the ordinary session job;
- answers already given, and any confirmation summary already sent, remain in message history and its copies under the general
  retention policy (and under OD-P13 if a shorter period for cancelled enquiries is approved).

### 8.2 Two kinds of cancellation

| Stage                                 | Data the bot asked for                          | What remains                                                                                          |
| ------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| At `consent` (before any question)    | None; `reg_name`, `al_year`, `class_pref` unset | Trigger keyword, welcome and consent prompts, the Cancel tap, the cancel notice, raw and event copies |
| At `confirm` (after answers) or later | Name, A/L year, class preference                | All of the above plus the answers and the summary                                                     |

### 8.3 Consent wording

The current synthetic text "Your answers are used only for this enquiry and are seen by our staff" says nothing about retention,
Meta's copy or how to ask for erasure, and must not suggest Cancel deletes anything. Proposed **content requirements** (wording is
OD-P12 and needs legal review, L-2): purpose; that staff see the answers; how long messages and answers are kept (the approved
periods); that WhatsApp/Meta keep their own copy; how to ask for correction or erasure; that Cancel stops the questions but keeps
what was already sent; that this is an enquiry, not a registration.

**Continue is not a lawful basis.** A Continue tap is recorded only as the student having been shown the notice and chosen to
proceed. Whether that, or anything else, is a valid basis for processing a minor's data under Sri Lankan law, and whether a
parent or guardian must be involved, is L-2/L-3. If guardian involvement is required, a chat button cannot provide it and
Registration must be redesigned before activation.

### 8.4 Future tests

| ID      | Test                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RE-CX-1 | Cancel at `consent`: session ends; `variables` equals `{}` at end (no form variable was ever set); history contains exactly the expected inbound and outbound messages and one request per outbound |
| RE-CX-2 | Cancel at `confirm`: variables were set and are redacted only by the ordinary job; the answers and summary remain in history as documented                                                          |
| RE-CX-3 | The cancel notice contains no claim of deletion (extend the claim scanners with deletion phrases)                                                                                                   |
| RE-CX-4 | Consent text, once approved, contains every content requirement in 8.3 (checklist test on the definition)                                                                                           |
| RE-CX-5 | If OD-P13 is approved: messages of conversations whose Registration session ended at `cancelled` become eligible at the shorter period, and others do not                                           |

## 9. Database integrity, idempotency and copy-specific contracts

### 9.1 General rules

1. Prefer redaction in place; every foreign key, unique index and header column stays valid.
2. Deduplication survives: keep `wamid`; keep webhook event rows and `idempotency_key`; keep outbound key and fingerprint.
3. Never redact anything a live process or a recovery path still reads (predicates, not timing).
4. Immutable rows change only through a shaped, reviewed migration modelled on `bot_sessions_guard` (one database-side period
   resolver read by both guard and job — per organization and category, section 15.3; whole-row comparison; one-way,
   database-stamped marker; bounded `SKIP LOCKED` function that is the only caller, pinned by a boundary test).
5. Copies are not linked: each copy has its own step and its own line in the run report.
6. Jobs assume `READ COMMITTED` (verify on the production connection, as for G7-3).

### 9.2 Retention clocks (OD-P19)

| Copy              | Proposed clock start                                         |
| ----------------- | ------------------------------------------------------------ |
| Raw request       | Latest child `processed_at`, all children PROCESSED (19.3)   |
| Webhook event     | `processed_at` (PROCESSED only)                              |
| Message           | Case closure or cancellation (19.3 #2–#5), not `occurred_at` |
| Outbound payload  | `finished_at` (terminal)                                     |
| Session variables | `ended_at` (database clock; existing)                        |
| Trigger           | `processed_at` (existing)                                    |

Database clocks are proposed so a provider or client timestamp cannot shorten or lengthen retention.

### 9.3 Webhook event stub and request eligibility (P3 correction)

**Stored envelope** (`normalize.ts:125-133`): `{ "v": 1, "wabaId": …, "field": …, "metadata": <Meta metadata object or null>,
…extra }`, where `extra` is `{ contact, pairing, message, identifierIntegrity? }` for MESSAGE, `{ status }` for STATUS and
`{ element }` for OTHER and malformed items. The routing readers are `phoneNumberIdOf` (`payload.metadata.phone_number_id`),
`wabaIdOf` (`payload.wabaId`) and their SQL forms (`#>> '{metadata,phone_number_id}'`, `->> 'wabaId'`), `envelope.ts`. Revision
1's flat `phoneNumberId` would have broken them.

**Proposed stub** (for `PROCESSED` events only):

```json
{
  "v": 1,
  "wabaId": "<unchanged>",
  "field": "<unchanged>",
  "metadata": { "phone_number_id": "<unchanged>" }
}
```

- `metadata.phone_number_id`, `wabaId` and `field` are copied byte-for-byte from the stored payload (they identify the business
  number, not the student); `null` stays `null`. Other `metadata` keys (for example the business display number) are dropped
  unless OD-P5a keeps them.
- The redaction marker is a `payload_redacted_at` column (migration, recommended) rather than a key inside the payload, so no
  JSON reader changes meaning.
- `describeKind` then reports `messageType`/`statusWord` as null; it is used only for DEAD events, which are never stubbed.

**Event-status eligibility.**

| Status     | Why it exists                                                    | Stub?                                                                                               |
| ---------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| PENDING    | Due for a claim; also IDENTITY/OTHER events no handler claims    | **No** (active). Unclaimable PENDING events never become eligible: OD-P5 must decide them (with H1) |
| PROCESSING | Leased                                                           | **No**                                                                                              |
| FAILED     | Retry scheduled                                                  | **No**                                                                                              |
| DEAD       | Inspection; future reviewed replay                               | **No**; separate rule OD-P5                                                                         |
| UNROUTABLE | Requeued when the account is registered (`requeue.ts`)           | **No**                                                                                              |
| IGNORED    | Requeue candidate (`requeue.ts:78`); system messages kept for H1 | **No** by default; separate rule OD-P5                                                              |
| PROCESSED  | Done                                                             | **Yes**, after `P-EVT` from `processed_at`                                                          |

**Raw-request eligibility.** Evaluated globally (a request has no organization and may span accounts and organizations):
**every** child event is PROCESSED and `P-RAW` has passed since the latest child's `processed_at` (revision 4, 19.3 #1; the
revision 2 condition "stub-eligible" is withdrawn, since the approved `P-RAW` is shorter than `P-EVT`). One ineligible child keeps the whole
body. Requests with **no** child events (non-ACCEPTED `ingest_status`, or ACCEPTED with no events) have no other copy and are
the only evidence for diagnosis; OD-P1a sets their own period. Diagnostics that remain after redaction: `received_at`,
`ingest_status`, `ingest_error_code`, `payload_sha256`, and (recommended, by migration) the original byte length.

**Replay and deduplication.** Duplicate detection is the unique `idempotency_key`, independent of the payload, so a redelivered
item is still rejected after stubbing. There is no DEAD replay today; DEAD events are excluded anyway.

**Future contract tests** (using the real readers):

| ID   | Test                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WH-1 | For MESSAGE, STATUS, OTHER and malformed envelopes built by `normalizeEnvelope`, `phoneNumberIdOf` and `wabaIdOf` return the same values before and after stubbing |
| WH-2 | The SQL helpers return the same values on the stored stub (PostgreSQL)                                                                                             |
| WH-3 | `metadata: null` envelopes stub to `metadata: { "phone_number_id": null }` or keep `null` — one form chosen and asserted (reader returns null either way)          |
| WH-4 | A stub passed to `mapInboundMessage` / `mapStatusEvent` fails closed (no message or status written)                                                                |
| WH-5 | Non-PROCESSED events are never selected                                                                                                                            |
| WH-6 | A request with events for two organizations is emptied only when both events are eligible                                                                          |
| WH-7 | A redelivery after stubbing is a duplicate; a new raw request row is stored                                                                                        |
| WH-8 | A request without events follows only the OD-P1a rule                                                                                                              |

### 9.4 Outbound request immutability controls (no migration proposed now)

Any future redaction exception must satisfy all of the following, and needs its own independent review before a database run:

| ID   | Control                                                                                                                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OB-1 | **Eligible states** named explicitly: ACCEPTED, REJECTED, HELD. **UNKNOWN_OUTCOME is excluded by default**: staff may need the exact payload to reconcile with Meta (blocker 35); OD-P4a decides whether and when it becomes eligible (for example only after a recorded reconciliation) |
| OB-2 | A `payload_redacted_at` column stamped by the database clock in the guard (not the caller); one-way; a second redaction is refused                                                                                                                                                       |
| OB-3 | One fixed redacted-payload value, approved and stated in the migration (for example `{}`); dispatch never reads it because no eligible state can be dispatched                                                                                                                           |
| OB-4 | The redaction function locks the request row (`FOR UPDATE SKIP LOCKED`), one organization, bounded, and is the only caller (boundary test)                                                                                                                                               |
| OB-5 | Whole-row check: every column other than `payload` and the marker identical, including state, key, fingerprint, `finished_at`; any other change still raises the existing immutability error                                                                                             |
| OB-6 | `idempotency_key` and `request_fingerprint` are kept. Residual: the fingerprint is a hash of content and could confirm a guessed name; accepted or not under OD-P4                                                                                                                       |
| OB-7 | `recipient_id` is not redacted unless OD-P4 approves it; if approved, a fixed placeholder within the CHECK, in the same one-way transition, and the contact row remains the identity source                                                                                              |

Content redaction of the payload is **not** anonymization: recipient, conversation, message and contact links remain.

## 10. Individual erasure and backup restoration

**Superseded in detail (revision 4a, 2026-11-04).** Sections 10.2–10.7 are the original requirements summary. Where they
differ from [`PHASE_08G-7B_S1_ERASURE_RESTORE_DESIGN.md`](PHASE_08G-7B_S1_ERASURE_RESTORE_DESIGN.md) revision 2 — who may
append to the record (approval service, executor and restore operator, each limited, S1 5.7), the identifiers kept (exact-value
matchers per namespace in an encrypted, retirable bundle, not plain keyed hashes of `phone_e164`, S1 section 6), which decisions
a restore re-applies (every outstanding obligation, S1 3.2), and the restore steps (quarantine settlement, S1 section 11) — the
S1 design applies.

### 10.1 Problem

Age-based retention re-applies itself after a restore (the next run finds the same expired rows). An **individual erasure** is
different: it removes data that is not yet expired, so restoring a backup taken before the erasure brings it back, and nothing in
the database remembers that it was erased.

### 10.2 Erasure-decision record

An **accepted-erasure decision record**, kept **outside the primary database's backup and restore lineage**, so that restoring
the database cannot roll it back. The technology is **not chosen**: the repository has no backup or deployment configuration
(`DEPLOYMENT.md`, ADR 0008), and the choice depends on the provider decision (OD-P18). Required properties:

- **Append-only**, with its own integrity protection (for example hash-chained entries) and its own backup.
- **Access-controlled** separately from the application: the application's database role cannot write it; only named erasure
  approvers can append; restore operators can read.
- **Minimal content**, because it is itself personal data.

### 10.3 Identifiers that must survive

| Item                                          | Purpose                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Decision id                                   | Stable reference                                                                                     |
| Organization id                               | Scope                                                                                                |
| Contact ids, conversation ids                 | Primary locators; UUIDs are restored unchanged                                                       |
| Keyed hashes of `wa_id`, `phone_e164`, BSUIDs | Find the same person under another contact row; key held separately from the record and the database |
| Erasure cut-off (database time)               | Data up to this point is in scope                                                                    |
| Scope                                         | Which categories (4.1–4.7) and copies                                                                |
| Exceptions                                    | Category, legal or operational basis, approver, expiry                                               |
| Authentication and approval                   | Request channel, verification method, requester relation (student or guardian), approver(s), times   |
| Execution log                                 | Executed at, per-copy counts, verification result                                                    |
| Reconciliation log                            | Each restore: snapshot time, reconciliation time, result                                             |

### 10.4 Authentication and audit of requests (owner and legal)

How a requester is verified (for example a request from the same WhatsApp number, confirmed by staff), whether a guardian may or
must request for a minor, and the response deadline are OD-P17 and L-4. Execution needs two people (one approver, one
executor), and every step is appended to the record.

### 10.5 Restore and reconciliation procedure

1. Restore into an isolated environment. **Ordinary processing stays disabled**: webhook ingress not reachable, all three
   workers stopped, `WHATSAPP_OUTBOUND_ENABLED`, `BOTS_RUNTIME_ENABLED` and `WHATSAPP_WORKER_ENABLED` off, staff UI not exposed.
2. Re-apply **every** accepted decision from the record (idempotent), then run age retention.
3. Verify each decision: no surviving copy in scope except recorded exceptions.
4. Append the reconciliation result to the record.
5. Only then re-enable processing.

**Failures.** Any decision that fails, or an unreachable record, keeps the platform closed; reconciliation is re-run until it
passes. There is no partial resumption. While closed, Meta deliveries fail and Meta retries for a limited time (not verified);
a long outage may lose deliveries, a trade-off for OD-P18.

### 10.6 Exceptions and governance

Retained exceptions (for example consent evidence or records a law requires) are listed per decision with their basis and
expiry. The record's own retention, access review and custodian are OD-P17 (L-5). Erasure is **not** described as complete
anonymization while Meta's copy, logs, keyed hashes or exceptions remain.

### 10.7 Future restoration regression (not executed)

ER-RESTORE-1, isolated environment only:

1. Create personal data newer than every age-retention threshold (contact, inbound, outbound, request, event, raw body, note).
2. Capture a pre-erasure snapshot.
3. Apply an accepted individual erasure; record it.
4. Restore the snapshot into an isolated environment; confirm the data is back and processing is disabled.
5. Re-apply the decision from the independently kept record.
6. Verify every approved copy is redacted or removed, exceptions excepted, **before** processing is re-enabled; verify that a
   missing record or a failed step keeps processing disabled.

## 11. Retention scheduler and operations (corrected)

### 11.1 What exists

`bots:retention`: dry run by default; per organization; one statement per batch; 500 × 20 per part; `SKIP LOCKED`; `lock_timeout`
5 s, `statement_timeout` 60 s; a one-connection pool (`scripts/bots-retention.ts`, `maxConnections: 1`); one JSON report; exit 0/1/2.

### 11.2 Corrections

- **Completion is not proven by the batch loop.** `batches()` stops at the first short batch, and `remaining: false` follows.
  A short batch can mean rows were skipped because another transaction held them (`SKIP LOCKED`), not that nothing is overdue.
  After the apply phase, each part must **measure** its backlog with a count that ignores locks: overdue rows outstanding and the
  oldest overdue age. Those, not `remaining`, decide success.
- **Run lock on a pinned connection.** A session-level advisory lock is held by one connection. A pool, even of one, can
  reconnect silently after a drop, and the new connection does not hold the lock. The lock must be taken on a dedicated client
  that is never returned to a pool; before each batch the job confirms the lock is still held; on connection loss it stops at
  once and records the run as aborted. A durable run record with a heartbeat and lease (below) protects against a second run if
  the lock is lost.
- **Global bounds** in addition to per-part limits: a total wall-clock deadline and a total batch cap across organizations and
  categories, reported when hit.
- **Durable run records.** A row written **before** work starts (`started`), updated per part, closed `succeeded`/`partial`/
  `failed`. A run that crashes stays `started` with a stale heartbeat and is reported as crashed. (Requires a migration; host-only
  JSON reports cannot detect a crash before the report was written.)
- **Alerts:** non-zero exit; any part failure; a crashed run; backlog oldest-overdue age above a threshold (OD-P14); no
  `succeeded` run within the expected interval (missed run).
- **Restricted privileges.** A dedicated role that can execute only the retention functions and read the counts it needs; no
  direct UPDATE or DELETE grants on the tables. The function security model (invoker versus definer) needs its own review.
- **Restore interaction.** Scheduling is enabled only after the restore and reconciliation procedure (section 10.5) is approved
  and ER-RESTORE-1 has passed.
- **Rollout and rollback** as in revision 1: production dry run reviewed by the owner; one category per release; two monitored
  cycles before the next; redaction is irreversible, so rollback means stopping the schedule and lengthening a period by
  migration.

Scheduling options are unchanged (host cron/timer on the worker host, platform job, database scheduler, worker timer; GitHub
Actions not recommended because it would put production credentials into CI). **Host, operator and notification destination
remain OD-P14. No scheduler is configured.**

### 11.3 Future tests

| ID   | Test                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| SC-1 | A row held by another transaction is skipped; the backlog measurement still counts it; the run is not `succeeded` |
| SC-2 | Overlapping runs: the second exits with a distinct code                                                           |
| SC-3 | Lock connection killed mid-run: the job stops and records `aborted`                                               |
| SC-4 | Global deadline and batch cap stop the run and report it                                                          |
| SC-5 | A crash after `started` is detected as crashed                                                                    |
| SC-6 | Missed-run detection fires when no `succeeded` run exists in the interval (non-production)                        |
| SC-7 | The retention role cannot UPDATE or DELETE any table directly                                                     |
| SC-8 | Dry run changes nothing and reports the same backlog fields                                                       |

## 12. Implementation sequence (corrected; each stage separately authorized and reviewed)

| Stage | Checkpoint                                          | Acceptance criteria                                                                                                                                                                                                                | Safety requirements                                                |
| ----- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| S0    | Legal advice and owner policy decisions             | L-1 … L-9 answered in writing; OD-P0 … OD-P19 and OD-MT-1 … OD-MT-6 recorded (section 16)                                                                                                                                          | No code                                                            |
| S0B   | Provisional engineering retention baseline          | **Recorded (revision 4, section 19).** Durations approved as provisional engineering defaults; legal part of S0 still open                                                                                                         | No code; not legal approval                                        |
| S1    | Individual-erasure procedure design                 | Section 10 procedure, record properties and authentication approved; manual runbook written. **Design approved at design level (2026-11-06); owner implementation decisions pending: `PHASE_08G-7B_S1_ERASURE_RESTORE_DESIGN.md`** | No code; depends on S0                                             |
| S2    | Logs and backup controls design                     | Log call-site audit recorded; `P-LOG` and `P-BAK` chosen; backup provider's restore model documented; record location chosen                                                                                                       | Before any real-student activation                                 |
| S3    | Content: SE-2 journey and Registration wording      | New definitions (section 7.3, 8.3); validator, simulator, claim scanners; SE declares no variables                                                                                                                                 | No fixture edits; no publishing                                    |
| S4    | Retention framework hardening                       | Section 11 (pinned lock, run records, backlog measurement, global bounds, restricted role); per-organization period resolver with platform defaults and bounds (15.3); SC-1 … SC-8 and MT-1 … MT-3 on isolated PostgreSQL          | No new redaction yet; no tenant override table yet                 |
| S5    | Session and trigger periods                         | Migration for the approved `P-SESS`; `P-TRIG`; GI-CL-13, RE-CL-11, retention DB tests                                                                                                                                              | Isolated PostgreSQL only                                           |
| S6    | Webhook event stub and raw-body redaction           | WH-1 … WH-8                                                                                                                                                                                                                        | Isolated PostgreSQL; boundary test                                 |
| S7    | Error-text sanitization at persistence              | LC-1                                                                                                                                                                                                                               | Unit + isolated PostgreSQL                                         |
| S8    | Message redaction                                   | `messages.redacted_at`; LC-2, LC-5, LC-6; 08E first-message tests unchanged                                                                                                                                                        | Separate review of the 08E dependency                              |
| S9    | Browser invalidation and staff-history regression   | Retention generation; LC-3, LC-4; G7-7 harness                                                                                                                                                                                     | After S8; disposable database; synthetic data                      |
| S10   | Outbound payload redaction (only if OD-P4 approves) | OB-1 … OB-7; all existing guard tests                                                                                                                                                                                              | Independent review of the guard change before any database run     |
| S11   | Erasure tooling and restoration validation          | Erasure executable per S1; ER-RESTORE-1 passed; HTTP/router cache check (4.9)                                                                                                                                                      | Isolated environment only                                          |
| S12   | Log and backup controls in place                    | `P-LOG`, `P-BAK` configured on the chosen host and provider; restore runbook reviewed                                                                                                                                              | Deployment milestone                                               |
| S13   | Scheduling and monitoring rollout                   | Scheduler on the chosen host; alerts proven by induced failure, backlog and missed run in non-production; production dry run reviewed                                                                                              | Only after S11; no production apply without written owner approval |
| S14   | Production activation review                        | Readiness audit section 8 criteria plus S0–S13; MT-4 … MT-6 for every organization being activated; per-organization controller determination (L-9)                                                                                | Separate explicit owner approval                                   |

Order: S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 → S12 → S13 → S14. S3 may run in parallel with S4–S8
once S0 is done. Isolated PostgreSQL tests accompany every database stage (S4–S8, S10, S11), on the disposable harness, never
against `al_ict_whatsapp`.

## 13. Owner decision register

### 13.1 Owner product and policy decisions

| ID      | Decision                                                                                                                  | Status                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| OD-P0   | Commission the legal advice in 13.3                                                                                       | **OWNER DECISION REQUIRED**                                                                                |
| OD-P1   | `P-RAW`; redact versus delete                                                                                             | `P-RAW` **provisional (19.2 #1)**; redact versus delete open                                               |
| OD-P1a  | Period and rule for requests with no child events (non-ACCEPTED or empty)                                                 | **OWNER DECISION REQUIRED**                                                                                |
| OD-P2   | `P-MSG-IN`; shorter period for enquiry conversations                                                                      | Periods **provisional (19.2 #2, #3)**; case clock open (OD-S0B-1, OD-S0B-2)                                |
| OD-P3   | `P-MSG-OUT`; copy-to-lead step for the Registration summary before redaction                                              | `P-MSG-OUT` **provisional (19.2 #5)**; copy-to-lead open                                                   |
| OD-P4   | Whether outbound payload redaction is pursued at all; `P-OUT`; recipient redaction; fingerprint residual accepted         | `P-OUT` **provisional (19.2 #6)**; guard change still needs the S10 review; recipient and fingerprint open |
| OD-P4a  | UNKNOWN_OUTCOME: excluded, or eligible only after a recorded reconciliation and a period                                  | Excluded until reconciled (19.3); reconciliation rule open                                                 |
| OD-P5   | `P-EVT`; rules for DEAD, IGNORED and never-claimed PENDING events; key retention (Meta redelivery horizon to be verified) | `P-EVT` **provisional (19.2 #8)**; DEAD/IGNORED/PENDING rules open                                         |
| OD-P6   | `P-SESS` (keep the 30-day development default or change)                                                                  | **Provisional 7 days (19.2 #7)**; needs a migration, not authorized                                        |
| OD-P7   | `P-TRIG` (keep 14 days or change); keep or expire sessions and session events                                             | **OWNER DECISION REQUIRED** (not in the S0B set)                                                           |
| OD-P8   | Contacts, notes, consent, leads: period and anonymization                                                                 | Period **provisional (19.2 #9)**; relationship-end clock (OD-S0B-4) and method open                        |
| OD-P9   | `P-LOG`; reveal-flag policy                                                                                               | `P-LOG` **provisional (19.2 #10)**; security-audit policy and reveal flag open                             |
| OD-P10  | `P-BAK`; Meta-copy statement                                                                                              | `P-BAK` **provisional (19.2 #11)**; Meta statement open                                                    |
| OD-P11  | SE-2: supported registration journey (Paths A and B, section 7)                                                           | **OWNER DECISION REQUIRED**                                                                                |
| OD-P11a | Staff handling after `reg_to_staff` (handle in chat, or resolve and ask for `register`); handover wording                 | **OWNER DECISION REQUIRED**                                                                                |
| OD-P11b | Typed keyword inside SE: accept invalid-input behaviour (recommended) or request an engine capability                     | **OWNER DECISION REQUIRED**                                                                                |
| OD-P12  | Consent and privacy-notice wording (section 8.3), after legal review                                                      | **OWNER DECISION REQUIRED**                                                                                |
| OD-P12a | Cancellation wording and what it tells the student is retained                                                            | **OWNER DECISION REQUIRED**                                                                                |
| OD-P13  | Shorter message period for cancelled enquiries, or not                                                                    | **Provisional 30 days (19.2 #4)**; message scope open (OD-S0B-3)                                           |
| OD-P14  | Scheduler host, operator, alert destination and recipient, backlog thresholds, run-record retention                       | **OWNER DECISION REQUIRED**                                                                                |
| OD-P15  | Provider error text: sanitize before persistence (recommended) or keep under a documented exception with a period         | **OWNER DECISION REQUIRED**                                                                                |
| OD-P16  | Browser invalidation by retention generation (recommended); marker wording; `sessionStorage` journal rule                 | **OWNER DECISION REQUIRED**                                                                                |
| OD-P17  | Erasure requests: supported or not; verification; guardian role; approvers; record custodian and retention                | **OWNER DECISION REQUIRED**                                                                                |
| OD-P18  | Backup provider and restore model; where the erasure record lives; accepted delivery loss while closed for reconciliation | **OWNER DECISION REQUIRED**                                                                                |
| OD-P19  | Retention clocks (section 9.2) and exceptions; idempotency-key lifetimes                                                  | Clocks proposed in 19.3; ambiguities OD-S0B-1 … OD-S0B-6 open                                              |
| OD-MT-1 | Retention configuration model: hybrid platform defaults and bounds, overrides only by platform administrators (15.3)      | **APPROVED (Option C, 2026-11-04)**; no override table yet                                                 |
| OD-MT-2 | The platform floor and ceiling for each category (section 16)                                                             | **OWNER DECISION REQUIRED**                                                                                |
| OD-MT-3 | Retention holds: who may place them, required reason, maximum duration                                                    | **OWNER DECISION REQUIRED**                                                                                |
| OD-MT-4 | Platform-operator support access to tenant personal data: grant, justification, expiry, audit (15.8)                      | **OWNER DECISION REQUIRED**                                                                                |
| OD-MT-5 | Cross-tenant raw requests: whole-body redaction for one tenant's erasure accepted (15.5)                                  | **OWNER DECISION REQUIRED**                                                                                |
| OD-MT-6 | Platform-wide log and backup periods applying to every tenant (15.7)                                                      | **OWNER DECISION REQUIRED**                                                                                |

### 13.2 Engineering decisions (for review, not policy)

| ID   | Decision                                                                                      | Recommendation                   |
| ---- | --------------------------------------------------------------------------------------------- | -------------------------------- |
| EN-1 | Marker columns (`redacted_at`, `payload_redacted_at`, raw-body marker) versus in-payload keys | Columns                          |
| EN-2 | Webhook stub: drop or keep other `metadata` keys (OD-P5a)                                     | Keep `phone_number_id` only      |
| EN-3 | Run records in a table versus host reports                                                    | Table                            |
| EN-4 | Retention function security model and role grants                                             | Separate review                  |
| EN-5 | Retention generation granularity (organization versus conversation)                           | Organization (simplest, correct) |
| EN-6 | Keyed-hash scheme and key custody for the erasure record                                      | S1 design sections 6–7           |

OD-P5a (owner sign-off of EN-2): **OWNER DECISION REQUIRED**.

### 13.3 Questions requiring qualified Sri Lankan legal advice

| ID  | Question                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L-1 | Which provisions of the PDPA (as amended) apply to this platform and from when; the effect of provisions not yet commenced (section 3.2)                                    |
| L-2 | Lawful basis for each purpose (enquiry handling, staff follow-up, attribution); whether a Continue tap after a notice has any legal relevance                               |
| L-3 | Children's data: age thresholds, parental or guardian consent, and what that means for Registration                                                                         |
| L-4 | Data-subject rights (access, correction, erasure): deadlines, verification, guardian requests, and their status before the relevant Part commences                          |
| L-5 | Records that must be kept (consent evidence, payment or tax records) and for how long; whether they override erasure                                                        |
| L-6 | Required notice content and language (Sinhala, Tamil, English)                                                                                                              |
| L-7 | Whether erasure must reach backups immediately or by documented re-application and expiry                                                                                   |
| L-8 | Obligations arising from Meta's WhatsApp Business terms as processor or controller                                                                                          |
| L-9 | For each organization on the platform: who is controller and who is processor, and what agreement is required (an organization is not automatically a controller, ADR 0022) |

No legal retention period, parental-consent rule or compliance status is stated in this document.

## 14. Remaining production-readiness gates

See section 17 (moved there in revision 3 so that the tenant sections precede it).

## 15. Retention under the internal multi-tenant direction (AD-08G-MT-01)

### 15.1 Model

Per [ADR 0022](adr/0022-internal-multi-tenant-first.md): one platform serves several organizations run by the internal team; the
organization is the logical tenant; commercial SaaS is a future direction only. An organization is a technical boundary, not
automatically the legal controller (L-9).

### 15.2 Tenant isolation during retention processing

- Every tenant-owned redaction or deletion runs **per organization**: each database function takes an `organization_id` and
  filters by it, as `redact_expired_bot_sessions(p_organization_id, p_limit)` already does (`0007:510`), and the job already
  loops per organization and isolates one organization's failure from the others (`bot-control/retention.ts`).
- No tenant-owned statement spans organizations. The only platform-level parts are the inherently shared copies (raw requests,
  15.5; routing-less UNROUTABLE events, which have no organization and follow the platform rule).
- The run report and run record list every organization separately; alerts name the organization (ids only).

### 15.3 Retention configuration: evaluation and recommendation

Revision 2 proposed one SQL period function per category. That is correct for one tenant but cannot express different periods
for different businesses without code changes.

| Option                                                                                                                                             | Fit now                            | Fit for SaaS                                    | Risk                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A. Platform-wide fixed category periods                                                                                                            | Simplest; one approved table       | Poor: every business gets the same period       | A change for one business changes every tenant                                                      |
| B. Versioned per-organization policies within constraints                                                                                          | Heavy for a few internal tenants   | Good                                            | Large configuration surface; tenant administrators could weaken retention or destroy needed records |
| C. **Hybrid (recommended):** platform defaults with floor and ceiling per category; narrow, versioned per-organization overrides inside the bounds | Same as A while no override exists | Good; the override table is the extension point | Small, if overrides are platform-administrator-only and audited                                     |

**Recommended design (C), smallest form:**

1. **Platform policy** per category: `default`, `floor` (minimum: idempotency horizons, dispute windows, any legal minimum
   from L-5) and `ceiling` (maximum: minimization). Changed only by reviewed migration, as today's period functions.
2. **One database-side resolver** `effective period (organization, category)`, read by both guards and jobs, so they cannot
   disagree (the existing 0007 pattern, with an organization argument). In the first implementation (S4) it returns the platform
   default for every organization; **no override table is built until an organization actually needs a different value.**
3. **Overrides (later):** versioned rows (organization, category, value, effective-from, reason, approver), insert-only. Set
   only by a **platform administrator** with recorded approval — never by an organization `ADMIN` in this phase. Values outside
   `[floor, ceiling]` are refused by the database. If bounds later change so that an existing override falls outside them, the
   job **refuses that organization's part and alerts**; it never silently clamps.
4. **Retention holds:** a per-organization hold (category, scope, reason, expiry) suspends redaction or deletion for records
   still required for an approved purpose (dispute, legal requirement). A tenant policy can never override a hold or a legal
   requirement.
5. **Shortening is never retroactive by surprise:** a shorter value takes effect only after a dry run for that organization has
   been reviewed.

### 15.4 Platform-wide safety constraints (not tenant-configurable)

The exclusion predicates (live sessions, unprocessed triggers, non-terminal requests, non-PROCESSED events), idempotency and
deduplication retention, the outbound immutability controls (9.4), the error-text rule (6.1), batch and global bounds, the run
lock, the restricted role, the floors and ceilings, holds, and erasure re-application after restore. No tenant setting can
disable or weaken them.

### 15.5 Cross-tenant raw webhook records

A `webhook_requests` row has no organization and may contain events for several accounts and organizations. It is redacted only
when **every** child event, whichever organization it belongs to, is `PROCESSED` and the platform `P-RAW` (a platform setting,
never a tenant one) has passed since the latest child's `processed_at` (revision 4, 19.3 #1; this replaces the earlier
"eligible under its own organization's `P-EVT`" condition). An individual erasure in one tenant that touches a shared request
may empty the whole body only as a platform-level operation after the global checks of S1 design section 10.2 (every child
PROCESSED, no other organization's hold or investigation, platform approval), subject to OD-MT-5; otherwise the body is kept
under a recorded exception.

### 15.6 Tenant-specific erasure requests

An erasure decision belongs to one organization and acts only on that organization's rows. The same person under another
organization is a separate contact (`UNIQUE (organization_id, wa_id)`) and possibly a separate controller; it is not touched.
Keyed hashes in the erasure record include the organization in their input, so the record cannot be used to link a person
across tenants.

### 15.7 Logs and backups containing several tenants

Logs, backups and the scheduler are shared. Their periods are platform-wide (OD-MT-6) and must meet the strictest approved
tenant requirement, since no tenant can have a shorter copy than the platform keeps. After any restore, reconciliation re-applies
**every** tenant's erasure decisions before any tenant resumes (section 10.5).

### 15.8 Staff access and platform-operator support access

- Organization staff reach tenant data only through an ACTIVE membership, server-side (ADR 0012).
- Platform operators today reach every tenant through database credentials and CLIs, without identity or audit. Before an
  external tenant, and recommended before a second internal one: named platform-administrator identities; support access
  granted per tenant with reason and expiry; `--reveal-payload` usable only under such a grant.

### 15.9 Auditing administrator access

An append-only audit (ids and codes, no content) of: retention policy and override changes, holds, erasure approvals and
executions, support-access grants and uses, payload reveals, and retention runs. It is platform-owned and itself retained under
a platform period.

### 15.10 Future external tenants without redesign

Adding an external tenant should need only data and agreements: a new organization, its accounts, its overrides inside the
platform bounds, its controller agreement (L-9). The enforcement (resolver, exclusions, bounds, holds, erasure record,
reconciliation) stays the same. What must be built first is listed in ADR 0022, "Future migration considerations".

### 15.11 Future tests

| ID   | Test                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------ |
| MT-1 | Two organizations with expired data: each part touches only its own organization's rows                            |
| MT-2 | A failure in one organization does not stop or alter another's run                                                 |
| MT-3 | The resolver returns the platform default for every organization; guard and job read the same value                |
| MT-4 | An override outside the bounds is refused; a bounds change that strands an override makes the job refuse and alert |
| MT-5 | A shared raw request is kept while any child event is ineligible under its own organization's period               |
| MT-6 | An erasure in organization A leaves the same `wa_id`'s contact and history in organization B unchanged             |

## 16. Owner retention decision table

**Revision 4: the durations the owner approved are in section 19 and take precedence over the "Recommended" column below,
which is kept unchanged as the option history.** Where they differ (raw bodies, message periods and clocks, outbound payloads,
session variables, contacts, logs), section 19 applies.

**Every duration below is an engineering proposal for owner consideration. None is an approved policy or a legal requirement;
each needs legal confirmation (L-1, L-5) before adoption.** Each row is a platform default under 15.3; floors and ceilings are
OD-MT-2.

| #   | Category                         | Purpose                                          | Personal / minors data                   | Development default | Options (engineering proposals)                                                                                                     | Trade-offs                                                                                                                        | Recommended for consideration                        | Dependencies and exceptions                                                    | Legal approval | Decision                |
| --- | -------------------------------- | ------------------------------------------------ | ---------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ | -------------- | ----------------------- |
| 1   | Raw webhook bodies               | Signed-bytes evidence; parse diagnosis           | Yes, full content; minors yes            | None                | A 7 days · B 30 days · C 90 days                                                                                                    | A: least exposure, little diagnostic window. B: covers the existing 30-day status report. C: longer forensics, most duplication   | **B**                                                | All child events eligible (9.3); no-event requests OD-P1a; cross-tenant (15.5) | Yes            | OD-P1, OD-P1a           |
| 2   | Inbound messages                 | Staff timeline, bot input, attribution           | Yes; minors yes                          | None                | A 12 months after last conversation activity · B 24 months · C 6 months for enquiry-only conversations, 24 months otherwise         | A: balances follow-up and minimization. B: longer support history. C: minimizes enquiry data, needs conversation classification   | **A**, plus shorter for cancelled enquiries (row 2c) | Exclusions (LC-6); dedup kept; 08E headers kept; holds                         | Yes            | OD-P2                   |
| 2c  | Cancelled Registration enquiries | None after cancellation                          | Yes; minors yes                          | None                | A same as row 2 · B 30 days · C 90 days                                                                                             | B/C remove abandoned answers early; needs session-to-message join (RE-CX-5)                                                       | **C**                                                | Only sessions ended at `cancelled`                                             | Yes            | OD-P13                  |
| 3   | Outbound messages                | Staff timeline; Registration summary             | Yes (rendered names); minors yes         | None                | A same as inbound · B 6 months · C 24 months                                                                                        | A keeps one coherent timeline. B loses "what we told the student" early                                                           | **A**                                                | Request terminal first; copy-to-lead (OD-P3)                                   | Yes            | OD-P3                   |
| 4   | Outbound request payloads        | Dispatch, replay, UNKNOWN_OUTCOME reconciliation | Yes; minors yes                          | None                | A 7 days after terminal · B 30 days · C same as messages                                                                            | A ≥ the 7-day staff retry journal, least duplication. B more reconciliation time. C needs no migration but keeps a full duplicate | **B**, UNKNOWN_OUTCOME excluded until reconciled     | Requires the guard migration (9.4); fingerprint kept                           | Yes            | OD-P4, OD-P4a           |
| 5   | Session variables, tokens        | Flow state                                       | Yes; minors yes                          | 30 days after end   | A 30 days (keep) · B 7 days · C at termination                                                                                      | A tested, keeps a debugging window. B less exposure. C needs a guard change, no post-end debugging                                | **A**                                                | Copies elsewhere remain (4.5); triggers 14 days (keep, OD-P7)                  | Yes            | OD-P6, OD-P7            |
| 6   | Lifecycle and event records      | Audit, first-message evidence, queue, dedup      | Pseudonymous; event payload full content | Triggers 14 days    | Event payload stub: A 7 · B 30 · C 90 days after processing. Session rows and keys: keep while the conversation's messages are kept | Payload has no use after PROCESSED; keys needed for dedup                                                                         | **B** stub; keep rows and keys with messages         | Only PROCESSED (9.3); DEAD/IGNORED/never-claimed PENDING separate rule         | Yes            | OD-P5, OD-P7            |
| 7   | Contacts, leads, notes           | Identity, follow-up, consent proof               | Yes; minors yes; staff notes             | None                | A anonymize 24 months after last activity · B 12 months · C keep until an erasure request                                           | A matches row 2. B less exposure, shorter follow-up. C simplest, weakest minimization                                             | **A** plus erasure on request                        | Consent evidence may need longer (L-5); guard-lifting migrations; holds        | Yes            | OD-P8, OD-P17           |
| 8   | Logs                             | Observability, incidents                         | Ids; possible leaks until audited        | Host default        | A 14 days · B 30 days · C 90 days                                                                                                   | A least exposure, short incident window. C longer investigations                                                                  | **B**, after the call-site audit                     | Platform-wide (15.7); reveal flag off                                          | Yes            | OD-P9, OD-MT-6          |
| 9   | Backups and copies               | Recovery                                         | Everything; every tenant                 | None configured     | A 7 days point-in-time · B 30 days · C 35 days                                                                                      | Shorter = less restored personal data, less recovery depth. Must be ≥ the restore need                                            | **B**                                                | Erasure re-application on restore (10.5); provider TBD                         | Yes            | OD-P10, OD-P18, OD-MT-6 |

**Other decisions preserved (no period):**

| Subject                                   | Section     | Decisions                |
| ----------------------------------------- | ----------- | ------------------------ |
| Student Enquiry minimization and handover | 7           | OD-P11, OD-P11a, OD-P11b |
| Registration consent and cancellation     | 8           | OD-P12, OD-P12a          |
| Cancelled-enquiry retention               | 8.4, row 2c | OD-P13                   |
| Error-text storage                        | 6.1         | OD-P15                   |
| Browser history invalidation              | 6.3         | OD-P16                   |
| Individual erasure and restoration        | 10          | OD-P17, OD-P18           |
| Scheduler hosting and alerting            | 11          | OD-P14                   |
| Tenant configuration and access           | 15          | OD-MT-1 … OD-MT-6        |

## 17. Remaining production-readiness gates

- **G7-4** (retention policy): this proposal; closes at S0 with OD-P12.
- **G7-5** (retention operations): sections 10–11; closes at S13.
- **SE-2**: section 7; closes at OD-P11 and S3.
- Still open and unaffected: G7-1 / GI-CL-14, G7-2, G7-6, G7-7, G7-8; blockers 9, 26, 29, 30, 43, 45, 55, 67, 75, 76, 77, 80.
- G7-3 operational conditions (READ COMMITTED on the production connection; the approved ACTIVE set) remain.
- The activation guard's production connection-isolation check remains a pre-activation condition.
- OD-P0 and L-1 … L-9 remain open after revision 4; the section 19 defaults close none of them.

**Remaining P1/P2 design issues:** none known in this design that lacks a proposed contract. Every P2 finding now has a contract
whose closure depends on owner decisions (section 13) and legal advice (13.3), and the erasure-record location (OD-P18) cannot
be designed further until the backup and deployment provider is chosen.

Production activation: **NOT AUTHORIZED.**

- Multi-tenant gaps recorded in ADR 0022 (organization provisioning, organization selector, platform-administrator identity and
  audit, row-level security evaluation) do not block the internal A/L ICT activation by themselves, but 15.8 support-access
  controls are recommended before a second internal organization holds real data.

## 18. Verdict

Revision 3: **MULTI-TENANT ARCHITECTURE RECORDED — PRIVACY POLICY READY FOR OWNER DECISIONS.**

Revision 4: **S0B DOCUMENTED.** The provisional engineering defaults are recorded (section 19); the legal part of S0 and the
open owner decisions remain. The S1 design is in its own document; the owner approved it at design level (2026-11-06, revision 3b), with its owner
policy choices, infrastructure, implementation, tests and legal review still open. It is not implementation-ready. No
retention, schema, runtime, fixture or test change was made, and none is authorized by this document.

## 19. S0B — approved provisional engineering retention baseline (revision 4)

### 19.1 Status of these values

**APPROVED PROVISIONAL ENGINEERING DEFAULTS — NOT FINAL LEGALLY APPROVED PRODUCTION POLICY.** The owner approved them on
2026-11-04 as the platform defaults under Option C (15.3). They:

- authorize **no** implementation, migration, deletion, redaction, scheduler or production activation;
- are **not** legal conclusions and do not answer OD-P0 or L-1 … L-9; Sri Lankan legal review (lawful processing, minors,
  notices, exceptions, erasure obligations, controller/processor arrangements) may change any of them;
- are platform defaults for every organization. No per-organization override table or configuration UI is introduced (15.3
  item 2). Floors and ceilings (OD-MT-2) are still open.

### 19.2 Durations

| #   | Data category                         | Provisional retention                                        | Replaces placeholder           |
| --- | ------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| 1   | Raw webhook bodies                    | 7 days after all child events are safely processed           | `P-RAW`                        |
| 2   | General enquiry messages              | 6 months after enquiry closure                               | `P-MSG-IN` (general)           |
| 3   | Enrolled-student support messages     | 12 months after case closure, where justified                | `P-MSG-IN` (support)           |
| 4   | Cancelled Registration enquiries      | 30 days after cancellation                                   | OD-P13                         |
| 5   | Outbound message history              | Same as the related conversation                             | `P-MSG-OUT`                    |
| 6   | Outbound request payloads             | 30 days after irreversible terminal resolution               | `P-OUT`                        |
| 7   | Sensitive session variables           | 7 days after terminal resolution                             | `P-SESS` (dev default 30 days) |
| 8   | Processed webhook event payloads      | 30 days, preserving necessary deduplication metadata         | `P-EVT`                        |
| 9   | Inactive contacts, leads and notes    | 12 months after the relevant business relationship ends      | OD-P8                          |
| 10  | Sanitized application diagnostic logs | 14 days; security-audit retention requires a separate policy | `P-LOG`                        |
| 11  | Backups                               | 30-day rolling period with erasure/restoration safeguards    | `P-BAK`                        |

Not in this set and still open: `P-TRIG` (bot triggers, 14-day development default, OD-P7), session and session-event rows
(OD-P7), raw requests without child events (OD-P1a), DEAD/IGNORED/never-claimed PENDING events (OD-P5), the erasure-decision
record's own retention (OD-P17; retirement by restorable-copy registry, S1 design section 7), retention-run records (OD-P14).

### 19.3 Retention clocks

The clock is the event that starts the period. Every clock is a **database-clock** timestamp (9.2), never a provider or client
time. "Proposed" marks an engineering reading of the approved wording, for owner confirmation.

| #   | Category                    | Clock start (proposed)                                                                                                                                                                                                                                                                                                                                                                                                                                             | Ambiguity requiring an owner decision                                                                                                                                                                                                                                       |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Raw webhook body            | The latest `processed_at` among the request's child events, once **every** child is `PROCESSED`. Any non-PROCESSED child (PENDING, PROCESSING, FAILED, DEAD, UNROUTABLE, IGNORED) stops the clock. This replaces 9.3's "stub-eligible" condition: the raw body may now go before the 30-day event stub, because the parsed event copy remains                                                                                                                      | Requests with no child events (OD-P1a). Whether IGNORED children (requeue candidates, `requeue.ts`) ever count as "safely processed" (OD-S0B-6)                                                                                                                             |
| 2   | General enquiry messages    | **Closure of the enquiry the message belongs to.** No "enquiry" entity exists: a conversation is unique per (organization, account, contact) (`conversations_org_account_contact_unique`), so one conversation holds every enquiry a contact ever makes. Proposed: a **case** is the span of a conversation up to a `conversation_events` STATUS change to `RESOLVED`; the clock for a message is that resolution's `created_at`; a later message opens a new case | **OD-S0B-1:** confirm the case definition. A reopened conversation must not restart the clock of messages in an earlier case, and a still-open conversation must not keep a closed case's messages forever. `conversations.last_message_at` is explicitly **not** the clock |
| 3   | Enrolled-student support    | Case closure as in #2, for cases justified as support of an enrolled student                                                                                                                                                                                                                                                                                                                                                                                       | **OD-S0B-2:** who marks a case as enrolled-student support and how. The schema has no enrolment record; lead status (`REGISTERED`, `PAID`, `CONVERTED`) must not be used as a silent proxy. Until decided, #2 applies to every case                                         |
| 4   | Cancelled Registration      | `bot_sessions.ended_at` (database clock, guard-stamped) of a Registration session that ended at the `cancelled` node                                                                                                                                                                                                                                                                                                                                               | **OD-S0B-3:** which messages are "the cancelled enquiry": those from `started_by_message_id` to the session end only, or also staff messages and unrelated student messages in that span. A cancelled form inside an open case otherwise falls under #2                     |
| 5   | Outbound messages           | The same clock as the case (or cancelled enquiry) containing the message; never earlier than its request's terminal resolution                                                                                                                                                                                                                                                                                                                                     | Follows OD-S0B-1 … OD-S0B-3                                                                                                                                                                                                                                                 |
| 6   | Outbound request payloads   | `finished_at` of a request in an **irreversible** terminal state: ACCEPTED or REJECTED. `finished_at` is written by `messaging/dispatch.ts`; whether its `now` is the database clock must be verified in S10                                                                                                                                                                                                                                                       | **OD-S0B-5:** HELD and UNKNOWN_OUTCOME (19.4). In the current guard (`0008:45`) HELD has no outgoing transition, so no HELD request can become deliverable today; it is still excluded until the owner confirms no release path is planned                                  |
| 7   | Sensitive session variables | `bot_sessions.ended_at` (existing). Changing 30 → 7 days means replacing `bot_session_redaction_after()` by migration (not authorized)                                                                                                                                                                                                                                                                                                                             | None beyond 19.4                                                                                                                                                                                                                                                            |
| 8   | Webhook event payload       | `processed_at` of a `PROCESSED` event. Kept: the row, `idempotency_key`, `status`, `event_type`, routing columns and the 9.3 stub                                                                                                                                                                                                                                                                                                                                  | OD-P5 for other statuses; Meta's redelivery horizon is still unverified, so keys are kept for the event row's life                                                                                                                                                          |
| 9   | Contacts, leads, notes      | **End of the relevant business relationship.** No column records it                                                                                                                                                                                                                                                                                                                                                                                                | **OD-S0B-4:** define it, for example the latest of: last case closure (#2/#3), the lead's last terminal status change, a recorded enrolment end. `contacts.last_seen_at` alone is rejected: it moves with any inbound message                                               |
| 10  | Logs                        | Write time of the log line, applied by the host's log store                                                                                                                                                                                                                                                                                                                                                                                                        | Host not chosen (OD-P9, OD-MT-6); security-audit logs need their own policy                                                                                                                                                                                                 |
| 11  | Backups                     | Creation time of each backup or point-in-time window                                                                                                                                                                                                                                                                                                                                                                                                               | Provider not chosen (OD-P18). Erasure decisions are re-applied on every restore (S1 design section 7)                                                                                                                                                                       |

### 19.4 Exceptions preserved (not tenant-configurable, 15.4)

No clock above runs, or its expiry is deferred, while any of these applies:

| Exception                                       | Effect                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Unresolved sessions and handovers               | Live sessions and unresolved handovers keep their messages, variables and triggers (LC-6; `redact_expired_bot_sessions` skips live rows) |
| Pending or retryable messages                   | QUEUED and SENDING requests, their messages and payloads; FAILED/PENDING/PROCESSING webhook events                                       |
| HELD requests that may become deliverable       | Excluded from #6 until OD-S0B-5 is decided (see 19.3 #6)                                                                                 |
| UNKNOWN_OUTCOME requests                        | Excluded until a recorded reconciliation (OD-P4a)                                                                                        |
| Legally justified retention holds               | Explicit, authorized, audited hold (15.3 item 4; OD-MT-3)                                                                                |
| Financial or other separately obligated records | Separate retention schedule, not these defaults (L-5)                                                                                    |
| Cross-tenant raw webhook records                | Evaluated globally over every child event (15.5)                                                                                         |
| Incident investigations, approved exceptions    | Hold with reason, approver and expiry; never open-ended                                                                                  |

### 19.5 Hybrid multi-tenant rules (unchanged, restated as binding for S4 onwards)

- Retention of tenant-owned records runs per organization; shared records (raw requests, logs, backups) are assessed across
  every organization they contain, and a shared copy is kept while any organization still needs it.
- Tenant administrators cannot weaken platform security or integrity controls (15.4).
- Any shortening of a period, including the move of session variables from 30 to 7 days, takes effect only after a reviewed
  dry run per organization.
- Retention holds are explicit, authorized and auditable.
- Another organization's data is never affected by one organization's retention or erasure, except through the shared-copy
  rules (15.5, OD-MT-5).
- The organization is the logical tenant boundary; controller and processor responsibilities are a separate legal
  determination per organization (L-9, ADR 0022).

### 19.6 New owner decisions from S0B

| ID       | Decision                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------- |
| OD-S0B-1 | Definition of an enquiry case and its closure event (19.3 #2)                                           |
| OD-S0B-2 | Who justifies a case as enrolled-student support, how it is recorded, and the default when not recorded |
| OD-S0B-3 | Message scope of a cancelled Registration enquiry                                                       |
| OD-S0B-4 | Event that ends "the relevant business relationship" for contacts, leads and notes                      |
| OD-S0B-5 | Whether HELD is ever released; until then HELD payloads are excluded                                    |
| OD-S0B-6 | Whether IGNORED (and later DEAD) child events can count as "safely processed" for raw-body expiry       |

All are **OWNER DECISION REQUIRED**. OD-S0B-1 and OD-S0B-4 must be decided before stage S8 (message redaction) and any
contact anonymization can be implemented. None of them blocks S1, which acts on an individual's approved request rather than
on age.
