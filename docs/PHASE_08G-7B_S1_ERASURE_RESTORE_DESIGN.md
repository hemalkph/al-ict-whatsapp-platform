# Phase 08G-7B S1 — Individual erasure and backup-restoration design

Status: **S1 DESIGN APPROVED — OWNER IMPLEMENTATION DECISIONS PENDING** (revision 3b, approved by the owner at design level on
2026-11-06). **Not implementation authorization, production readiness or legal compliance**; section 17 separates what is
approved from what is not. It was prepared by
static inspection of the repository only. No database was connected to and no SQL was run (the permanent `al_ict_whatsapp`
database was not touched). No schema, migration, runtime, fixture or test was changed. No restore, retention run, worker,
browser session, Meta call or WhatsApp send was made. Production activation: **NOT AUTHORIZED.**

It implements stage S1 of [`PHASE_08G-7B_PRIVACY_POLICY_DECISIONS.md`](PHASE_08G-7B_PRIVACY_POLICY_DECISIONS.md) (section 12)
and supersedes the detail of its section 10. It follows [ADR 0022](adr/0022-internal-multi-tenant-first.md) and the provisional
retention baseline in section 19 of the policy document (unchanged by this revision). Nothing here is a legal conclusion:
whether, when and how far the platform must erase is L-4, L-5 and L-7.

**Revision history.**

- Revision 1 (2026-11-04): first design. Two independent reviews: **S1 DESIGN CORRECTIONS REQUIRED**. The owner accepted the
  findings of both.
- Revision 2 (2026-11-04): consolidated corrections (section 1). Revision 1 statements that were wrong are removed, not kept
  beside the correction: restore replay limited to EXECUTED/PARTIAL/VERIFIED; signed checkpoints as proof of completeness;
  digits-only normalization of `wa_id`; username as a matching identifier; automatic erasure of hash-only matches; "30 days plus
  margin" retirement; deletion of a derivable key as destruction; a conversation-level marker with a short maximum duration;
  "the decision is re-run daily" as the redelivery answer; whole-body raw redaction by one tenant's decision alone; restore
  steps that require unfinished work to complete while workers are off.
- Revision 3 (2026-11-06): the focused closure review closed the other findings in design and returned three P2 contradictions
  (S1-F20 … S1-F22). Removed: identifier erasure clearing the subject's lookup keys before `VERIFIED` (now a separate identifier
  fence, 8.1, 8.5); "an unprocessed trigger is stale and cannot start a session" (now a restore boundary for bot inputs, 11.2a);
  "re-check ledger freshness until the head is stable" as the cutover guarantee (now an approval-publication fence, 11.3, 11.5).
  All other revision 2 contracts are unchanged.
- Revision 3a (2026-11-06): targeted verification closed P2-1 and P2-3 and kept P2-2 open: 11.2a classified restored inputs by
  provider time, which is untrusted (a future-skewed restored event passed). Replaced by database provenance: an inherited-event
  set recorded at restore, one automation flag in the existing inbound handler, and conservative suppression of uncertain new
  events (11.2a). ER-47 is rewritten with a mutation check; ER-52 … ER-57 added. Sections 8 and 11.5 are unchanged, except that
  held erasure events are no longer proposed for automatic processing (8.5, OD-S1-18).
- Revision 3b (2026-11-06): the reviewer kept P2-2 open because 3a's membership covered only PENDING, FAILED and PROCESSING after
  settlement, while held UNROUTABLE and IGNORED events return to PENDING through activation and operator requeue. Membership now
  covers every snapshot event regardless of status, captured before any write (11.2a, 11.3 step 2). ER-47 is split into
  ER-47A … ER-47C; ER-54 states the actual `invalid_timestamp` behaviour; the 24-hour pause is withdrawn and bot automation stays
  off until explicitly authorized (OD-S1-19). P2-1, P2-3 and every other contract are unchanged; 11.5's step numbers follow the
  renumbered 11.3.
- Design approval (2026-11-06): the owner accepted revision 3b at design level; P2-1, P2-2 and P2-3 are closed in design and no
  further general S1 review is requested. Added section 17 (approval status), 18 (staff-facing wording) and 19 (implementation
  checkpoints). No contract changed.

## 0. Baseline (verified 2026-11-04)

| Item                    | Result                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                  | `Bot-Foundation`                                                                                                                                                                                            |
| HEAD                    | `fa4c0a089eaeec80c7eef71305232b2a57d8b904`                                                                                                                                                                  |
| `origin/Bot-Foundation` | `fa4c0a0…` (local remote-tracking ref; no fetch)                                                                                                                                                            |
| Working tree            | Untracked: the policy document, ADR 0022, this document. Nothing staged                                                                                                                                     |
| Schema inspected        | Migrations `0000`–`0009`; guards in `0004`/`0008` (outbound), `0005` (Inbox append-only), `0006` (leads), `0007` (bots)                                                                                     |
| Code inspected (rev. 2) | `whatsapp/identifiers.ts`, `identity/resolve.ts`, `whatsapp/ingest.ts`, `inbound/handler.ts`, `messaging/submit.ts`, `messaging/dispatch.ts`, `db/ops/bot-step.ts`, `bot-runtime/step.ts`                   |
| Review reports          | **The two reviewer reports were not available in the workspace.** Findings are taken from the owner's consolidated correction brief; original reviewer finding IDs are therefore not reproduced (section 1) |

### 0.1 Code facts this revision relies on

| Fact                                                                                                                                                                                                              | Source                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Provider identifiers (wamids, BSUIDs, phone-based ids) are **opaque keys**: accepted exactly as sent or rejected; "never normalizes, trims or truncates"; no grammar imposed                                      | `whatsapp/identifiers.ts:3-7, 27-37`                        |
| `contacts.phone_e164` has **no writer** in application code (schema only)                                                                                                                                         | `db/schema/contacts.ts:18`; grep                            |
| Identity resolution takes `pg_advisory_xact_lock` on sorted keys `wa-identity:{org}:bsuid:{bsuid}` and `wa-identity:{org}:wa:{waId}`, requires READ COMMITTED, then reads                                         | `identity/resolve.ts:63-96`                                 |
| The resolver fills `wa_id` "only when empty and unowned" and replaces `profile_name`/`username` from a newer event                                                                                                | `identity/resolve.ts:298-318`                               |
| Contacts are per organization; conversations are per (organization, account, contact), so one contact can have a conversation per WhatsApp account                                                                | `0000` unique constraints                                   |
| Ingest inserts the `webhook_requests` row **before** the events; events use `onConflictDoNothing` on `idempotency_key`; an all-duplicate delivery therefore leaves an ACCEPTED raw row with **no child event**    | `whatsapp/ingest.ts:57-72, 118-128, 200`                    |
| Inbound handler serializes one logical message on an advisory lock over (organization, account, wamid) and does nothing if it is already stored                                                                   | `inbound/handler.ts:28-34, 91-100`                          |
| Staff submission locks the conversation `FOR UPDATE`, then an idempotency advisory lock                                                                                                                           | `messaging/submit.ts:100-116`                               |
| Bot steps lock: trigger row → conversation advisory try-lock → `bot-contact:{org}:{contactId}` try-lock (start path) → deployments `FOR SHARE` → conversation `FOR UPDATE` → session → account                    | `db/ops/bot-step.ts:10, 55-63`; `bot-runtime/step.ts:30-32` |
| Dispatcher claims `FOR UPDATE SKIP LOCKED` on a QUEUED row plus `wa-outbound-account:{accountId}` try-lock; a stale SENDING claim is recovered to UNKNOWN_OUTCOME; an answer from Meta is never queued again      | `messaging/dispatch.ts:36-52, 232-255`                      |
| The outbound guard permits QUEUED → HELD and SENDING → UNKNOWN_OUTCOME; HELD, ACCEPTED, REJECTED, UNKNOWN_OUTCOME have no outgoing transition; `hold_reason` is a code `^[a-z0-9_]{1,64}$`                        | `0008:45-75`; `0004` codes check                            |
| A live session may become HANDED_OVER with `end_reason = 'system_handover'` and a code `handover_reason` (CHECKs `0007:122-131`); the guard stamps `ended_at` and allocates the control sequence                  | `0007:413-486, 500`                                         |
| `conversation_notes` and `conversation_events` share the trigger function `staff_inbox_append_only()`                                                                                                             | `0005:85-93`                                                |
| (rev. 3) The resolver looks up the alias and the `wa_id` owner, then creates or links a contact, all under the identity locks; the handler resolves the contact **before** creating the conversation              | `identity/resolve.ts:113-120`; `inbound/handler.ts:125`     |
| (rev. 3) An input is stale only when **strictly older than 10 minutes** when the runtime reaches it (`maxInputAgeMs`); a fresh restored trigger is therefore processable                                          | `bot-runtime/policy.ts:25`; `bot-runtime/step.ts:90`        |
| (rev. 3) The trigger's `input_occurred_at` is the provider time capped at receipt + 5 minutes (`effectiveActivityTime`); the provider time of a redelivered or restored event is its original, **untrusted** time | `whatsapp/time.ts:5-10`; `inbound/handler.ts:77, 198`       |
| (rev. 3) `bot_triggers` has **no guard trigger**; PENDING → IGNORED with a code is the existing `endConversationTriggersSql(outcomeCode)` operation (clears the claim, stamps `processed_at`)                     | `0007:142-173`; `db/ops/bot-trigger-queue.ts:340-363`       |
| (rev. 3) The inbound handler's only automatic-reply hook is `captureBotTrigger`; bot replies are the only automatic outbound path                                                                                 | `inbound/handler.ts:188-199`                                |
| (rev. 3) `deadWebhookEvent` handles only a fenced PROCESSING claim; direct settlement of a PENDING/FAILED event needs a reviewed operation                                                                        | `db/ops/webhook-queue.ts:131-140`                           |

## 1. Consolidated findings matrix

IDs are this document's. "Brief item" is the owner's consolidated correction number; the reviewers' own finding IDs were not
available (section 0). Equivalent defects reported by both reviewers are merged into one row.

| ID     | Brief item   | Revision 1 location         | Defect                                                                                                                 | Corrected contract                                                                                                                                               | Owner decision         | Verification                                 |
| ------ | ------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------- |
| S1-F1  | 2 (C1)       | §2, §3.9, §7.1 step 4       | Restore replayed only EXECUTED/PARTIAL/VERIFIED; EXECUTING, PLAN_APPROVED and CLOSED could be skipped                  | Every approved decision is an **obligation** until retired (§3); intent and commit evidence per step (§3.3)                                                      | OD-S1-10               | ER-19, ER-20, ER-21                          |
| S1-F2  | 3 (C2)       | §5.6, §5.10                 | Periodic signatures do not protect an unwitnessed tail; no append serialization                                        | Conditional per-sequence append, two-store witnessed durability, head freshness (§5.3–5.5)                                                                       | OD-S1-14, INF-1, INF-4 | ER-22, ER-23, ER-24, ER-25                   |
| S1-F3  | 4 (C3)       | §5.3                        | Digits-only `wa_id`; username as identity; key versioning unclear                                                      | Namespace recipes on exact stored bytes; mutable names excluded; master-key and recipe versions (§6)                                                             | OD-S1-11               | ER-26, ER-27                                 |
| S1-F4  | 5 (C4)       | §3.3, §7.1 step 4           | Hash match after restore could erase an excluded family member                                                         | Manifest of approved and excluded ids; hash-only match → review, closed until resolved (§4)                                                                      | OD-S1-11               | ER-28                                        |
| S1-F5  | 6 (C5)       | §3.3 "webhook events (gap)" | Raw requests, DEAD/UNROUTABLE events not rediscoverable after identifiers are removed                                  | Manifest lists non-derivable row ids with attribution, evidence and treatment (§4.3)                                                                             | OD-S1-16               | ER-29                                        |
| S1-F6  | 7 (C6)       | §5.9                        | Arbitrary retirement; immutable entries vs later reduction; derivable key "destruction"                                | Restorable-copy registry; per-decision encrypted matching bundle with destroyable random key (§7)                                                                | OD-S1-12, INF-2, INF-3 | ER-30, ER-31, ER-32                          |
| S1-F7  | 8 (C7)       | §3.6, §3.10                 | Conversation-level marker with timeout; resolver could re-identify; multi-account gaps                                 | Persistent subject protection keyed by contacts, identifiers and all conversations; resolver-compatible locking; no timeout (§8)                                 | OD-S1-2, OD-S1-13      | ER-33, ER-34, ER-14                          |
| S1-F8  | 9 (C8)       | §3.10 row 2                 | Redelivery leaves childless raw copies a cut-off query cannot find                                                     | Duplicate-key linkage and minimization of all-duplicate requests; quarantine where unattributable (§9)                                                           | OD-S1-16, OD-P1a       | ER-35                                        |
| S1-F9  | 10 (C9)      | §6.2                        | Tenant A's decision could destroy tenant B's evidence; UNROUTABLE attribution undefined                                | Platform authority, global hold check, routing-based attribution only, recorded exceptions (§10)                                                                 | OD-MT-5, OD-S1-15      | ER-16, ER-36                                 |
| S1-F10 | 11 (C10)     | §7.1 steps 4–9              | Restore stalls on unfinished work; risk of resending restored QUEUED/SENDING                                           | Quarantine settlement using only existing permitted transitions (§11.2)                                                                                          | OD-S1-17               | ER-37, ER-38                                 |
| S1-F11 | 12 (C11)     | §3.2, §5.5                  | Approval provenance forgeable by the executor; separation by membership, not human                                     | Approver-signed approval artifact; separation by authenticated human; single-ADMIN rule (§12)                                                                    | OD-S1-3, OD-S1-4       | ER-39, ER-40                                 |
| S1-F12 | 13           | §5.3–5.4                    | Key and recipe versions implicit                                                                                       | Explicit `key_version` and `recipe_version` on every matcher (§6.2)                                                                                              | —                      | ER-26, ER-27                                 |
| S1-F13 | 13           | §5.6                        | Concurrent append forks                                                                                                | Put-if-absent per sequence number (§5.3)                                                                                                                         | —                      | ER-24                                        |
| S1-F14 | 13           | §5.10                       | Ledger disaster-recovery completeness not verified                                                                     | Two-store comparison and DR exercise (§5.6)                                                                                                                      | INF-4                  | ER-25                                        |
| S1-F15 | 13           | §3.7                        | Retained fingerprints and keys could be read as anonymous                                                              | Explicit statement and outcome wording (§2.2, §13)                                                                                                               | —                      | Review                                       |
| S1-F16 | 13           | §6.1 notes row              | A notes migration could weaken event immutability through the shared function                                          | Separate function for notes; event trigger unchanged; regression (§13)                                                                                           | —                      | ER-41                                        |
| S1-F17 | 13           | §3.6                        | READ COMMITTED and locking assumptions implicit                                                                        | Stated per coordination point (§8.4)                                                                                                                             | —                      | ER-34                                        |
| S1-F18 | 13           | §3.7, §3.8                  | Erased content not distinguished from retained identifying links                                                       | Table of erased versus retained (§2.2)                                                                                                                           | —                      | Review                                       |
| S1-F19 | 13           | §6.1                        | Guard preservation implicit                                                                                            | Immutable guards preserved; no bypass, no unrestricted mutation (§13)                                                                                            | —                      | ER-9                                         |
| S1-F20 | Closure P2-1 | Rev. 2 §8.1, §8.2           | Identifier erasure cleared the protection's lookup keys before `VERIFIED`; a crash let a new contact bypass protection | Keyed identifier fence, checked by the resolver before any create or link, kept until authorized release after `VERIFIED` (§8.1, 8.2, 8.5)                       | OD-S1-2, OD-S1-18      | ER-42, ER-43, ER-44, ER-45                   |
| S1-F21 | Closure P2-2 | Rev. 2 §11.2                | Restored pending triggers assumed stale; fresh ones (< 10 min) could reply again                                       | Restored triggers settled; snapshot events recorded by database provenance, captured without automation; uncertain new events suppressed (§11.2, 11.2a; rev. 3a) | OD-S1-17, OD-S1-19     | ER-46, ER-47A … ER-47C, ER-48, ER-52 … ER-57 |
| S1-F22 | Closure P2-3 | Rev. 2 §11.3 step 8         | No exclusion between the final ledger check and resumption; a new approval could be omitted                            | Approval-publication fence in the ledger chain, held from before the final reconciliation until cutover completes (§11.3, 11.5)                                  | OD-S1-14               | ER-49, ER-50, ER-51                          |

