# ADR 0022: Internal multi-tenant first, commercial SaaS later (AD-08G-MT-01)

Status: Accepted by the owner as an architectural direction (2026-11-04). **Design only: nothing in this ADR is implemented by
it.** It refines [ADR 0005](0005-organization-isolation.md) (which ruled out commercial multi-tenancy) and does not change ADRs
0011–0021.

## Context

The platform was built for one A/L ICT tuition operation. The owner now intends to run, on one deployment, that operation and
other companies or startups managed by the same internal team, and later to offer the platform to unrelated paying businesses as
a SaaS product. ADR 0005 already made `organization_id` a hard boundary "from day one", so the question is what the boundary
must guarantee now, and what must not be built yet.

## Decision

1. **Internal multi-tenant now.** One platform instance serves several organizations operated by the internal team. Each
   organization is a **logical tenant**.
2. **Commercial SaaS later, by compatibility only.** New work must not make external tenants harder to add (no cross-tenant
   shortcuts, no tenant-specific code paths in the generic core). External onboarding, subscriptions, billing, plans, usage
   metering, reseller management and self-service administration are **not authorized** and are not designed here.
3. **The organization is the initial tenant boundary.** It is a technical isolation unit. It does **not** by itself identify the
   legal data controller: in a given business arrangement the controller may be the organization's business, the platform
   operator, or both, and each arrangement needs its own legal determination and agreement.

### Isolation

- Every tenant-owned record carries `organization_id`; references are composite foreign keys that include it (ADR 0011);
  queries are scoped by the organization resolved server-side from the session and an ACTIVE membership; another tenant's ids
  yield 404 (ADR 0012).
- A WhatsApp account belongs to exactly one organization. Inbound routing goes only through `whatsapp_accounts.phone_number_id`
  (globally unique). Contacts are per organization (`UNIQUE (organization_id, wa_id)`): the same person writing to two tenants
  is two unrelated contacts.
- Bot deployments, the routing guard and its lock are per (organization, account).

### Roles

- **Organization administrator** (`ADMIN` membership): manages that organization's staff, Inbox and, in future, its bots and
  tenant-scoped settings. Never sees or changes another organization, and cannot weaken platform controls.
- **Platform administrator** (to be designed): the internal team operating the deployment: provisioning organizations and
  WhatsApp accounts, running operator jobs, support access. Today this role exists only as "whoever holds the database
  credentials and runs the CLIs"; it has no identity, permission model or audit. That is acceptable only while no external
  tenant exists.
- Support access by platform administrators to a tenant's personal data must be explicit, time-bounded, justified and audited
  (design deferred; required before any external tenant).

### Shared versus tenant-scoped

| Shared platform infrastructure                                                            | Tenant-scoped                                                                                                                           |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Application, workers, database, Meta app and its webhook secret, logs, backups, scheduler | Bot definitions and deployments, Inbox data, staff and permissions, leads, retention policy (within platform bounds), erasure decisions |

### Generic core versus business-specific workflows

The core (WhatsApp ingress and dispatch, Inbox, bots engine and runtime, leads, retention) stays business-neutral. Business
specifics (A/L ICT class lists, Registration questions, payment wording) live in **tenant data** (bot definitions, content), not
in core code. A workflow that cannot be expressed as data is a separate, reviewed extension, not a branch on an organization id.

## Consequences

- **Positive:** the existing isolation (ADR 0005, 0011, 0012) is reused as is; the internal team can add organizations without a
  redesign; privacy controls are designed once with a tenant dimension (see `PHASE_08G-7B_PRIVACY_POLICY_DECISIONS.md`,
  section 15).
- **Not yet satisfied (gaps, not claims):**
  - no supported way to create a second organization (`auth:bootstrap-admin` refuses once one exists);
  - a user with more than one ACTIVE membership gets 409 (no organization selector);
  - no platform-administrator identity, permission model or access audit; operator CLIs are unauthenticated beyond the database
    credential;
  - one privileged database role; row-level security deferred (ADR 0012);
  - one Meta app secret and verify token for every tenant; raw webhook requests can contain several tenants' data;
  - logs and backups are platform-wide and contain every tenant;
  - no per-tenant retention configuration, erasure or read-access audit (blocker 65);
  - no per-tenant fairness or quota for workers.
- **Risks:** a missed `organization_id` predicate in new code becomes a cross-tenant disclosure, not just a bug; platform
  administrators have unaudited access to every tenant; a tenant-specific retention choice could conflict with another tenant's
  data in shared copies (raw requests, logs, backups).

## Future migration considerations

Before the first **external** tenant: platform-administrator identity and audit; organization provisioning and offboarding
(including tenant data export and deletion); an organization selector; an evaluation of row-level security or per-tenant
database roles; per-tenant Meta app or credential separation if required; tenant agreements that state controller and processor
roles; per-tenant retention within platform bounds; per-tenant erasure; and a review of every shared copy. Commercial features
come after those, each with its own ADR.
