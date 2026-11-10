# Phase 08G-7B C1A — implementation notes (for review)

Status: **IMPLEMENTED, UNCOMMITTED, PENDING INDEPENDENT CLOSURE REVIEW.** Companion to the
[C1 plan](PHASE_08G-7B_C1_PLATFORM_OPERATOR_PLAN.md) (unchanged). Records what the code guarantees, where it deviates from
the plan, and what it does not protect. Production activation: **NOT AUTHORIZED.**

## 1. Credential state, password proofs and the per-user coordination contract (review P1, final review P1/P2)

The authoritative description is the [ADR 0012 amendment](adr/0012-authentication-and-authorization.md) ("Amendment:
credential state binding"). Summary:

| Rule                    | Guarantee                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordination point      | The `users` row. Grant, tenant reset, provisioning resume and own change hold it `FOR UPDATE` while they decide and write; a session insert takes it `FOR KEY SHARE`; the credential-generation trigger takes it `FOR UPDATE`. C1A application credential writes lock `users` before account/security rows; the legacy AFTER-trigger writer can already hold the account row                        |
| Credential generation   | `user_security_state.credential_generation`, incremented by a database trigger on every change of a stored password (any writer, own changes included). Never caller-supplied                                                                                                                                                                                                                       |
| Session issuance        | Only `/sign-in/email`. The session-create hook re-verifies the submitted password against the canonical credential and stamps the generation and database time it read; a `sessions` trigger refuses the insert if the generation moved (compare-and-swap at the insert itself)                                                                                                                     |
| Credential writes       | Tenant reset, provisioning resume and own change verify (own change, including rejecting reuse via the real NFKC-aware verifier) and write inside one transaction under the locks; hashes from Better Auth's `hashPassword`; only the canonical row (`provider_id = 'credential'`, `account_id = user_id`). Better Auth's public `/change-password` is closed                                       |
| Grant preconditions     | Under the user row lock: target is not the actor; `password_change_required` is false; no provisioning intent names the target                                                                                                                                                                                                                                                                      |
| Provisioning provenance | Before signup, the original requester is checked; the unbound intent row is held locked through signup and binding. An intent authorizes replacement only if it was bound (compare-and-set) to the identity this workflow's own sign-up created, and only for the membership that created it; checked again under the intent lock. Unbound intents next to existing identities go to `auth:intents` |
| Platform session        | One admission statement checks session existence, user binding, expiry, current generation, forced-change state and ACTIVE roles; permissions/scope use those roles. Freshness is measured from `credential_verified_at`                                                                                                                                                                            |
| Interruption            | Reset and own change: one transaction, nothing to recover. Provisioning: the bound intent stays (grants refused); the same administrator's retry completes it                                                                                                                                                                                                                                       |

Residual (inherent): an administrator who controls a staff account **before** any grant (by resetting it and performing the
forced change themselves) is indistinguishable from the person. The out-of-band identity verification behind
`verificationRef`, and later MFA (OD-C1-2), are the controls; once a role is ACTIVE no tenant path can replace the password.

The independent sign-in fences are now covered separately:

- `C1A-CORR-PREHOOK`: a test-local Better Auth verifier calls the installed verifier and parks on a PostgreSQL advisory
  barrier after success, before the real custom session hook. Owner replacement and platform enrollment commit before
  release. The hook re-verifies the old password against the new canonical hash and refuses it: no cookie, no session row,
  no platform access. Disabling only hook re-verification must fail this test with migration 0010's insert guard intact.
- `C1A-P1-F`: the existing database trigger barrier parks **after both verifications**, before the insert guard. It proves the
  generation fence against a replacement after the hook's snapshot. It does not independently prove hook re-verification.
  The insert guard cannot protect against an old proof stamped with the new generation if hook verification is skipped.
- `C1A-CORR-READ`: after-result database barriers exercise both audit and operator-list admission, with READ COMMITTED
  statements. The former split query implementation returns 200 after owner replacement/enrollment; atomic admission denies
  without records. A before-statement barrier verifies denial after committed role revocation and session deletion. A read
  admitted before revocation may complete using its already admitted roles; it cannot inherit later roles or broaden scope.
- `C1A-CORR-REUSE`: real verifier checks exact and fullwidth-character NFKC equivalence; rejected changes preserve hash,
  generation, sessions and flag, still prohibit enrollment, and a distinct-password retry succeeds.
- `C1A-CORR-INTENT`: the second administrator creates no user/credential/membership and leaves the unbound intent unchanged;
  the original requester completes it. Existing bound-interruption and unrelated-identity overlap tests remain.

Legacy caller correction: the sole production `replaceCredentialPassword` caller is `bootstrapFirstAdmin` interrupted
recovery (`auth:bootstrap-admin`, `access/operator.ts`). `auth:intents` recovery attaches an eligible identity with forced
change; it does not reset its credential. The reset-token writer can hold the account row before migration 0010's AFTER
trigger acquires `users`; this is not a universal user-first lock order. A competing C1A writer can deadlock with it (one
transaction is aborted). Legacy privileged CLI migration/credential withdrawal remains deferred.

## 2. Re-authentication (review P2)

- Freshness is measured from `sessions.credential_verified_at`: the database clock read by the session-create hook in the
  statement immediately before it re-verified the password. It is written only by that hook (`input: false`), checked by the
  `sessions` trigger (not in the future, not older than one minute) and immutable afterwards. `created_at` is also stamped by
  the database at insert and immutable.
- Every platform mutation checks, on `clock_timestamp()`: session exists, unexpired, bound to the current credential
  generation, verification time not in the future and within 10 minutes. Once early (no target information for a stale
  session) and once **last**, after every lock and immediately before the write, with the session row `FOR SHARE`. What can
  still wait after that check: foreign-key key-share locks on `users` rows and the revocation's session delete, against
  other short transactions (a tenant reset that locks a user row and refuses, a session refresh). None waits on anything
  external, so the gap is bounded by ordinary statement time; it is not zero.

## 3. Refusal audit throttle (review P2)

DENIED/FAILED rows for a human are written at most once per (actor, action, outcome) per 60 s, claimed through the mutable
`platform_audit_throttle` upsert in the same short transaction as the audit insert. Concurrent requests and several app
instances serialize on that key row only (no global lock). Every refusal is still a structured security log line.
SUCCEEDED rows are not throttled and stay in the mutation's transaction.

## 4. Audit pagination (review P3)

`GET /api/platform/audit?limit=&before=<event id>`: keyset on `(occurred_at, id)` descending, page size 1–200, the cursor's
position read from the database (exact for equal timestamps); in the own-only scope a cursor naming another actor's row
returns an empty page.

## 5. Actual protection level of the platform tables

| Who                                                    | Can they change grants or audit rows?                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Application code paths                                 | No: grants insert ACTIVE and change only to REVOKED; audit is insert-only; both enforced by triggers                                                                                                                                                                     |
| The runtime database role (today: the table **owner**) | **Yes.** It can `TRUNCATE` (row triggers do not fire), `ALTER TABLE … DISABLE TRIGGER`, or write with `session_replication_role = replica`. No TRUNCATE trigger was added: the existing test harness resets with `TRUNCATE … CASCADE`, and an owner could drop it anyway |
| Migration owner / any privileged SQL                   | Yes, by definition (C1-G3)                                                                                                                                                                                                                                               |

Append-only integrity and the single-use bootstrap therefore hold **under the application authorization model only**.
Required before production (C1B / OD-C1-4 / OD-P18): a runtime role that does not own these tables and holds only
`INSERT, SELECT` on `platform_audit_events`, `INSERT, SELECT, UPDATE(status, revoked_by_user_id, revoked_at)` on
`platform_operator_roles`, no `TRUNCATE`; the owner credential withdrawn from operator environments; audit export to an
append-only store (C4).

## 6. Other deviations from the plan

- Bootstrap grants `PLATFORM_SECURITY_ADMIN` only (unchanged policy). With no self-grant, one person can hold
  `PLATFORM_OPERATOR` only after a second security admin grants it. A dual-role bootstrap is an owner choice, not implemented.
- Single use is a partial unique index on `grant_kind = 'BOOTSTRAP'` instead of a `platform_bootstrap` table.
- Not built (no C1A use): `EMERGENCY` grant kind; dry-run/apply; audit columns `dry_run`, `details`, `reconstructed`,
  `target_whatsapp_account_id`. Security-audit retention stays open (OD-C1-5).

## 7. Separate test-reliability issue: `src/modules/bot-worker/process.test.ts` (not part of C1A)

- **Symptom:** under the full parallel unit run, one of "a clean close: exit 0", "pool close rejects: exit 1" or "pool close
  never settles" fails. The child logs a clean `bots.worker_stopped` and yet the process exits **143** (128 + SIGTERM).
- **Measured (same location, same command, 2026-11-10):** clean `HEAD` copy 0 failures in 15 runs; C1A tree 2–5 in 10.
  Passing alone every time. C1A changes no bot-worker code; the child's only C1A-touched import is the `@/db` schema barrel.
  Why the rate differs is not explained.
- **Mechanism:** the test spawns the `tsx` CLI, which relays SIGTERM to its Node child and waits about **30 ms** for the
  child to acknowledge; if the child's event loop is busy it SIGKILLs the child and exits `128 + 15`
  (`node_modules/tsx/dist/cli.mjs`, `relaySignalToChild` / `waitForSignalFromChild`).
- **Not only a harness issue:** `npm run bots:worker`, `whatsapp:worker` and `whatsapp:outbound-worker` also start through
  the `tsx` CLI, so a production SIGTERM under load could bypass the worker's graceful shutdown the same way. Needs its own
  evidence and authorization (for example running the compiled worker or `node --import tsx` directly); no bot-worker code
  or test assertion was changed here.

## 8. Correction verification (2026-11-10; developer evidence)

- Preflight: `Bot-Foundation`, HEAD and local `origin/Bot-Foundation` both
  `ca8470c89bd03eb6cdd2691344ceffe070189542`; initially 30 modified tracked / 17 untracked files, nothing staged.
- Focused unit/safety checks: 40 passed. Focused platform/auth/password/staff PostgreSQL run: 168 passed (before adding
  the additional revocation/re-enrollment scope case). Final correction-only run: 7 passed. Full PostgreSQL run:
  **2,582 passed / 7 skipped**, 128 files passed / 1 skipped, including **78/78 C1A cases**.
- Regression baseline: exact reuse returned 200; both old platform-read implementations returned 200 after the barrier;
  the unbound second-requester attempt reached the late application failure instead of early refusal.
- Pre-hook mutation check: removed only the hook's `verifyPassword` condition, retained its generation/time stamp and the
  unchanged migration 0010 insert guard. `C1A-CORR-PREHOOK` failed because stale sign-in returned **200**. Restored the hook
  byte-for-byte and reran the correction regressions successfully.
- Full unit suite with local socket access: **2,880 passed / 1 failed**. A reduced-contention `--maxWorkers=2` rerun had
  the same counts. Both failures were the separate bot-worker process case “pool close never settles” (exit 143 instead
  of 1); that file alone passed **5/5**. No worker source, launcher or assertions changed. The initial restricted run also
  encountered local-socket/child-process harness failures and is not a passing verification run.
- Lint, TypeScript, repository formatting, `drizzle-kit check` and `git diff --check` passed. Migrations 0000–0009 SQL and
  snapshots remain byte-identical to HEAD; journal prefix preserved; 0010 snapshot links to 0009 and SQL hash remains
  `2e52f127e20de6a5e27a53af839b0e67325224be04ed9e7678dda5a322fa2f27` (the existing pin).
- Every database invocation passed the actual-driver target check and a fresh harness create/migrate/drop probe:
  `al-ict-phase08c-test-pg`, image `postgres:17`, only `127.0.0.1:55432`, maintenance database `postgres`, server version
  `170011`. `TEST_DATABASE_ADMIN_URL` was constructed in memory from that container; `DATABASE_URL` was unset at entry
  (real route fixtures set it only to their fresh harness database). Each run preserved the same seven existing scratch
  databases. No permanent database connection, forced cleanup or unrelated-session termination was performed.
- No remaining confirmed C1A security blocker in these checks. Independent final verification is still required; these are
  developer tests, not owner-commit approval. MFA, runtime database privilege separation, legacy privileged CLI migration
  and credential withdrawal, trustworthy rate limiting, emergency access, audit retention, worker shutdown and the
  committed-password-change sign-in notice remain separate gates. C1B retains its CLI authentication and owner-policy
  prerequisites. No staging, commit, push, production bootstrap, deployment, external send or activation was performed.