## 2. Scope, terms and non-claims

### 2.1 Terms

| Term               | Meaning here                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Subject            | The individual the request concerns, represented in **one** organization by the approved contact ids of the manifest                    |
| Decision           | An approved determination that named categories of the subject's data in one organization are redacted or deleted                       |
| Manifest           | The immutable, approved target and exclusion set of a decision (section 4)                                                              |
| Obligation         | A decision that must be applied to any database state that may contain its targets (section 3)                                          |
| Ledger             | The independently protected, append-only decision record outside the application database's restore lineage (section 5)                 |
| Restorable copy    | Any backup, PITR window, provider snapshot, offline copy, export or DR medium from which application data could be restored (section 7) |
| Subject protection | Persistent, tenant-scoped processing block for an approved subject while an obligation is not fully applied (section 8)                 |
| Identifier fence   | The part of subject protection keyed by identifier matchers, not contact ids, so it survives identifier erasure (8.1, 8.5)              |
| Bot-input boundary | Restore epoch in the restored database plus the snapshot events it inherited; inherited or uncertain inputs never start a bot (11.2a)   |
| Cutover fence      | Ledger state during which no new obligation can be published, held across final reconciliation and resumption (11.3, 11.5)              |
| Redaction          | Replacing content columns with a fixed value in place, keeping the row, its keys and its references                                     |
| Identifier erasure | Removing `wa_id`, `phone_e164`, `profile_name`, `username` and BSUID aliases from approved contacts                                     |
| Cut-off            | Database time recorded at manifest approval. Rows created after it are outside the decision, except where section 9 links them to it    |

### 2.2 What is erased versus what remains

| Erased (when in scope and not excepted)                                 | Retained identifying links (pseudonymous personal data, **not anonymous**)                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Message `body`/`content`, attachment filename and error text            | Row UUIDs, composite keys, `wamid`, `reply_to_wamid`                                                                                 |
| Provider error text in `messages` and `message_status_events`           | `webhook_events.idempotency_key` (embeds the business `phone_number_id` and the wamid, or an element hash)                           |
| Webhook event payload (to the policy 9.3 stub)                          | `webhook_requests.payload_sha256` (a hash of the raw body: confirms a guessed body)                                                  |
| Raw webhook body (subject to section 10)                                | `outbound_requests.idempotency_key`, `request_fingerprint` (a content hash: confirms a guessed message), `recipient_id` unless OD-P4 |
| Request payload (only after the S10 guard change)                       | Bot lifecycle rows, events, control sequences; `conversation_events`; timing of everything                                           |
| Session variables and tokens (after a sanctioned guard path)            | Ledger contents: manifest ids, encrypted matching bundle until retired, approval artifacts, outcome                                  |
| Notes and lead linkage (after reviewed migrations)                      | Every recorded exception; identifier-fence matchers and fence hits until release (8.5)                                               |
| Contact identifiers and BSUID aliases (identifier erasure, if in scope) | Meta's copy; staff-made copies; logs until `P-LOG`; restorable copies until destroyed or retired                                     |

Not every request permits complete deletion. The outcome to the requester lists what was erased, what was kept and why.

## 3. Decision lifecycle and obligation contract

### 3.1 Ledger entry types

Every entry belongs to one decision and one organization (except platform entries in section 10, which reference one).

| Entry                                        | Written                                                                 | Meaning                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `REQUEST_RECEIVED`                           | When opened                                                             | Request exists; no obligation                                                        |
| `IDENTITY_VERIFIED`                          | After verification                                                      | Verification method and evidence reference                                           |
| `REJECTED` / `WITHDRAWN`                     | Before `APPROVED` only                                                  | Closes a request that never became an obligation                                     |
| `MANIFEST_APPROVED`                          | Approval artifact (section 12) for the manifest, scope and cut-off      | **The obligation starts here.** The manifest is immutable from now                   |
| `PLAN_APPROVED`                              | Second approval artifact over the plan hash                             | Execution may begin                                                                  |
| `PROTECTION_INTENT` / `PROTECTION_COMMITTED` | Around creating subject protection (section 8)                          | Protection is in force in the database                                               |
| `STEP_INTENT`                                | Before each destructive database step                                   | Durable intent; execution may proceed only after this is acknowledged by both stores |
| `STEP_COMMITTED`                             | After the step's database transaction committed                         | Cites the database receipt (3.3)                                                     |
| `STEP_FAILED`                                | After a step's transaction rolled back                                  | Diagnostic code; the step is re-run                                                  |
| `EXCEPTION_RECORDED` / `EXCEPTION_EXPIRED`   | Per exception                                                           | Exception row, basis, approver, expiry                                               |
| `VERIFIED`                                   | After the verification queries passed and a second pass changed nothing | Every in-scope category reconciled in the live database                              |
| `CLOSED`                                     | After `VERIFIED` and the requester outcome                              | Administrative closure. **Does not end the obligation**                              |
| `RESTORE_REAPPLIED`                          | Per decision and restore (section 11)                                   | Reconciled in one restored environment                                               |
| `REVIEW_REQUIRED` / `REVIEW_RESOLVED`        | Hash-only candidate or unresolved scope (section 4.4)                   | Blocks resumption until resolved by a new approval artifact                          |
| `PROTECTION_RELEASED`                        | Release step after `VERIFIED` and a release artifact (8.5)              | Subject protection and identifier fence removed in the live database                 |
| `CUTOVER_FENCE_ACQUIRED` / `_RELEASED`       | By the restore operator around final reconciliation and cutover (11.5)  | While held, no new obligation-creating approval is valid                             |
| `CUTOVER_SIGNED_OFF` / `CUTOVER_STAGE`       | Sign-off artifacts; each service-enablement stage (11.5)                | Binds the resumption to the fenced head; records how far enablement got              |
| `CUTOVER_ABORTED`                            | Two ledger custodians (11.5)                                            | Ends a fence without resumption; that destination may never resume                   |
| `MATCHER_RETIRED`                            | Per section 7.2                                                         | Matching bundle key destroyed; ids and outcome remain                                |
| `OBLIGATION_RETIRED`                         | Per section 7.2                                                         | No registered restorable copy can contain the targets any longer                     |
| `AMENDMENT_APPROVED`                         | New approval artifact referencing the decision                          | Scope change (for example an exception lifted). Never edits the original manifest    |

### 3.2 Obligation rule

1. A decision is an **outstanding obligation** from `MANIFEST_APPROVED` until `OBLIGATION_RETIRED`, whatever else has been
   recorded. `EXECUTING`, `PARTIAL`, `VERIFIED` and `CLOSED` are progress descriptions, not exits.
2. Every restore applies **every** outstanding obligation, including those approved but never executed (`PLAN_APPROVED` with no
   step) and those approved but never planned. A manifest-approved decision without an approved plan is planned and plan-approved
   inside quarantine (section 11), or the environment stays closed.
3. A `CLOSED` decision remains an obligation for any copy whose coverage time precedes its `VERIFIED` entry (section 7).
4. Only `AMENDMENT_APPROVED` changes scope, and only by addition of a new artifact; the original manifest stays readable.

### 3.3 Write-ahead intent and commit evidence

The ledger and PostgreSQL **do not share a transaction**. The protocol makes their disagreement detectable and recoverable:

1. Append `STEP_INTENT(decision, step, plan_hash, attempt_id)`. Proceed only when **both** ledger stores acknowledge (5.4).
2. Run the step in one database transaction that also inserts an **erasure step receipt** row (future migration:
   `erasure_step_receipts(organization_id, decision_id, step, attempt_id, rows_changed, committed_at)`, insert-only). The receipt
   commits or rolls back with the step.
3. After commit, append `STEP_COMMITTED(attempt_id, rows_changed)`.

| Failure                                           | State observed                               | Recovery                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Process dies before intent acknowledged           | No intent, no receipt                        | Nothing happened; retry from step 1 with a new `attempt_id`                                                                                |
| Intent acknowledged by one store only             | Divergent stores                             | Treated as not durable; repair the witness (5.5) before the database step                                                                  |
| Process dies after intent, before commit          | Intent, no receipt                           | Step did not commit (no receipt); re-run with a new attempt id. Steps are idempotent (select only unredacted rows)                         |
| Commit succeeded, acknowledgment to the tool lost | Intent, receipt present, no `STEP_COMMITTED` | Recovery reads the receipt and appends `STEP_COMMITTED` citing it ("late acknowledgment")                                                  |
| Ledger append of `STEP_COMMITTED` lost            | Same as above                                | Same; the append is idempotent by entry id (5.3)                                                                                           |
| Partial commit inside a bounded batch loop        | One receipt per committed batch              | Each batch is its own step attempt; receipts identify exactly what committed                                                               |
| Database restored after commits                   | Receipts rolled back with the data           | The ledger's intents and commits make the decision an obligation; restore replays all steps (section 11). Receipts are never the authority |

The ledger never records a commit without a receipt; the tool never starts a destructive transaction without an acknowledged
intent. Redactions are irreversible: there is no rollback of committed steps.

## 4. Approved manifest, exclusions and scope

### 4.1 Manifest content (immutable once approved)

