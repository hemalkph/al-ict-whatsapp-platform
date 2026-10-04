# Runbook: authentication operations

Operator-only procedures. None of these is reachable from the web application: the commands run on a trusted
machine against the target database, with the application's environment.

## Environment

Required for both commands (read from the process environment, or from `.env.local` which the npm scripts load if present):
`DATABASE_URL`, `BETTER_AUTH_SECRET` (at least 32 random characters), `BETTER_AUTH_URL` (https in production).
Never put real values in Git. Generate the secret with e.g. `openssl rand -base64 48`.

## First administrator: `npm run auth:bootstrap-admin`

```
npm run auth:bootstrap-admin -- --org-name "A/L ICT Class" --org-slug al-ict-class --email admin@example.com --name "Admin"
```

- The password is **never** a command-line argument (passing `--password` is an error). It is read from a hidden
  interactive prompt (typed twice). For non-interactive automation or testing only, set the one-shot environment variable
  `BOOTSTRAP_ADMIN_PASSWORD` for that single invocation and unset it afterwards. The command never prints or stores it.
- It refuses to run unless the system is pristine: **any** existing user, or any existing organization that is not
  this same incomplete bootstrap, makes it stop. After a successful run a second run is refused, so it cannot become a
  backdoor and there is no flag to "disable" afterwards.
- It creates the organization, the admin user (through the private provisioning instance), `user_security_state` with
  `password_change_required = true`, and an ACTIVE ADMIN membership. The admin must change the password at first sign-in.
- If it stops half-way (for example after the organization and the user were created but before the membership), the
  organization has **no usable admin** (sign-in is refused). Re-run **the same command** (same slug and email): it
  resumes, and the password you type this time becomes the effective one.

## Stale provisioning intents: `npm run auth:intents`

`staff_provisioning_intents` rows coordinate staff creation. A row that outlives its workflow (a crash) is **never
expired automatically**: releasing one blindly could let another organization claim a partially created identity.

```
npm run auth:intents -- list
npm run auth:intents -- inspect <intent-id>
npm run auth:intents -- resume <intent-id> --role ADMIN|STAFF|VIEWER
npm run auth:intents -- remove <intent-id> [--min-age-minutes 10]
```

`list`/`inspect` are read-only and show identifiers and a classification (no credentials, hashes or tokens):

| Classification                   | Meaning                                                                                                                | Allowed action                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `NO_AUTH_USER`                   | No auth user exists for the email; nothing can be claimed                                                              | `remove` (only if older than the minimum age; re-running createStaff/bootstrap also works) |
| `RECOVERABLE_UNPROVISIONED_USER` | An auth user created after the intent has no membership anywhere: the same workflow crashed before the membership step | `resume` with an explicit role                                                             |
| `UNSAFE_USER_HAS_MEMBERSHIP`     | The identity already has a membership somewhere                                                                        | none: operator review                                                                      |
| `UNSAFE_USER_PREDATES_INTENT`    | The auth user existed before the intent (beyond a 5 s clock-skew tolerance)                                            | none: operator review                                                                      |
| `UNSAFE_INTENT_USER_MISMATCH`    | The intent is bound to a different auth user than the one holding the email                                            | none: operator review                                                                      |

- `resume` always creates the membership in **the intent's own organization**, forces a password change
  (`password_change_required = true`), keeps the user's existing credential password (the original administrator knows
  it; an administrator of that organization can reset it afterwards, see staff management), and deletes the intent last,
  all in one transaction.
- `remove` is refused for every classification except `NO_AUTH_USER`, and for intents younger than the minimum age
  because the owning process may still be running.
- The created_at comparison uses the application clock (user) and the database clock (intent); keep both hosts
  NTP-synchronized. It is a tripwire, not the primary guard (the intent, zero memberships anywhere and a matching
  `auth_user_id` are).
- Anything refused needs a human decision. Do not edit the tables by hand to get around a refusal.