| Field                            | Content                                                                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decision_id`, `organization_id` | Scope                                                                                                                                                 |
| `approved_contact_ids`           | Contacts confirmed as the subject                                                                                                                     |
| `excluded_candidate_ids`         | Contacts found by discovery and **explicitly excluded** (for example a sibling on a shared phone), with the matcher that found them and a reason code |
| `confirmed_conversation_ids`     | Every conversation of the approved contacts, across every WhatsApp account of the organization                                                        |
| `confirmed_account_ids`          | The accounts those conversations belong to                                                                                                            |
| `non_derivable_rows`             | Section 4.3                                                                                                                                           |
| `scope`                          | Categories and operations (section 13); whether identifier erasure is included                                                                        |
| `cut_off`                        | Database time at approval                                                                                                                             |
| `exceptions`                     | Row ids, category, basis, approver, expiry                                                                                                            |
| `matching_bundle_ref`            | Reference to the encrypted bundle (section 6.3), with recipe and key versions                                                                         |
| `manifest_hash`                  | SHA-256 of the canonical manifest; bound into the approval artifact                                                                                   |

### 4.2 Discovery and confirmation

Discovery is read-only, organization-scoped (`organization_id = :org` on every query) and runs only the matchers of section 6.
Each candidate contact is listed with the matcher that found it. **No candidate enters `approved_contact_ids` without explicit
confirmation**, and every unconfirmed candidate enters `excluded_candidate_ids`. Recycled or shared identifiers therefore never
widen scope automatically.

Derived records of the approved contacts (all composite, `NO ACTION` references unless noted):

| From             | Records                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contact          | `contact_bsuids`, `contact_consents`, `contact_tags`, `leads` → `lead_events`, `lead_attributions`, `lead_reconcile_decisions`; `conversations` (one per account)                                                                                                  |
| Conversation     | `messages` → `message_attachments`, `message_status_events` (by `message_id`, and by `wamid` where `message_id` is NULL), `message_reads`; `outbound_requests`; `bot_sessions` → `bot_session_events`; `bot_triggers`; `conversation_notes`; `conversation_events` |
| Message / status | `webhook_events` via `messages.source_webhook_event_id`, `message_status_events.webhook_event_id`, `contact_bsuids.source_webhook_event_id` (`SET NULL`) → `webhook_requests` via `request_id`                                                                     |
| Non-derivable    | Section 4.3                                                                                                                                                                                                                                                        |

**Not discoverable automatically:** the subject's details written in another contact's conversation or notes. The manifest
records this limitation and whether an optional manual search was performed.

### 4.2a Exceptions

| Kind                                   | Examples                                                                   | Handling                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Operational, transient                 | Live session, unresolved handover, QUEUED/SENDING request, claimable event | Protection (section 8) then settle; never a partial erasure around a live process |
| Operational, needs a human             | UNKNOWN_OUTCOME, HELD (OD-S0B-5), DEAD event                               | Wait for reconciliation or a time-limited recorded exception                      |
| Legal or contractual                   | Consent evidence, payment or tax records (L-5), dispute                    | Recorded exception with basis, approver, expiry                                   |
| Retention hold, incident investigation | Policy 15.3 item 4                                                         | The hold wins; re-applied when it lifts                                           |
| Integrity (no personal content)        | Section 2.2 retained links                                                 | Always kept; never described as erased                                            |

### 4.2b Plan, preview and execution order

The plan is every derived and non-derivable row minus exceptions, with the operation per category (section 13); the preview
shows counts and ids, not content (one logged sample reveal per category is allowed to confirm the match). The canonical plan
hash is bound into the `PLAN_APPROVED` artifact; execution re-derives the plan and refuses on a different hash (re-plan).

Execution order, each step under the 3.3 protocol, bounded, one organization: (1) protection (section 8); (2) error text;
(3) message content; (4) request payloads (S10, else exception); (5) session variables; (6) event payloads; (7) raw bodies
(sections 9–10); (8) notes and lead linkage; (9) identifier erasure (8.2), last; (10) retention-generation increment so open
Inbox tabs discard loaded history (policy 6.3); (11) verification queries and a second pass with zero changes → `VERIFIED`.

### 4.3 Non-derivable rows

Some rows cannot be found again from a contact id once identifiers are erased: raw requests, webhook events that produced no
linked row (IGNORED, DEAD, OTHER, UNROUTABLE), childless raw requests. For each such row confirmed during discovery, the manifest
records:

| Field             | Content                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Row reference     | `webhook_events.id` or `webhook_requests.id`                                                                       |
| Exact evidence    | `idempotency_key` (events) or `payload_sha256` and byte length (requests)                                          |
| Attribution       | `webhook_events.organization_id` as written by routing on `phone_number_id`, or `platform/unrouted` (section 10.3) |
| Treatment         | Stub / empty body / exception (with exception id) / platform decision required                                     |
| Matching evidence | Which namespace matcher identified the subject in it (ids only, no payload text)                                   |

Restore matches these rows by id first and by exact evidence second. Re-hashing arbitrary restored payload text is **not** the
mechanism; it may be used only to raise `REVIEW_REQUIRED`.

### 4.4 Restore-time matching rules

| Restored row                                               | Action                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Contact id in `approved_contact_ids`                       | Apply the decision                                                             |
| Contact id in `excluded_candidate_ids`                     | **Never touched**                                                              |
| Contact found only by a matcher, id in neither list        | `REVIEW_REQUIRED`; environment stays closed until a `REVIEW_RESOLVED` artifact |
| Non-derivable row matched by id or exact evidence          | Apply the recorded treatment                                                   |
| Expected target absent from the snapshot                   | "Not present" only if the matchers also find nothing; else `REVIEW_REQUIRED`   |
| Scope cannot be resolved (bundle unavailable, key missing) | Restore rejected or closed (section 7.3)                                       |

## 5. Ledger durability and completeness

### 5.1 Storage options (provisional; no product selected)

| Option                                                       | Independent of DB restore    | Serialized append                      | Notes                                                      |
| ------------------------------------------------------------ | ---------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| A. Table in the application database                         | **No**                       | Yes                                    | **Rejected**: rolled back by the restore it must survive   |
| B. Separate PostgreSQL database                              | Yes, if backups are separate | Yes (sequence under lock)              | Its own backup restore is itself a head rollback (5.5)     |
| C. Object storage with WORM retention and conditional writes | Yes                          | Yes, if the store offers put-if-absent | One object per entry; deletion prevented by retention lock |
| D. Managed append-only ledger service                        | Yes                          | Yes                                    | Product-specific                                           |

**Provisional recommendation:** a **primary** store of type C (or D) plus an **independent witness** store of a different type
or custodian (for example B under a different account, or C in a different account and region). Which products, and whether
the chosen environment provides WORM retention and conditional writes, is **INF-1 and INF-4 (open)**. A stub or mock store in
tests is never evidence of these properties (section 14).

### 5.2 Entry format

`{ organization_id, decision_id, seq, entry_id, prev_hash, type, body, appender_id, appended_at }`, canonical JSON.
`entry_hash = SHA-256(prev_hash ‖ canonical(entry))`. `entry_id` is generated by the client before the first attempt, so a retried
append is recognizable. Each entry is signed by the appending tool's key; approval entries additionally carry the approval
artifact (section 12).

### 5.3 Serialized allocation and forks

- One authoritative sequence for the whole ledger (simplest; per-organization streams are an engineering option EN-S1-1).
- Append of `seq = n` is a **put-if-absent** of object `n` (or an insert under a unique key). A competing appender loses, re-reads
  the head and retries with `n+1` if its entry is still valid.
- A retry with the same `entry_id` that finds its own entry at `n` treats the append as done (lost acknowledgment).
- Fork detection on read: two different entries claiming `seq = n` (possible only if a store lacks conditional writes or is
  restored inconsistently) stops all erasure and restore activity until custodians resolve it.

### 5.4 Durability before database modification

`MANIFEST_APPROVED`, `PLAN_APPROVED`, `PROTECTION_INTENT` and `STEP_INTENT` are **durable** only when the entry is present, with
the same hash, in **both** primary and witness. The tool refuses to act on an intent until it has read it back from both.
Other entries are appended to both as well; a missing witness copy of a non-intent entry is repaired from the primary.

### 5.5 Head freshness, tail loss and rollback

A signed checkpoint proves that entries up to it existed. **It never proves that later entries did not exist.** Before any
restore acceptance and before every resumption:

1. Read the head (`seq`, `entry_hash`) from primary and witness at the time of the check.
2. Require both chains to verify end to end with no gaps and **identical heads**.
3. Require the head to be at or after the latest signed checkpoint held offline (INF-3).

| Failure scenario                                                              | Detection                                                                  | Behaviour                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **FS-L1 Unsigned-tail loss**: primary loses entries after the last checkpoint | Witness head is ahead of the primary                                       | Closed. Re-insert the missing entries verbatim from the witness (hashes and signatures verify); then re-check |
| **FS-L2 Ledger-head rollback**: primary restored from its own older backup    | Witness head ahead; or both heads behind an offline checkpoint             | Closed. Same repair; an older checkpoint is **not** accepted as current                                       |
| FS-L3 Both stores rolled back to the same older head                          | Head behind the latest offline checkpoint or approver-held receipts (12.5) | Closed; owner decision on reconstruction                                                                      |
| FS-L4 Fork at `seq = n`                                                       | Two entries at one sequence                                                | Closed; custodian resolution                                                                                  |
| FS-L5 Witness unreachable                                                     | No identical-head proof                                                    | New intents refused; restore stays closed; normal messaging unaffected                                        |
| FS-L6 Entry altered                                                           | Hash or signature mismatch                                                 | Closed; restore the entry from the other store if it verifies there                                           |

### 5.6 Disaster recovery of the ledger

The two stores are each other's recovery source. Each also has its own backup; restoring either from backup is treated as FS-L2
and merged forward from the other. A periodic DR exercise (infrastructure test, section 14) restores each store in isolation and
proves completeness against the other and the offline checkpoints.

### 5.7 Access

| Principal                      | Access                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application runtime roles      | **None**                                                                                                                                           |
| Approval service (section 12)  | Append approval entries only, each carrying a valid approver signature; never an obligation-creating approval while a cutover fence is held (11.5) |
| Erasure tool (executor)        | Append protection, step and outcome entries; read its organization's entries                                                                       |
| Restore operator               | Read all; append `RESTORE_REAPPLIED`, `REVIEW_REQUIRED`, cutover entries                                                                           |
| Ledger custodians (two people) | Repair from witness, retire matchers, destroy bundle keys, `CUTOVER_ABORTED`                                                                       |
| Anyone                         | No update or delete of an existing entry                                                                                                           |

## 6. Identity matching contract

### 6.1 Matcher recipes

| Recipe        | Namespace                        | Source column                       | Representation                                                               | Status                                                                                            |
| ------------- | -------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `wa-sender/1` | WhatsApp sender id (opaque)      | `contacts.wa_id`                    | **Exact stored string**, UTF-8 bytes, length-prefixed. No normalization      | Supported                                                                                         |
| `wa-bsuid/1`  | Business-scoped user id (opaque) | `contact_bsuids.bsuid`              | Exact stored string                                                          | Supported                                                                                         |
| `tel-e164/1`  | Telephone number                 | `contacts.phone_e164`               | E.164 as stored, validated `^\+[1-9][0-9]{1,14}$`; no other canonicalization | **Defined but inactive**: no writer exists. Activated only when a writer is reviewed              |
| —             | Username, profile name           | `contacts.username`, `profile_name` | —                                                                            | **Not identity**: mutable, replaced from newer events (`resolve.ts:318`). Shown to reviewers only |

A `wa_id` that looks like a phone number is still matched only as `wa-sender` (`identifiers.ts`: no grammar is imposed). Matching
across namespaces (a `wa_id` against a phone) is not performed.

### 6.2 Matcher value

`HMAC-SHA-256(K_org,v, "erasure-match|" ‖ recipe_id ‖ "|" ‖ recipe_version ‖ "|" ‖ organization_id ‖ "|" ‖ len ‖ value)` where
`K_org,v = HKDF(master_v, info = "erasure-match|" ‖ organization_id)`. Each matcher stores `organization_id`, namespace,
`recipe_id`, `recipe_version`, `key_version = v`.

- The per-organization derivation gives **domain separation only**: matchers of two organizations are unrelated without the
  master. Because `K_org,v` can be recomputed from `master_v`, deleting `K_org,v` destroys nothing; only destroying `master_v`
  (or the bundle key, 6.3) does.
- `master_v` is kept while any unretired bundle references version `v`. A new version is used for new decisions after rotation.
  Old matchers are not re-hashed (the plaintext was erased).
- **Historical key unavailable:** matchers of that version cannot be evaluated. The restore acceptance check (7.3) rejects any
  copy whose outstanding obligations depend on them, unless every target of those obligations is resolvable by manifest id and
  exact evidence alone and a reviewer records that; otherwise closed.

### 6.3 Encrypted matching bundle

The matchers, and nothing else identifying, are stored as a **bundle encrypted with a random per-decision data key**. The data
key is wrapped by a key-management key (INF-2). The ledger entry holds the ciphertext hash (and the ciphertext, or a reference
to an immutable object), so entries stay immutable and verifiable. Destroying the per-decision data key (a recorded, two-person
`MATCHER_RETIRED`) makes the bundle unreadable without altering any entry. The random key is not derivable from any other key.

### 6.4 Fence matchers (runtime-evaluable)

The resolver must test an incoming identifier against the identifier fence (8.1) without plaintext and without the ledger master
key, which the application runtime never holds (5.7). Fence matchers therefore use a **separate** per-organization fence key:

`FM = HMAC-SHA-256(F_org,w, "erasure-fence|" ‖ namespace ‖ "|" ‖ organization_id ‖ "|" ‖ len ‖ value)`, with the same exact
byte representation as 6.1 (no normalization; `tel-e164` inactive). `F_org,w` is a random key per organization and version
`w`, held in key management (INF-2) and readable by the inbound worker only. Each fence row stores `namespace`, `FM` and
`fence_key_version = w`.

- A fence matcher identifies nobody without `F_org,w`, but it confirms a guessed identifier to whoever holds the key: it is
  pseudonymous personal data (2.2), kept only until release (8.5).
- The decision's encrypted matching bundle (6.3) also carries its fence matchers, so a restore can rebuild the fence after the
  plaintext is gone.
- Rotating `F_org` re-keys nothing: a new version is used for new fences; the resolver evaluates every version referenced by an
  ACTIVE fence row of the organization. A version is destroyed only when no ACTIVE fence and no unretired bundle references it.

## 7. Restore eligibility and retirement

### 7.1 Restorable-copy registry

A protected registry, kept with the ledger (same durability rules), lists every restorable copy:

| Field               | Content                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `copy_id`, `kind`   | Backup, PITR window, provider snapshot, offline copy, export, DR medium                                            |
| Lineage             | Source database instance, parent copy, provider reference                                                          |
| Coverage            | Point time, or window `[from, to]` for PITR                                                                        |
| Organizations       | Every organization the copy contains (all, for a full backup)                                                      |
| Custodian, location | Who can restore it                                                                                                 |
| Status              | `RESTORABLE`; `DESTROYED` (with evidence); `PERMANENTLY_NON_RESTORABLE` (with evidence, for example key destroyed) |
| Required coverage   | Derived: every obligation whose `VERIFIED` time is after the copy's coverage start                                 |

Copies are registered when created or, for provider-managed backups and PITR, as a standing window whose end moves forward and
whose start is the provider's retention boundary. An export feature does not exist; any future one must register its outputs.

### 7.2 Retirement

- `MATCHER_RETIRED` for a decision is allowed only when every registered copy with coverage starting before its `VERIFIED`
  time is `DESTROYED` or `PERMANENTLY_NON_RESTORABLE`, and the provider's own retention statement excludes unregistered copies
  (OD-S1-12).
- `OBLIGATION_RETIRED` follows under the same condition. The cleartext envelope (decision id, organization, dates, scope codes,
  outcome, approvals) remains immutable for the audit period (OD-P17, L-5). This replaces revision 1's "reduction to an audit
  stub": nothing is edited; the identifying part was always in the destroyable bundle.

### 7.3 Restore acceptance checks

A snapshot is accepted for restoration only if **all** hold; otherwise it is **rejected**:

1. It is registered, `RESTORABLE`, with known lineage. An unregistered or unknown copy is rejected.
2. Ledger freshness passes (5.5).
3. Every obligation in its required coverage has a readable bundle and available key versions, or the 6.2 exception is
   recorded.
4. No obligation for it is retired (a retired obligation means the copy should not exist; its presence is an incident).

## 8. Subject-level protection and coordination

### 8.1 Protection record

Two future, tenant-scoped tables (migration), written together in the transaction committed between `PROTECTION_INTENT` and
`PROTECTION_COMMITTED`, **at manifest approval, before execution**:

- `erasure_subject_protections(organization_id, decision_id, contact_ids[], conversation_ids[], state, created_at)`;
- `erasure_identity_fences(organization_id, decision_id, namespace, fence_matcher, fence_key_version, state, created_at)`, one
  row per identifier of the approved contacts (6.4), unique per (organization, namespace, matcher, decision). No plaintext.

Neither has a **timeout**, and **no erasure step changes either** of them: identifier erasure leaves the fence in place. They are
removed only by the release step (8.5), after `VERIFIED`, under a release artifact, and only as OD-S1-2 allows. A crash, a
failed step or a partial execution therefore never releases anything. After a restore both are rebuilt from the ledger (manifest
ids and the bundle's fence matchers) for every outstanding obligation before any processing (section 11), because the restore
rolls them back.

**Fence content.** The protection transaction takes the sorted `wa-identity` keys of every manifest identifier, then the approved
contacts `FOR UPDATE`, and reads their **current** identifiers. If that set contains an identifier the locks do not cover (an
alias attached after manifest approval by a resolver that committed first), it rolls back and retries with the sorted union of
keys; an alias can only join an approved contact through an event carrying an identifier already locked, so the retry converges
(bounded; on exhaustion the decision waits, and the attempt is recorded). Fencing an identifier that is attached to an approved
contact protects that contact; it does **not** widen the manifest. The final fence set's matchers are in `PROTECTION_COMMITTED`
(encrypted, as 6.3), and no `STEP_INTENT` is accepted before that entry is durable (5.4).

**What a fence hit means.** A hit blocks processing and is recorded for review (`erasure_fence_hits(organization_id,
decision_id, webhook_event_id, namespace, hit_at)`, no plaintext). It never adds a contact, conversation or event to the
decision's scope and never erases anything: a hit on an excluded or uncertain identity stays held until a reviewer resolves it
by a new artifact (`REVIEW_RESOLVED` or `AMENDMENT_APPROVED`), or until release (8.5).

### 8.2 Coordination points

| Path                         | Existing lock (verified)                                                                                | Required check under that lock                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound webhook processing   | Message lock (organization, account, wamid)                                                             | If resolution returns "fenced" or a protected contact: store nothing (no contact, alias, conversation, message, trigger); reschedule the event with `erasure_hold` without consuming its retry budget (reviewed queue operation), so no content row is written                                                                                                  |
| Contact and alias resolution | `wa-identity:{org}:bsuid:…` / `:wa:…` advisory xact locks, sorted, READ COMMITTED                       | **First**, after the locks and before `findAlias`, `findContactByWaId`, any create, link or refill (`resolve.ts:113-120`): compute the event's fence matchers (6.4) and read ACTIVE fence rows of the organization. A hit → return "fenced" and record the hit (8.1). Then, as before, a protected or `erased_at` contact is never updated, refilled or aliased |
| Identifier erasure step      | Takes the **same** sorted `wa-identity` keys of all approved contacts, then those contacts `FOR UPDATE` | In one transaction: NULL identifiers, delete BSUID aliases, set `contacts.erased_at`, insert the receipt. Protection and fence rows are **not** touched; the fence keeps blocking the identifiers after they are gone from `contacts`                                                                                                                           |
| Bot-session starts           | `bot-contact:{org}:{contactId}` try-lock, conversation `FOR UPDATE`                                     | Protected contact or conversation → ignored with `erasure_hold`; no session                                                                                                                                                                                                                                                                                     |
| Live sessions and handovers  | Session `FOR UPDATE`                                                                                    | A live session at protection time is ended by a reviewed transition to HANDED_OVER (`system_handover`, `handover_reason = erasure_hold`), already permitted by the CHECKs; an unresolved handover stays visible to staff, who cannot reply (next row)                                                                                                           |
| Staff message submission     | Conversation `FOR UPDATE` (`submit.ts:110`)                                                             | Protected conversation → refused (409, code `erasure_hold`); no request                                                                                                                                                                                                                                                                                         |
| Outbound dispatcher claim    | Request `FOR UPDATE SKIP LOCKED`, account try-lock                                                      | Protected conversation → QUEUED → HELD with `hold_reason = erasure_hold` (permitted transition). An in-flight SENDING request completes or is recovered to UNKNOWN_OUTCOME as today; execution waits for it                                                                                                                                                     |
| Multiple WhatsApp accounts   | Contacts per organization; one conversation per account                                                 | Protection lists every conversation of the approved contacts across all accounts; the fence is organization-scoped, not account-scoped, so a fenced identifier is held on every account; no contact or conversation is created (resolver row above)                                                                                                             |

Creating the protection takes each listed conversation `FOR UPDATE` in id order, so any in-flight staff submission or bot step on
those conversations either commits first (and is then in scope or deferred) or sees the protection.

### 8.3 Contact after successful erasure (owner decision OD-S1-2)

| Option                                          | Effect                                                                                                                      | Residual                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **A (recommended): new relationship**           | Protection and fence are released after `VERIFIED` (8.5); a later message creates a new, unrelated contact and conversation | None retained; staff see a stranger                      |
| B: suppression                                  | The fence is never released: messages from the erased identifiers are refused or flagged                                    | Retains an identifier derivative indefinitely; needs L-4 |
| C: content-only erasure (no identifier erasure) | Contact remains; new messages join the redacted conversation                                                                | Identifiers retained                                     |

### 8.4 Isolation and locking assumptions

- Every coordination check runs under READ COMMITTED **after** acquiring the lock in the row above, so the read sees any
  protection committed before the lock was granted. Under REPEATABLE READ or SERIALIZABLE the snapshot could predate it; the
  resolver already refuses non-READ-COMMITTED transactions, and the other paths must assert the same (G7-3 production check).
- Erasure steps use the same lock order as the path they coordinate with, to avoid deadlock: identity keys (sorted) → contacts →
  conversations (id order) → sessions → requests. Fence rows are read, never locked, by the resolver; protection creation and
  release write them only while holding the identity keys (creation) or a single statement per decision (release, 8.5), so no
  new lock class enters the order.
- Advisory locks are transaction-scoped and require a real transaction (the resolver checks this); the erasure tool must too.

### 8.5 Release contract

Release is a **step** of the decision under the 3.3 protocol (`STEP_INTENT(release)` → transaction → `PROTECTION_RELEASED`),
permitted only when all hold:

1. `VERIFIED` is durable in both stores, and no later `STEP_INTENT` of the decision is unmatched by a receipt.
2. A release artifact (12.1, `artifact_type = release`) signed by A or P (not E) binds the decision, the `VERIFIED` entry hash,
   the count of `erasure_fence_hits` and the treatment of the held events (below).
3. OD-S1-2 is option A or C (option B never releases the fence).

The release transaction, in one statement per table, sets every protection and fence row of the decision to RELEASED and inserts
the receipt. It is atomic: either every fence of the decision is in force or none is. A resolver that read the fence before the
commit holds its event (correct before release); one that reads after treats the identifier as unknown (correct after release).
Both outcomes are safe at any instant after `VERIFIED`, so no shared lock is needed. Fence rows of other decisions on the same
identifier keep it fenced.

**Held events at release.** Events held with `erasure_hold` arrived after the cut-off and are outside the decision. The release
artifact states their treatment (OD-S1-18, unresolved). Preferred proposal: staff review; if they are processed, they are
captured with automation suppressed (the 11.2a flag, reason `erasure_release`), never answered by a bot automatically.
Alternatively a new erasure decision for them. They are never folded into the released decision.

**Historical replay versus a new relationship.** After release, a redelivered historical message is recognized by its retained
event `idempotency_key` and the inbound wamid lock (`handler.ts:28-34, 91-100`; 2.2 keeps both), not by identity, and creates
nothing. Only an event whose key is unknown creates a new contact. Event-row retention must not delete those keys while Meta can
still redeliver (OD-S1-6). A copy restored after release re-applies the obligation, rebuilds the fence (8.1) and releases it again
in quarantine under the original release artifact, recorded in `RESTORE_REAPPLIED`.

**Limit.** An identifier never attached to an approved contact (for example a BSUID first seen after the fence, arriving alone)
cannot be linked to the subject and is not fenced; that is the identity boundary of the design, not a bypass of it.

## 9. Raw webhook redelivery after erasure

| Case                                                        | Fact                                                                                                  | Rule                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact duplicate redelivery                                  | New raw row, same `payload_sha256`; every event a duplicate; no child                                 | Matched by `payload_sha256` against manifest evidence; body emptied by the platform step                                                                                                                          |
| Reserialized or re-wrapped duplicate (new timestamps)       | Different hash; every event key a duplicate; no child; **not findable** by a cut-off query or by hash | Future migration: at ingest, record the duplicate `idempotency_key`s of a request (`webhook_request_duplicates(request_id, idempotency_key)`). Erasure finds raw rows whose duplicate keys are in its manifest    |
| All-duplicate childless request (any subject)               | Carries no new information; every event exists already                                                | **Recommended minimization:** empty the body at ingest, keep hash, length and duplicate keys (OD-S1-16). Idempotency is unaffected (keys live on the events) and no tenant loses evidence (each has its original) |
| Mixed request: new events plus a duplicate of an erased one | Body needed as evidence for the new events                                                            | Flagged and access-restricted; emptied as soon as its new children are PROCESSED (not after `P-RAW`), subject to section 10                                                                                       |
| Childless non-ACCEPTED request (signature or parse failure) | No trusted attribution                                                                                | Cannot be attributed. **Explicit exception:** removed by age only (OD-P1a); the outcome says so                                                                                                                   |
| Request with events for several tenants                     | Section 10                                                                                            | Section 10                                                                                                                                                                                                        |

Redelivered **events** are rejected by the unique `idempotency_key` (no new row), so no parsed copy reappears; only the raw body
is at issue. Meta's redelivery horizon is unverified (OD-S1-6); the duplicate-key linkage makes it irrelevant for matching.

## 10. Shared and unroutable evidence

### 10.1 Authority

Changes to a shared `webhook_requests` row, or to an event with `organization_id IS NULL`, are **platform-level** operations:
executed by a platform administrator, requested by the tenant's decision, and recorded as a platform entry that references every
organization whose events the request contains.

### 10.2 Eligibility for emptying a shared raw body

All must hold; otherwise the body is kept and A's decision records an exception with expiry:

1. Every child event is PROCESSED (unfinished children wait; they are evidence in progress).
2. No organization with a child in the request has a retention hold or investigation touching that request or event (global hold
   check by request id; the check returns hold existence and owner organization, never another tenant's subject data).
3. For each other organization B with a child, either B's parsed event copy is retained (default) or B's platform contact has
   approved the change (OD-MT-5).
4. A platform approver (not the executor) approves the platform entry.

Conflicting investigation needs (B requires the bytes) win over A's decision; A's outcome states the exception and its expiry.

### 10.3 Attribution

Tenant attribution is taken only from routing: `webhook_events.organization_id` set from the receiving `phone_number_id`. A
person's identifier never establishes ownership. An UNROUTABLE event (organization NULL) is attributable to A only if its
`metadata.phone_number_id` is now registered to an account of A; otherwise it is recorded as `platform/unrouted`: an exception
removed by the platform rule for unroutable events (OD-S1-15).

### 10.4 No global subject registry

Ledger matchers are per organization (6.2); platform entries reference request and event ids, not subjects. A platform
administrator never searches identifiers across organizations.

## 11. Backup restoration and quarantine settlement

### 11.1 Quarantine

Restore into an isolated environment: webhook ingress unreachable from Meta, staff UI not exposed, the three workers stopped,
`WHATSAPP_OUTBOUND_ENABLED`, `BOTS_RUNTIME_ENABLED`, `WHATSAPP_WORKER_ENABLED` off, no scheduler, no outbound network path to
Meta. Settlement runs as reviewed, bounded, organization-scoped operations; no HTTP request is sent.

### 11.2 Settlement of restored unfinished work (only existing permitted transitions)

| Restored state                               | Settlement                                                                                                                                                                                                                                                                                                                                                        | Why                                                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound SENDING                             | → UNKNOWN_OUTCOME (permitted; same as stale-claim recovery)                                                                                                                                                                                                                                                                                                       | It may have reached Meta before or after the snapshot; the uncertainty is preserved                                                                                         |
| Outbound QUEUED                              | → HELD, `hold_reason = restore_quarantine` (permitted)                                                                                                                                                                                                                                                                                                            | Production may have sent it after the snapshot; a resend must be an explicit new staff action (OD-S1-17)                                                                    |
| UNKNOWN_OUTCOME, HELD, terminal              | Unchanged                                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                                             |
| Live bot session                             | → HANDED_OVER, `end_reason = system_handover`, `handover_reason = restore_quarantine` via a reviewed function                                                                                                                                                                                                                                                     | No bot continues on stale state; staff see a handover; the guard stamps `ended_at`                                                                                          |
| Bot trigger PENDING (claimed or not)         | → IGNORED, `outcome_code = restore_quarantine`, by the existing `endConversationTriggersSql` operation per conversation (no guard on `bot_triggers`; CHECKs permit it); then assert zero PENDING triggers remain. The inbound message row is untouched                                                                                                            | A fresh trigger (< 10 minutes, `policy.ts:25`) may already have been answered in the lost timeline; age expiry is not a guarantee. The message stays in the Inbox for staff |
| Webhook events PENDING / FAILED / PROCESSING | Events of outstanding obligations (by manifest id or matched contact) → payload stubbed and status DEAD with `last_error = erasure_suppressed` via a reviewed function (DEAD has no replay). Others left for processing after resumption: they are recorded as inherited (11.2a), so their messages are captured for the Inbox but cannot start or continue a bot | Processing them would re-create erased content; others are legitimate lost-work recovery                                                                                    |

### 11.2a Restore boundary for bot inputs (revision 3a: database provenance)

Settling restored triggers is not enough: a restored PENDING webhook event, or Meta redelivering a message the lost timeline had
already answered, would create a **new** trigger after resumption, and that trigger may be fresh.

**Why provider time cannot decide this.** `messages.occurred_at` and the payload timestamp are what Meta sent, unchanged
(`message-map.ts:88, 431`); only the derived activity time is capped (`time.ts:5-10`). A restored event can carry a provider
time after the boundary (a future-skewed stamp), so a provider-time rule would let it start a bot. Example (ER-47A): received at
T0 with provider time T0+20 min; snapshot holds it PENDING; the lost timeline answered it at T0+6; restore at T0+8. Its trigger
would get `input_occurred_at` = T0+5 (capped) and is fresh at T0+8; its provider time is after the boundary. Provider time is
therefore used only to **suppress** automation, never to permit it.

**Trusted provenance: complete snapshot membership (revision 3b).** Revision 3a recorded only PENDING, FAILED and PROCESSING
events after settlement. That was incomplete: held events return to PENDING later through the existing release paths
(`queue/requeue.ts`): `requeueOnAccountActivation` releases routed `UNROUTABLE`/`account_pending` events on activation
(`operator/accounts.ts:309`), and the operator CLI releases `IGNORED` (`account_disabled`, `account_archived`) and unrouted
`UNROUTABLE` events (`operator/events.ts:157, 240`). Each release rewrites `status`, `attempts`, `last_error` and the lease
(`requeue.ts` `released`) and nothing else. The rule is therefore:

**Every `webhook_events` row present in the restored snapshot is inherited historical work, whatever its status, now or later.**

- **When.** Immediately after the restored database is reachable in quarantine (ingress, webhook workers, outbound dispatch and
  bots off, 11.1) and **before any write**: before settlement, obligation application, age retention or any event-status change
  (11.3 step 2).
- **How.** One transaction inserts `restore_epochs(epoch_id, restore_id UNIQUE, copy_id, bot_input_boundary_at,
inherited_count, created_at)` and `restore_inherited_events(epoch_id, webhook_event_id)` with
  `INSERT … SELECT id FROM webhook_events` and **no status predicate**, then checks inside the same transaction that the inserted
  count equals `count(*)` of `webhook_events` and stores it as `inherited_count`. `bot_input_boundary_at` is that transaction's
  database clock. Nothing else writes `webhook_events` while ingress and workers are off, so the set is the snapshot's set.
- **Coverage.** The seven statuses of `WEBHOOK_EVENT_STATUSES` (`db/schema/enums.ts:6-14`): PENDING, PROCESSING, PROCESSED,
  FAILED, DEAD, UNROUTABLE, IGNORED. A status added later is covered because there is no predicate; a reviewed test pins the
  absence of one (ER-47C).
- **Identity, not time.** Membership keys on `webhook_events.id`, generated by the database (`pk()`), never on a Meta
  timestamp, idempotency key or `received_at`.
- **Durability.** Both tables are new migrations with an insert-only guard (no UPDATE or DELETE, modelled on the existing
  append-only triggers). `restore_inherited_events` has **no foreign key** to `webhook_events`: status changes, requeue,
  re-routing by `requeueUnroutedEvent` and event-row retention never touch it, and an inherited id is never reused (UUID). The
  rows are in the restored database and so in every later backup.
- **No release path removes it.** Activation, operator requeue and recovery change only `webhook_events` columns; membership is a
  separate, guarded table that none of them writes. The handler consults it at every claim, so an event inherited once stays
  inherited through any number of status changes (UNROUTABLE → PENDING → FAILED → PENDING → PROCESSED).
- **New events are never members.** An event ingested after ingress reopens gets a new id that was not in the `SELECT`;
  membership is only ever written in that one quarantine transaction per `restore_id`.
- **Repeated or interrupted restoration.** The capture transaction commits entirely or not at all; 11.3 refuses every later step
  for a `restore_id` until its epoch row exists. Re-running the step on the same quarantined database is a no-op (unique
  `restore_id`, and no new events can exist). Restoring a newer copy brings earlier epochs' rows with it and adds a new epoch
  whose set is again every event in that copy; restoring an older copy loses later epochs' rows but its own epoch again covers
  every event it contains. Events that exist in neither the copy nor its epochs are new to this timeline and fall under the
  uncertain-event rule below. The effective boundary for the step check is the latest epoch's.

**What counts as historical.** An event is inherited exactly when it has a `restore_inherited_events` row. This holds whatever its
provider timestamp (future, past or wrong), whether or not its message was captured and whether or not it would produce a
trigger.

**Capture is separated from automation.** The handler already performs capture (contact, conversation, message, activity,
attribution) and then calls the optional `captureBotTrigger` hook in a nested savepoint (`handler.ts:188-199`;
`worker/registry.ts:21-25`); the hook exists only when `BOTS_RUNTIME_ENABLED` is on (`bot-runtime/config.ts:27`). The smallest
change is one per-event flag, not a second pipeline. **Implemented today:** none of the rows below except "Inbound capture" and
"Event completion"; the rest is design.

| Stage                                    | Protection                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Webhook claim (`webhook-queue.ts:38-80`) | The claim statement also returns `automation_allowed`, false when the event is inherited or uncertain (below). Claim, lease, retry and requeue rules are unchanged; the flag is recomputed at every claim from the guarded table, so no release resets it          |
| Inbound capture (`handler.ts`)           | Unchanged (implemented): the wamid lock and `findMessageId` keep one message per wamid; a message already captured in the snapshot is a duplicate and nothing is written; an uncaptured historical message is captured once                                        |
| Trigger admission                        | When `automation_allowed` is false the handler does **not** call `captureBotTrigger`; it records `bot_automation_suppressions(organization_id, message_id, webhook_event_id, epoch_id, reason)` in the same savepoint (unique per message, so retries add nothing) |
| Event completion                         | PROCESSED only when capture committed, as today (implemented). Suppression never completes an event; a failed capture is retried by the normal rules and stays suppressed. An event that fails permanently is DEAD with its reason code, as today                  |
| Trigger execution (bot step)             | A trigger whose `enqueued_at` (database `clock_timestamp()`, `bot-trigger.ts:61-64`) is before the latest boundary, or before the automation resumption (OD-S1-19), is finished IGNORED `restore_boundary` before any session start, input consumption or enqueue  |
| BOT outbound authorization               | `bot_request_hold_code()`, the final pre-HTTP check (`messaging/bot-authorization.ts`), holds a BOT request whose session started from such a trigger (HELD `restore_boundary`). Restored QUEUED requests are already HELD                                         |

No trigger, session or BOT request can come from an inherited event, because the only trigger writer is the handler hook
(`insertBotTriggerIfAdmitted` has one caller, `worker/registry.ts:25`) and the only BOT request writer is the bot step. Staff see
a suppression as a plain Inbox indication that no automatic reply was sent and follow-up may be needed; codes, epochs and event
ids are not shown to ordinary users (S9 UI, not designed here).

**Invalid timestamps (actual behaviour).** An event whose message has no usable timestamp is rejected by the mapper with
`PermanentWebhookError("invalid_timestamp")` (`message-map.ts:98-100, 431-432`) and ends DEAD with `last_error =
invalid_timestamp` (`process.ts:150`). No timestamp is fabricated, no message is captured and no Inbox entry is reconstructed;
the event and raw body remain for audit until their retention. Recovering such content into the Inbox would be a **separate
proposed feature** requiring its own design and approval; it is not part of S1.

**New events that are uncertain.** A Meta redelivery of a message the lost timeline stored is **not** in the snapshot, so it has
no membership row and is indistinguishable by provenance from a genuinely delayed new message. Conservative rule: a
non-inherited event is automation-eligible only if **all** hold, otherwise it is captured with automation suppressed (reason
`restore_uncertain`):

1. its provider time is at or after the boundary (an older one may have been answered in the lost timeline);
2. its provider time is not ahead of its database `received_at` by more than the existing future-skew allowance
   (`FUTURE_SKEW_MS`, `time.ts:5`), the same threshold that already logs `timestamp_future`;
3. it was received after bot automation was explicitly authorized to resume (OD-S1-19). Until then the bot runtime stays off,
   so the trigger hook does not exist and messages are captured for staff only.

Each gate is independent: membership alone suppresses an inherited event even when gates 1–3 would allow it (ER-47B).

A suppressed message is stored and visible to staff, never discarded, and never automatically replayed later: clearing a
suppression is not an operation, and a message captured while automation was off never receives a trigger afterwards. A later
message from the same person that is eligible routes normally under the existing rules; bot-trigger freshness and every other
normal-operation rule are unchanged.

**Limits stated, not hidden.** Gates 1–3 make a duplicate automatic reply depend on a lost-timeline event being redelivered after
automation resumes **and** carrying a provider stamp at or after the boundary yet within the skew allowance of its new receipt.
That residual is bounded by Meta's unverified redelivery horizon (OD-S1-6), not eliminated. Redelivery of an event that **is** in
the restored database is rejected by the unique `idempotency_key` while event rows are retained; after event retention removes
them, duplicate prevention for that event rests on the wamid check only while its message row exists, and on nothing after both
expire.

**Precondition.** The boundary is meaningful only if the lost timeline has stopped: before step 1 of 11.3 the restore records
that the source environment's ingress, workers and outbound path are stopped or unreachable. Two live timelines are refused.

Uncertain deliveries stay uncertain (UNKNOWN_OUTCOME, HELD); nothing in this section re-sends. External sends stay disabled
throughout reconciliation (11.1).

### 11.3 Procedure

1. Accept the copy (7.3), else reject. Record that the source environment is stopped (11.2a).
2. **Before any write**, capture the restore epoch and the complete inherited-event set (11.2a). Every later step refuses to run
   for this `restore_id` until the epoch row exists.
3. Read and verify the ledger (5.5).
4. Rebuild subject protection and identifier fences for every outstanding obligation (8.1).
5. Settle unfinished work (11.2).
6. For every obligation, every organization, in ledger order: plan (if not yet planned, with a new plan approval), apply, verify;
   re-release a fence already released in the original timeline (8.5). `REVIEW_REQUIRED` items block.
7. Run age retention (dry run reviewed, then apply).
8. Unfenced convergence: re-check ledger freshness; apply any decision approved meanwhile (back to step 4). This only shortens
   the fenced interval; it is **not** the cutover guarantee.
9. **Acquire the cutover fence** (11.5). Every obligation-creating approval now either precedes the fence in the chain or is
   invalid.
10. Final reconciliation against the fence: every obligation whose `MANIFEST_APPROVED` or `AMENDMENT_APPROVED` precedes the fence
    entry has protection, fence, application and verification in the destination; apply any missing one (steps 4–6).
11. Second pass: re-application changes zero rows; zero PENDING triggers from the copy; constraints and guards intact (no trigger
    disabled). Receipt-aware: the tool attributes every difference from the plan to its own receipts (for example aliases its own
    identifier-erasure step deleted) and treats any other difference as plan drift, which blocks.
12. Verify the epoch's `inherited_count` against its rows (11.2a). Append `RESTORE_REAPPLIED` per decision and the restoration audit.
13. Two-person sign-off (distinct humans, section 12) as `CUTOVER_SIGNED_OFF`, binding the fence entry, the head hash at sign-off,
    the destination database identity, the boundary and the second-pass result.
14. Enable in stages, each recorded as `CUTOVER_STAGE` before it is switched on: staff UI read-only → ingress → webhook worker →
    outbound dispatcher → staff writes. The bot runtime is **not** a cutover stage: it stays off until an explicit
    authorization under OD-S1-19, recorded as a ledger entry and a `restore_automation_resumptions(epoch_id, resumed_at,
artifact_ref)` row (insert-only). Increment every organization's retention generation.
15. Append `CUTOVER_COMPLETED`, then `CUTOVER_FENCE_RELEASED`. Approvals resume and apply to the now-live database by the normal
    path (protection at approval, section 8).

Any unresolved item keeps the whole environment closed; no tenant resumes before every tenant is reconciled. While closed, Meta
deliveries fail and are retried for an unverified time (OD-P18 trade-off).

### 11.4 ER-RESTORE-1 (future; not executed)

Isolated PostgreSQL and isolated ledger stores only; never `al_ict_whatsapp`. Seed organizations A and B with the same `wa_id`,
sentinel content in every category, a shared raw request and a sibling contact on A's shared phone; snapshot; erase A's subject
(sibling excluded); restore; run 11.3. Assert: no A sentinel survives; the sibling and B are untouched; the shared body follows
10.2; second pass is a no-op; resumption refused before the sign-off of step 13. Variants: **1b** ledger unreachable → closed;
**1c** entry altered or tail truncated → closed; **1d** decision partially executed at snapshot time → fully applied; **1e** new
contact under a new id found only by a matcher → `REVIEW_REQUIRED`, closed until resolved; **1f** snapshot taken between
identifier erasure and `VERIFIED` → fence rebuilt, no new contact on replay (ER-42); **1g** fresh PENDING trigger, PENDING (including future-skewed) and held UNROUTABLE/IGNORED
event in the copy → no automatic reply (ER-46, ER-47A, ER-47C); **1h** approval published during cutover → ER-49.

### 11.5 Approval-publication fence and cutover

**Serialization authority.** The ledger's single global sequence (5.3) orders approval publication against cutover. PostgreSQL
and the ledger are not one transaction, and no database lock or lease is used for this.

**Published and binding.** An obligation-creating approval (`MANIFEST_APPROVED`, `AMENDMENT_APPROVED`) is binding when its
entry is durable in both stores (5.4) **and** the chain prefix it extends holds no unreleased cutover fence. Each entry carries
`prev_hash`, so its appender has read the entry it extends and the fence state is a pure function of that prefix. The approval
service refuses to append while a fence is held (the request stays `REQUEST_RECEIVED`; staff may retry after release). An
obligation-creating approval found after an unreleased fence (a defect or a race the service lost) is **invalid**: executors and
verifiers reject it, and its approvers re-approve after release. Requests, verification and plan approvals for the restore's own
reconciliation remain allowed while fenced.

**Acquisition.** `CUTOVER_FENCE_ACQUIRED(restore_id, destination_id)` is appended (durable in both stores) **before** the final
reconciliation (11.3 step 9). It is refused while another fence is held. The fence entry's sequence number is the reconciliation
boundary: every binding obligation precedes it.

**No lease, no timeout.** A fence ends only by `CUTOVER_FENCE_RELEASED` from the same `restore_id` after `CUTOVER_COMPLETED`,
or by `CUTOVER_ABORTED` from two ledger custodians. An aborted cutover's destination is marked non-resumable; resuming it needs a
new restore with a new fence and a full re-run of 11.3. A stale holder, a lost process or elapsed time never releases the fence
and never enables a service.

| Crash point                                   | State on restart                                                  | Recovery (fail closed)                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After fence acquired, before sign-off         | Fence held; every service off                                     | Resume from 11.3 step 10; approvals stay refused                                                                                                            |
| Fence append acknowledged by one store only   | Divergent stores                                                  | Not durable; repair the witness (5.5) before step 10                                                                                                        |
| After sign-off, before the first stage        | Fence held; `CUTOVER_SIGNED_OFF` present                          | Re-verify: head advanced only by fence-permitted entries; destination identity and second pass unchanged. Otherwise sign-off is void and steps 10–13 repeat |
| During enablement                             | Some `CUTOVER_STAGE` entries; services up to that stage may be on | Re-verify as above, then continue the remaining stages in order; on any failure switch every stage off (the existing kill switches) and stay closed         |
| After every stage, before `CUTOVER_COMPLETED` | Services on; fence held                                           | Verify every stage is on, append `CUTOVER_COMPLETED`, then release. No obligation can have been missed: none could be published                             |
| After `CUTOVER_COMPLETED`, release lost       | Fence held                                                        | Append `CUTOVER_FENCE_RELEASED` (idempotent by entry id)                                                                                                    |
| Two operators, one `restore_id`               | Two appenders                                                     | Put-if-absent (5.3) admits one entry per sequence; each re-reads the chain and continues only from a state it validates                                     |

**After release.** Approvals are published as usual and install protection in the live database at approval (8.1); the restored
environment is the live one, so nothing is lost between release and the next approval.

## 12. Approval provenance and separation of duties

### 12.1 Approval artifact

Canonical JSON, one per approval (`MANIFEST_APPROVED`, `PLAN_APPROVED`, `AMENDMENT_APPROVED`, `REVIEW_RESOLVED`, release (8.5),
restore sign-off `CUTOVER_SIGNED_OFF`):

`{ artifact_type, decision_id, organization_id, approver_user_id, approver_membership_id, role_at_approval, manifest_hash,
plan_hash?, scope, cut_off, approved_at (database clock), identity_verification_ref, verifier_user_id, auth_evidence
{ session_auth_time, step_up_at, credential_id } }`

### 12.2 Authenticity

- The approver **signs the artifact hash with a personal credential bound to that user** (for example a WebAuthn assertion with
  the artifact hash as challenge), after a step-up re-authentication. The private key never leaves the approver's authenticator.
- The approval service checks server-side (ACTIVE `ADMIN` membership in that organization, approver list OD-S1-1, separation
  rules) and appends the artifact with the assertion.
- Credential enrollment is itself a ledger entry, co-approved by a ledger custodian, so an executor cannot register a credential
  for someone else.
- The erasure tool and the restore verifier validate every artifact against the enrolled credential and refuse execution when
  the plan executed differs from `plan_hash`, the manifest from `manifest_hash`, or the signature fails.
- Residual: someone controlling both the approval service deployment and an approver's authenticator could forge; this is the
  boundary of the design.
- Whether the authentication library supports such credentials was not verified; this is an implementation prerequisite
  (EN-S1-3).

### 12.3 Separation-of-duties policy

Roles: **V** verifier, **A** manifest approver, **P** plan approver, **E** executor.

1. Distinctness is by **human**, i.e. by `users.id` **and** by the enrolled person attestation; several memberships of one user
   (in one or several organizations) are one human.
2. Required: A ≠ E, P ≠ E, A ≠ P. V may equal A only if OD-S1-3 permits.
3. Restore sign-off: two humans, neither the restore operator alone.
4. **Single-ADMIN organization:** A is that ADMIN; P is a designated **erasure reviewer** for the organization (a named human
   with a restricted membership or a platform-level reviewer role, OD-S1-4) who is not E. If no second eligible human exists,
   the decision waits (protection stays in force). The rule is never relaxed. In the internal multi-tenant setting, the same
   human may be an organization ADMIN and a platform administrator; that human may then never be E for that decision.
5. Platform-administrator identity (ADR 0022 gap, OD-MT-4) is an implementation prerequisite.

### 12.4 Identity verification evidence

A request from the subject's own WhatsApp conversation is evidence that the requester controls that number now, not that they
wrote the earlier messages (numbers are recycled; families share phones). Staff record the method and an evidence reference,
never the evidence itself. Guardian requests are recorded with the relationship claimed and how it was checked; whether they
are allowed or required is L-3/L-4. An unverifiable request is `REJECTED`. The verification is bound into the artifact through
`identity_verification_ref` and `verifier_user_id`.

### 12.5 Approver receipts

On each approval, the approver receives the entry's `seq` and `entry_hash`. These are an additional, independently held witness
against FS-L3.

## 13. Execution boundaries per category

| Category                         | Location                                                                           | Permitted operation                                             | Preserved                                       | Required change (none authorized)                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Raw webhook bodies               | `webhook_requests.raw_body`                                                        | Empty bytes + marker, under sections 9–10                       | Hash, `received_at`, ingest status, length      | S6 function and marker; duplicate-key table (9). No trigger exists, so only a reviewed function may write |
| Webhook event payloads           | `webhook_events.payload`                                                           | Policy 9.3 stub + marker; DEAD `erasure_suppressed` (11.2)      | Row, key, status, routing columns               | S6 migration; reviewed suppression function                                                               |
| Inbound / outbound content       | `messages.body`, `content`; attachment `filename`, `error`                         | Redact in place + `redacted_at`; outbound never before terminal | id, `wamid`, direction, type, times, references | S8 migration; Inbox previews show a marker                                                                |
| Error text                       | `messages.error_message`, `message_status_events.error_message`                    | Clear                                                           | `error_code`                                    | S7 stops new provider text                                                                                |
| Request payloads                 | `outbound_requests.payload`, `recipient_id`                                        | One-way redaction under OB-1 … OB-7                             | Key, fingerprint, state, times                  | **Refused by `outbound_requests_guard`**; S10 migration; else recorded exception                          |
| Session variables, tokens        | `bot_sessions.variables`, `awaiting*`, `last_consumed_token`                       | Early redaction to the existing shape                           | Every lifecycle column                          | Guard admits redaction only after `bot_session_redaction_after()`; a decision-referenced sanctioned path  |
| Bot lifecycle and events         | `bot_sessions` rows, `bot_session_events`, `bot_triggers`, `bot_deployment_events` | Keep                                                            | All                                             | None (no free text; ordering and 08E evidence)                                                            |
| Contacts and aliases             | `contacts` identifiers, `contact_bsuids`                                           | Identifier erasure atomic with alias deletion (8.2)             | id, organization, seen times                    | `contacts.erased_at`; resolver change                                                                     |
| Consent records                  | `contact_consents.evidence`                                                        | Default exception (L-5), else redact                            | Action, scope, source, times                    | Legal answer                                                                                              |
| Leads and attribution            | `lead_attributions` (`ctwa_clid`, `provider_data`, …), `lead_events`, `leads`      | Redact personal linkage; keep statuses                          | Ids, statuses, order                            | Guard refuses DELETE and changes; reviewed migration                                                      |
| Staff notes                      | `conversation_notes.body` (CHECK 1–4000, non-blank)                                | One-way redaction to a fixed marker satisfying the CHECK        | Row, author, time                               | Own trigger function (below)                                                                              |
| Conversation events, reads, tags | `conversation_events`, `message_reads`, `contact_tags`                             | Keep; tags may be deleted                                       | —                                               | None                                                                                                      |
| Logs                             | Host log store                                                                     | Expiry at `P-LOG` (14 days)                                     | —                                               | Host not chosen; per-subject log erasure not feasible; outcome says so                                    |
| Browser-loaded history           | Staff tabs; `sessionStorage` journal                                               | Retention generation → discard and refetch                      | —                                               | S9; a tab that never polls keeps memory until closed                                                      |
| Backups and exports              | Restorable copies                                                                  | Not edited; registry, re-application, retirement (section 7)    | —                                               | INF-1 … INF-4, OD-P18                                                                                     |

Corrections binding on every row:

- **Guards preserved.** No trigger disable, no `session_replication_role`, no superuser update, no generic mutation function.
  Each guarded change is a reviewed, one-way, whole-row-compared path modelled on `bot_sessions_guard` and
  `redact_expired_bot_sessions`: `outbound_requests` (S10, OB-1 … OB-7), `bot_sessions` early redaction (decision-referenced),
  `lead_attributions`, `lead_events`, `conversation_notes`.
- **Notes versus events.** `conversation_notes` and `conversation_events` share `staff_inbox_append_only()`. A notes redaction
  migration must give notes **their own** trigger function and leave `conversation_events_append_only_trg` bound to the
  unchanged function; regression ER-41 proves events still refuse UPDATE and DELETE.
- **Contacts:** identifier erasure per 8.2 (atomic with alias deletion under the resolver's locks); `contacts.erased_at` migration;
  resolver change mandatory before use.
- **Raw bodies and events:** sections 9 and 10 replace revision 1's shared-records paragraph.
- **Bot sessions, events, control sequences, `conversation_events`:** kept; they hold no free text and carry ordering.
- **Retained hashes:** request fingerprints, idempotency keys and raw-body hashes are content-derived or identifying and are
  **not anonymous** (2.2).

## 14. Acceptance matrix (future; not run)

Test types: **U** unit; **PG** isolated PostgreSQL (disposable harness, never `al_ict_whatsapp`); **BR** browser (synthetic);
**WORM** real object-storage or ledger service with retention lock and conditional writes; **INFRA** infrastructure recovery
exercise. A stub or mock store satisfies only U; durability claims require WORM or INFRA.

| ID                      | Scenario                                                                                                                                                                                                                                                                                                                         | Expected                                                                                                                                                                                                                                                                           | Type                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| ER-1                    | `erasure.*` permissions per role                                                                                                                                                                                                                                                                                                 | VIEWER none; STAFF request only; ADMIN approve; execute platform-only                                                                                                                                                                                                              | U                          |
| ER-2                    | Approver of A names a contact id of B                                                                                                                                                                                                                                                                                            | Not found; nothing recorded for B                                                                                                                                                                                                                                                  | PG                         |
| ER-3                    | Same `wa_id` in A and B; erase in A                                                                                                                                                                                                                                                                                              | B unchanged; matchers differ                                                                                                                                                                                                                                                       | PG + U                     |
| ER-4                    | Phone contact and BSUID-only contact                                                                                                                                                                                                                                                                                             | Both discovered with matcher; none merged; only confirmed approved                                                                                                                                                                                                                 | PG                         |
| ER-5                    | Same human approves manifest and plan                                                                                                                                                                                                                                                                                            | Refused                                                                                                                                                                                                                                                                            | U                          |
| ER-6                    | Plan changes between preview and execution                                                                                                                                                                                                                                                                                       | RE-PLAN; nothing written                                                                                                                                                                                                                                                           | PG                         |
| ER-7                    | Failure injected after a step                                                                                                                                                                                                                                                                                                    | Resume completes; finished rows untouched                                                                                                                                                                                                                                          | PG                         |
| ER-8                    | Erasure run twice                                                                                                                                                                                                                                                                                                                | Zero rows second time                                                                                                                                                                                                                                                              | PG                         |
| ER-9                    | Constraints and guards after execution                                                                                                                                                                                                                                                                                           | All hold; no trigger disabled; guard tests unchanged                                                                                                                                                                                                                               | PG                         |
| ER-10                   | Live session / QUEUED request / PENDING event                                                                                                                                                                                                                                                                                    | Protection and settlement per 8.2; no partial erasure around live work                                                                                                                                                                                                             | PG                         |
| ER-11                   | UNKNOWN_OUTCOME, HELD, consent evidence, hold                                                                                                                                                                                                                                                                                    | Recorded exceptions with expiry                                                                                                                                                                                                                                                    | PG                         |
| ER-12                   | Sentinel in every copy                                                                                                                                                                                                                                                                                                           | All redacted or excepted; keys preserved                                                                                                                                                                                                                                           | PG                         |
| ER-13                   | Late status and redelivery                                                                                                                                                                                                                                                                                                       | Status only; duplicate rejected; raw handled per section 9                                                                                                                                                                                                                         | PG                         |
| ER-14                   | New message after identifier erasure and release (option A)                                                                                                                                                                                                                                                                      | New contact and conversation; erased contact not refilled                                                                                                                                                                                                                          | PG                         |
| ER-15                   | Open staff tab with older pages                                                                                                                                                                                                                                                                                                  | Sentinel gone after next poll                                                                                                                                                                                                                                                      | BR                         |
| ER-16                   | Cross-tenant raw request                                                                                                                                                                                                                                                                                                         | Per 10.2; B's evidence intact                                                                                                                                                                                                                                                      | PG                         |
| ER-17                   | Ledger unreachable at erasure start                                                                                                                                                                                                                                                                                              | Refused; messaging unaffected                                                                                                                                                                                                                                                      | U                          |
| ER-18                   | Altered entry, gap, truncated tail                                                                                                                                                                                                                                                                                               | Detected                                                                                                                                                                                                                                                                           | U                          |
| ER-19                   | Crash after `STEP_INTENT`, before commit; and after commit, before `STEP_COMMITTED`                                                                                                                                                                                                                                              | Re-run (no receipt) / late acknowledgment (receipt)                                                                                                                                                                                                                                | PG + U                     |
| ER-20                   | Restore of a copy older than a `CLOSED` decision                                                                                                                                                                                                                                                                                 | Decision fully re-applied                                                                                                                                                                                                                                                          | PG + INFRA                 |
| ER-21                   | Restore with a decision `MANIFEST_APPROVED` but never planned or executed                                                                                                                                                                                                                                                        | Planned, approved, applied in quarantine, or closed                                                                                                                                                                                                                                | PG                         |
| ER-22                   | Lost acknowledgment on append                                                                                                                                                                                                                                                                                                    | Retry with same `entry_id` is idempotent                                                                                                                                                                                                                                           | U + WORM                   |
| ER-23                   | FS-L1 unwitnessed-tail truncation and FS-L2 head rollback                                                                                                                                                                                                                                                                        | Detected by witness comparison; older checkpoint not accepted; repaired verbatim                                                                                                                                                                                                   | U + WORM                   |
| ER-24                   | Two appenders race for one sequence                                                                                                                                                                                                                                                                                              | One wins; the other re-reads; no fork                                                                                                                                                                                                                                              | WORM                       |
| ER-25                   | Ledger store restored from its own backup                                                                                                                                                                                                                                                                                        | Treated as rollback; merged forward; completeness proven                                                                                                                                                                                                                           | INFRA                      |
| ER-26                   | Opaque `wa_id` (non-numeric, phone-like, maximum length)                                                                                                                                                                                                                                                                         | Matched exactly; no normalization; no cross-namespace match                                                                                                                                                                                                                        | U                          |
| ER-27                   | Restore needing a destroyed master-key version                                                                                                                                                                                                                                                                                   | Rejected unless resolvable by id and exact evidence and reviewed                                                                                                                                                                                                                   | U + PG                     |
| ER-28                   | Shared phone: sibling excluded; after restore a matcher hits the sibling and a new unknown contact                                                                                                                                                                                                                               | Sibling untouched; unknown → `REVIEW_REQUIRED`; closed until resolved                                                                                                                                                                                                              | PG                         |
| ER-29                   | Non-derivable DEAD and UNROUTABLE events and childless raw rows after identifier erasure                                                                                                                                                                                                                                         | Found by manifest id or exact evidence; treated as recorded                                                                                                                                                                                                                        | PG                         |
| ER-30                   | Unregistered or old copy offered for restore                                                                                                                                                                                                                                                                                     | Rejected                                                                                                                                                                                                                                                                           | U + INFRA                  |
| ER-31                   | Matcher retirement while a covering copy is `RESTORABLE`                                                                                                                                                                                                                                                                         | Refused                                                                                                                                                                                                                                                                            | U                          |
| ER-32                   | Bundle key destroyed                                                                                                                                                                                                                                                                                                             | Ledger chain still verifies; bundle unreadable; destruction evidence covers every wrapped copy and key backup, not only the in-memory key                                                                                                                                          | U + WORM + INFRA           |
| ER-33                   | Resolver and identifier erasure concurrently on the same `wa_id`/BSUID                                                                                                                                                                                                                                                           | Serialized by identity keys; no refill; no alias to an erased contact                                                                                                                                                                                                              | PG                         |
| ER-34                   | Protected subject with conversations on two accounts: inbound, bot start, staff send, dispatch                                                                                                                                                                                                                                   | All blocked or held per 8.2 on both accounts; READ COMMITTED asserted                                                                                                                                                                                                              | PG                         |
| ER-35                   | Childless redelivery: exact, re-serialized, re-wrapped                                                                                                                                                                                                                                                                           | Found by hash or duplicate keys; minimized                                                                                                                                                                                                                                         | PG                         |
| ER-36                   | Shared raw request with B's hold                                                                                                                                                                                                                                                                                                 | Body kept; A's exception recorded with expiry                                                                                                                                                                                                                                      | PG                         |
| ER-37                   | Restored QUEUED and SENDING requests                                                                                                                                                                                                                                                                                             | HELD `restore_quarantine` and UNKNOWN_OUTCOME; no HTTP attempt                                                                                                                                                                                                                     | PG                         |
| ER-38                   | Decision approved during restoration, before the cutover fence                                                                                                                                                                                                                                                                   | Applied before the fence is acquired or in the fenced final reconciliation                                                                                                                                                                                                         | PG + U                     |
| ER-39                   | Executor submits a forged or altered artifact                                                                                                                                                                                                                                                                                    | Signature or hash check fails; nothing executes                                                                                                                                                                                                                                    | U                          |
| ER-40                   | Same human with two memberships as A and P; single-ADMIN organization                                                                                                                                                                                                                                                            | Refused; reviewer path required                                                                                                                                                                                                                                                    | U + PG                     |
| ER-41                   | After a notes redaction migration                                                                                                                                                                                                                                                                                                | `conversation_events` still refuses UPDATE and DELETE                                                                                                                                                                                                                              | PG                         |
| ER-42                   | Crash right after identifier erasure, before `VERIFIED`; same `wa_id` arrives on accounts 1 and 2, and with a previously confirmed BSUID plus a new BSUID                                                                                                                                                                        | Zero new contacts, aliases, conversations, messages, triggers, sessions or outbound rows; events held `erasure_hold`; fence hits recorded; manifest unchanged                                                                                                                      | PG                         |
| ER-43                   | Resolver and protection creation race; an alias is attached between manifest approval and protection                                                                                                                                                                                                                             | Protection retries with the union of keys; the alias is fenced; the manifest is unchanged; no deadlock                                                                                                                                                                             | PG                         |
| ER-44                   | Fence hit on an excluded or uncertain contact's identifier                                                                                                                                                                                                                                                                       | Held and referred for review; nothing erased; scope unchanged until a new artifact                                                                                                                                                                                                 | PG                         |
| ER-45                   | Release after `VERIFIED` (option A); then a historical redelivery and a genuinely new message                                                                                                                                                                                                                                    | Release atomic (all fences or none); redelivery creates nothing (known key); new message creates a new unrelated contact; release refused before `VERIFIED` or without the artifact                                                                                                | PG + U                     |
| ER-46                   | Restore a copy with a PENDING trigger under 10 minutes old whose reply the lost timeline sent; resume                                                                                                                                                                                                                            | Trigger IGNORED `restore_quarantine`; zero automatic transport calls; message visible in the Inbox                                                                                                                                                                                 | PG                         |
| ER-47A                  | Future-skewed historical event: received T0 with provider time T0+20 min; snapshot holds it PENDING; the lost timeline answered it at T0+6; restore at T0+8; resume and later authorize automation; also a Meta redelivery of it                                                                                                 | Identified as inherited by `restore_inherited_events`, not by time; message captured once for the Inbox if not already captured; event PROCESSED only after capture; zero triggers, sessions, BOT requests and transport calls; redelivery rejected by `idempotency_key`           | PG                         |
| ER-47B                  | Membership-only mutation: an inherited PENDING event constructed so every other gate permits automation (provider time ≥ boundary and within skew of `received_at`, received after the recorded automation resumption in the test, active deployment, fresh, within caps)                                                        | With membership: captured, suppressed, zero triggers and transport calls. **Mutation:** remove only the membership exclusion → the test must fail because a trigger is admitted and a BOT request is enqueued. Gates 1–3 stay in force in both runs                                | PG (+ U for the predicate) |
| ER-47C                  | Restored historical UNROUTABLE (`account_pending`, and unrouted `unknown_account`) and IGNORED (`account_disabled`) events, released through the real `requeueOnAccountActivation` and the operator `requeueRoutedHeldEvents` / `requeueUnroutedEvent` paths; one event goes UNROUTABLE → PENDING → FAILED → PENDING → PROCESSED | Membership rows unchanged after every transition; capture completes; zero triggers, sessions, BOT requests and transport calls; `inherited_count` equals the snapshot's event count over all seven statuses; a schema test pins that the capture statement has no status predicate | PG                         |
| ER-48                   | Genuine new message after resumption and after automation was explicitly authorized (OD-S1-19)                                                                                                                                                                                                                                   | Not inherited; provider time ≥ boundary and within skew of `received_at`; normal routing; bot may start under existing rules (freshness unchanged)                                                                                                                                 | PG                         |
| ER-49                   | Pause after the final unfenced head check; publish an approval; attempt resumption                                                                                                                                                                                                                                               | Before the fence: reconciled and protected before sign-off. After the fence: approval refused, or rejected as invalid if appended; resumption never proceeds without it                                                                                                            | U + PG + WORM              |
| ER-50                   | Kill the cutover process after acquiring the fence, after sign-off, mid-enablement and before release                                                                                                                                                                                                                            | Every restart fails closed per 11.5; no service enabled without re-verification; fence never times out                                                                                                                                                                             | U + PG + WORM              |
| ER-51                   | Approval after `CUTOVER_FENCE_RELEASED`                                                                                                                                                                                                                                                                                          | Published normally; protection installed in the live database; obligation present at the next restore                                                                                                                                                                              | U + PG                     |
| ER-52                   | Restored PENDING event whose message row already exists in the snapshot                                                                                                                                                                                                                                                          | Duplicate by wamid; nothing written; no trigger; event completes as today                                                                                                                                                                                                          | PG                         |
| ER-53                   | Restored PENDING or FAILED event whose message was never captured; capture fails once, then succeeds                                                                                                                                                                                                                             | Message captured on retry, still suppressed; event not PROCESSED before capture commits; no trigger at any attempt                                                                                                                                                                 | PG                         |
| ER-54                   | Restored event with a missing or unparseable provider timestamp                                                                                                                                                                                                                                                                  | DEAD with `last_error = invalid_timestamp` as today; no fabricated timestamp; no message, Inbox entry, trigger or reply; event, raw body and membership row retained for audit. Reconstruction is out of scope (separate proposed feature)                                         | U + PG                     |
| ER-55                   | Delayed legitimate message after resumption with provider time before the boundary; and one arriving before automation is authorized                                                                                                                                                                                             | Captured, visible to staff as needing follow-up; no automatic reply; never replayed after authorization                                                                                                                                                                            | PG                         |
| ER-56                   | New post-restore event with provider time far ahead of `received_at`                                                                                                                                                                                                                                                             | Suppressed `restore_uncertain`; captured                                                                                                                                                                                                                                           | U + PG                     |
| ER-57                   | Trigger or BOT request reaching the step or the final authorization with a pre-boundary `enqueued_at` (simulated missed admission check)                                                                                                                                                                                         | Trigger IGNORED `restore_boundary`; request HELD `restore_boundary`; zero transport calls                                                                                                                                                                                          | PG                         |
| ER-RESTORE-1 (+1b … 1e) | Section 11.4                                                                                                                                                                                                                                                                                                                     | Section 11.4                                                                                                                                                                                                                                                                       | INFRA (+ PG)               |

## 15. Decision register

### 15.1 Owner product and policy decisions

| ID       | Decision                                                                                | Recommended default                                                                                                                                                                                                                                        | Status                      |
| -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| OD-P17   | Erasure supported; verification method; guardian role; record custodian                 | —                                                                                                                                                                                                                                                          | **OWNER DECISION REQUIRED** |
| OD-S1-1  | Approver list per organization; whether STAFF may open requests                         | ADMINs only approve; STAFF may open                                                                                                                                                                                                                        | **OWNER DECISION REQUIRED** |
| OD-S1-2  | Contact after successful erasure (8.3)                                                  | Option A, new relationship                                                                                                                                                                                                                                 | **OWNER DECISION REQUIRED** |
| OD-S1-3  | Exact separation of duties; may V equal A                                               | V ≠ A where two staff exist                                                                                                                                                                                                                                | **OWNER DECISION REQUIRED** |
| OD-S1-4  | Erasure reviewer for single-ADMIN organizations                                         | Named reviewer, never E                                                                                                                                                                                                                                    | **OWNER DECISION REQUIRED** |
| OD-S1-5  | Requester-facing outcome wording                                                        | States erased, retained, why                                                                                                                                                                                                                               | **OWNER DECISION REQUIRED** |
| OD-S1-10 | Exact approved erasure scope (categories, identifier erasure by default or not)         | All content categories; identifiers per OD-S1-2                                                                                                                                                                                                            | **OWNER DECISION REQUIRED** |
| OD-S1-11 | Shared-identity handling: who confirms candidates; evidence required                    | Approver confirms each; unconfirmed excluded                                                                                                                                                                                                               | **OWNER DECISION REQUIRED** |
| OD-S1-12 | Restore eligibility of backups and exports; acceptance of provider retention statements | Registered copies only                                                                                                                                                                                                                                     | **OWNER DECISION REQUIRED** |
| OD-S1-13 | Live sessions at protection time: end as handover                                       | HANDED_OVER `erasure_hold`                                                                                                                                                                                                                                 | **OWNER DECISION REQUIRED** |
| OD-S1-14 | Ledger and key custodians; recovery authority                                           | Two named custodians                                                                                                                                                                                                                                       | **OWNER DECISION REQUIRED** |
| OD-S1-15 | Unroutable events naming a subject                                                      | Platform exception, removed by age                                                                                                                                                                                                                         | **OWNER DECISION REQUIRED** |
| OD-S1-16 | Childless raw requests: minimize all-duplicate at ingest; non-ACCEPTED by age           | As recommended in 9                                                                                                                                                                                                                                        | **OWNER DECISION REQUIRED** |
| OD-S1-17 | Unknown delivery outcomes and restored QUEUED work during restoration                   | UNKNOWN_OUTCOME / HELD; resend only by explicit staff act                                                                                                                                                                                                  | **OWNER DECISION REQUIRED** |
| OD-MT-5  | Cross-tenant raw evidence and holds (10.2)                                              | Keep while any hold; B's parsed copy retained                                                                                                                                                                                                              | **OWNER DECISION REQUIRED** |
| OD-MT-4  | Platform-administrator identity and support access                                      | Required before S11                                                                                                                                                                                                                                        | **OWNER DECISION REQUIRED** |
| OD-S1-6  | Re-run or monitoring window for redeliveries (now secondary to 9)                       | Not needed if 9 is implemented                                                                                                                                                                                                                             | **OWNER DECISION REQUIRED** |
| OD-S1-18 | Treatment of fence hits and events held `erasure_hold` at release (8.5)                 | Staff review; captured without bot automation; never auto-replayed                                                                                                                                                                                         | **OWNER DECISION REQUIRED** |
| OD-S1-19 | Bot automation after restoration (11.2a gate 3, 11.3 step 14)                           | **Proposal, not approved:** Inbox capture and staff follow-up first; bot runtime off until an explicit owner authorization; suppressed historical events never replayed; residual redelivery risk after deduplication evidence expires accepted in writing | **OWNER DECISION REQUIRED** |

OD-S1-7 … OD-S1-9 are not used.

### 15.2 Engineering design choices (for review)

| ID      | Choice                                                                                                           | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EN-S1-1 | One global ledger sequence versus per-organization streams                                                       | One global sequence                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| EN-S1-2 | Step receipt table in the application database                                                                   | Insert-only table, per step attempt                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| EN-S1-3 | Approver credential type, library support and lifecycle                                                          | Personal authenticator signature; verify support. **Implementation prerequisite**, must specify: authenticated enrollment with independently verifiable custodian approval; revocation and replacement, and how signatures made before revocation are treated; refusal of new approvals by a revoked credential; verification of human separation and authorization evidence during restoration. No shared operator credential; platform permissions separate from tenant `ADMIN` |
| EN-S1-4 | Matching bundle: HMAC matchers inside an encrypted bundle                                                        | Yes (6.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| EN-S1-5 | Duplicate-key table for raw requests                                                                             | Yes (9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| EN-S1-6 | Suppression of restored claimable events for obligations                                                         | DEAD `erasure_suppressed` via reviewed function                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| EN-S1-7 | Identifier fence with a runtime fence key separate from the ledger master                                        | Yes (6.4, 8.1); resolver check before any create or link                                                                                                                                                                                                                                                                                                                                                                                                                          |
| EN-S1-8 | Restore epoch plus inherited-event membership (database provenance), one automation flag in the existing handler | Yes (11.2a, rev. 3a); claim, step and final BOT authorization all check                                                                                                                                                                                                                                                                                                                                                                                                           |
| EN-S1-9 | Cutover fence in the ledger chain rather than a database lock or lease                                           | Yes (11.5); no timeout                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| EN-6    | Keyed-hash scheme (policy 13.2)                                                                                  | Resolved by sections 6.2–6.4                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 15.3 Infrastructure decisions

| ID     | Decision                                                                                | Status   |
| ------ | --------------------------------------------------------------------------------------- | -------- |
| INF-1  | Ledger primary store (WORM retention, conditional writes), account, region              | **OPEN** |
| INF-2  | Key management for master matching keys, fence keys, bundle wrapping keys, signing keys | **OPEN** |
| INF-3  | Location and custody of offline checkpoints                                             | **OPEN** |
| INF-4  | Witness store of a different type or custodian                                          | **OPEN** |
| OD-P18 | Database and backup provider; restore model; delivery loss while closed                 | **OPEN** |

No product is selected in this document.

### 15.4 Questions for qualified Sri Lankan legal advice

L-3 (minors and guardians), L-4 (rights, verification, deadlines; whether suppression option B is lawful), L-5 (records that
must be kept; consent evidence), L-7 (whether erasure must reach backups immediately or by documented re-application), L-9
(controller and processor per organization). OD-P0 and L-1 … L-9 remain open. G7-1, G7-2, G7-5, G7-6, G7-7, G7-8 and SE-2 remain
open. The activation guard's production connection-isolation check remains a pre-activation condition.

## 16. Remaining design issues and verdict

**P1/P2:** none known without a corrected contract. The three closure P2 findings are corrected in sections 8.1, 8.5, 11.2a,
11.3 and 11.5 (S1-F20 … S1-F22), with ER-42 … ER-57 (ER-47A … ER-47C); P2-2 by revisions 3a and 3b. The 11.2a classification predicate needs unit tests,
but ER-46 … ER-57 are only satisfied by isolated PostgreSQL runs of the real handler, queue and step; a mocked database is not
evidence. Implementation remains blocked by: INF-1 to INF-4 and OD-P18 (ledger,
witness, keys, backups); platform-administrator identity (OD-MT-4); the reviewed migrations of section 13, the protection and
fence tables, the fence-hit table, the receipt table, the duplicate-key table, `restore_epochs`, `restore_inherited_events`, `restore_automation_resumptions` and `bot_automation_suppressions`, each with an
insert-only guard; the resolver change, the claim's
`automation_allowed` flag and handler hook, the bot-step and `bot_request_hold_code()` checks; the non-consuming `erasure_hold` queue operation; and the approver-credential lifecycle
(EN-S1-3).

Revision 3b verdict: **S1 P2-2 MEMBERSHIP CONTRACT CORRECTED — READY FOR CLOSURE.** Owner outcome (2026-11-06): **S1 DESIGN
APPROVED — OWNER IMPLEMENTATION DECISIONS PENDING.**

## 17. Approval status (2026-11-06)

| Category                         | Status                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design contracts (sections 3–14) | **APPROVED (design level).** Changes need a new revision and review                                                                                                                       |
| Owner policy choices             | **NOT APPROVED.** Every row of 15.1 stays OWNER DECISION REQUIRED; recommended defaults are not decisions                                                                                 |
| Infrastructure                   | **NOT SELECTED.** INF-1 … INF-4, OD-P18; no provider, account, region or key service chosen                                                                                               |
| Security mechanisms              | **NOT IMPLEMENTED.** Ledger, witness, signed approvals and credential lifecycle (EN-S1-3), fences, membership, suppression, guarded redaction paths, platform-operator identity (OD-MT-4) |
| Tests                            | **NOT RUN.** ER-1 … ER-57 and ER-RESTORE-1 are specifications only                                                                                                                        |
| Legal review                     | **OUTSTANDING.** L-3, L-4, L-5, L-7, L-9, OD-P0; nothing here is a compliance claim                                                                                                       |
| Retention baseline               | Unchanged: the eleven provisional defaults of policy section 19 (not final legal policy)                                                                                                  |
| Production activation            | **NOT AUTHORIZED**                                                                                                                                                                        |

## 18. Staff-facing wording

Recovery and erasure mechanics stay behind the scenes. In daily Inbox work staff see only plain statuses on a conversation or
message, with no codes, hashes, epochs, ledger or database terms:

| Staff sees                   | Shown when                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Needs Review**             | A message is held for erasure review (8.1 fence hit, 8.5 held events), visible only to the approvers' role |
| **Automatic Reply Not Sent** | Automation was suppressed for a captured message (11.2a); staff may reply by hand                          |
| **Resolved**                 | A reviewer or staff member has handled it                                                                  |

No new dashboard or configuration screen is proposed. Operator and approver tooling (approvals, restores, ledger) is separate
from the staff Inbox and is designed with its checkpoint (section 19).

## 19. Implementation checkpoints (proposed; none authorized)

Each checkpoint is a separate reviewed change with its own tests on isolated PostgreSQL (never `al_ict_whatsapp`), merged only
after its acceptance conditions hold. Internal organization provisioning (ADR 0022) is a separate track and is not part of this
one. Order follows dependencies, not the order of this document.

| #   | Checkpoint                                                    | Prerequisites                                                                            | Essential tests                                                              | Accepted when                                                                                                               |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| C1  | Platform-operator identity and authorization                  | OD-MT-4; EN-S1-3 credential choice                                                       | ER-1, ER-5, ER-40 (separation parts)                                         | Operator actions need an authenticated, audited platform identity separate from tenant `ADMIN`; CLIs refuse without one     |
| C2  | Restoration event provenance and automation suppression       | OD-S1-17, OD-S1-19                                                                       | ER-46, ER-47A … ER-47C, ER-48, ER-52 … ER-57                                 | Membership, claim flag, handler hook skip, step and final-send checks pass on PG; mutation test of ER-47B fails as required |
| C3  | Tenant-scoped subject protection and resolver fencing         | C1; OD-S1-2, OD-S1-11, OD-S1-13, OD-S1-18; a test fence key (production key needs INF-2) | ER-10, ER-33, ER-34, ER-42 … ER-45, ER-14                                    | Protection and fences block every path of 8.2 on two accounts; no deadlock; release atomic; no erasure step exists yet      |
| C4  | Durable ledger, witness and key infrastructure                | INF-1 … INF-4, OD-S1-14                                                                  | ER-17, ER-18, ER-22 … ER-25, ER-32                                           | Real WORM/conditional-write and witness evidence; DR exercise passed; stubs count only as unit tests                        |
| C5  | Erasure approval and decision evidence                        | C1, C4; OD-P17, OD-S1-1, OD-S1-3, OD-S1-4, OD-S1-10                                      | ER-2 … ER-6, ER-19, ER-21, ER-39, ER-40                                      | Signed, scope-bound artifacts verified; separation by human enforced; protection installed at approval                      |
| C6  | Narrowly guarded redaction migrations, one category at a time | C5; section 13 per category; legal answer where noted                                    | ER-7 … ER-9, ER-11 … ER-13, ER-16, ER-29, ER-35, ER-36, ER-41                | Each guard stays whole-row compared and one-way; no trigger disabled; events table still append-only                        |
| C7  | Backup restoration verification                               | C2, C4, C6; OD-P18, OD-S1-12                                                             | ER-20, ER-27, ER-28, ER-30, ER-31, ER-37, ER-38, ER-49 … ER-51, ER-RESTORE-1 | Full quarantine procedure and cutover fence exercised end to end on isolated infrastructure                                 |
| C8  | Retention scheduling and monitoring                           | C6; scheduler host; policy section 19 clocks                                             | Policy-document retention tests (S-stages)                                   | Dry run reviewed before apply; run records and failure alerts; no category without its guarded path                         |

C2 moves ahead of erasure because it protects any restore, with or without an erasure decision, and depends on no ledger. C3's
tables and resolver check can be built and tested before the ledger; installing protection from real approvals waits for C5.
