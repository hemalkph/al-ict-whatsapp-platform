import { and, eq, sql } from "drizzle-orm";
import { parseArgs } from "node:util";
import { schema, type Database } from "@/db";
import { shortHash } from "@/modules/whatsapp/idempotency";
import { transact } from "@/modules/whatsapp/operator/dryrun";
import { OUTBOUND_REQUEST_STATES, TEMPLATE_CATEGORIES } from "@/db/schema/enums";

// OPERATOR-ONLY, local, database-only (no Meta call, no token). Diagnostics are READ-ONLY and never show a message body, a
// recipient identifier or a provider payload by default. The only writes are template registrations (dry run unless --apply).
// There is deliberately NO command that re-queues, re-sends or "resolves" a request: an UNKNOWN_OUTCOME request may already
// have been delivered, and reconciling it is a human decision made against Meta's own message logs (docs/RUNBOOK_WHATSAPP.md).

type Out = (value: unknown) => void;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = schema.outboundRequests;

export async function outboundCounts(db: Database) {
  const states = await db.execute<{
    state: string;
    reason: string | null;
    n: number;
    oldest: Date | null;
  }>(sql`
    SELECT state, coalesce(hold_reason, failure_code) AS reason, count(*)::int AS n, min(created_at) AS oldest
    FROM outbound_requests GROUP BY 1, 2 ORDER BY 1, 2`);
  return states.rows.map((r) => ({
    state: r.state,
    reason: r.reason,
    count: r.n,
    oldestCreatedAt: r.oldest ? new Date(r.oldest).toISOString() : null,
  }));
}

export async function listOutbound(db: Database, options: { state?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      id: t.id,
      organizationId: t.organizationId,
      accountId: t.whatsappAccountId,
      conversationId: t.conversationId,
      state: t.state,
      messageType: t.messageType,
      recipientKind: t.recipientKind, // the KIND only, never the identifier
      holdReason: t.holdReason,
      failureCode: t.failureCode,
      attemptCount: t.attemptCount,
      createdAt: t.createdAt,
      sendStartedAt: t.sendStartedAt,
      finishedAt: t.finishedAt,
    })
    .from(t)
    .where(
      options.state
        ? eq(t.state, options.state as (typeof OUTBOUND_REQUEST_STATES)[number])
        : undefined,
    )
    .orderBy(sql`${t.createdAt} DESC`, t.id)
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    sendStartedAt: r.sendStartedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
}

export async function inspectOutbound(db: Database, id: string) {
  if (!UUID.test(id)) return { ok: false as const, refused: "invalid_input" };
  const [row] = await db
    .select({ r: t, wamid: schema.messages.wamid, delivery: schema.messages.latestStatus })
    .from(t)
    .innerJoin(
      schema.messages,
      and(
        eq(schema.messages.organizationId, t.organizationId),
        eq(schema.messages.id, t.messageId),
      ),
    )
    .where(eq(t.id, id));
  if (!row) return { ok: false as const, refused: "not_found" };
  const r = row.r;
  const advice: Record<string, string> = {
    UNKNOWN_OUTCOME:
      "This request may or may not have reached WhatsApp. It will never be re-sent automatically. Check the WhatsApp Business Manager message log for this account around the 'sendStartedAt' time; if the message was delivered there is nothing to do, if it was not, the staff member must send a NEW message with a new idempotency key. Do not guess a message id.",
    HELD: "Not sent, by policy (see holdReason). A new request is the next action.",
    REJECTED:
      "Refused by WhatsApp (see failureCode and providerErrorCode). A new request is the next action once the cause is fixed.",
    SENDING:
      "A dispatcher claimed this and has not recorded a result yet. After 5 minutes it is declared UNKNOWN_OUTCOME.",
  };
  return {
    ok: true as const,
    request: {
      id: r.id,
      organizationId: r.organizationId,
      accountId: r.whatsappAccountId,
      conversationId: r.conversationId,
      messageId: r.messageId,
      state: r.state,
      messageType: r.messageType,
      recipientKind: r.recipientKind,
      holdReason: r.holdReason,
      failureCode: r.failureCode,
      providerHttpStatus: r.providerHttpStatus,
      providerErrorCode: r.providerErrorCode,
      providerMessageStatus: r.providerMessageStatus,
      attemptCount: r.attemptCount,
      createdAt: r.createdAt.toISOString(),
      dispatchDeadline: r.dispatchDeadline.toISOString(),
      sendStartedAt: r.sendStartedAt?.toISOString() ?? null,
      acceptedAt: r.acceptedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      providerMessageIdHash: row.wamid ? shortHash(row.wamid) : null,
      deliveryStatus: row.delivery,
    },
    next: advice[r.state] ?? null,
    hidden: "recipient identifier, message body and provider payloads are not shown",
  };
}

export type OutboundFinding = {
  code: string;
  severity: "attention" | "info";
  meaning: string;
  next: string;
};

/** Read-only health of the outbound pipeline. The worker has no heartbeat: liveness is inferred from sends being recorded. */
export async function outboundHealth(db: Database, now: Date = new Date()) {
  const [m] = (
    await db.execute<{
      queued_due: number;
      oldest_due_s: number | null;
      sending: number;
      stuck_sending: number;
      unknown: number;
      held: number;
      rejected: number;
      sends_5m: number;
      last_send: Date | null;
      accepted_no_status: number;
      orphan_statuses: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM outbound_requests WHERE state = 'QUEUED' AND next_attempt_at <= ${now.toISOString()}::timestamptz) AS queued_due,
        (SELECT floor(extract(epoch FROM ${now.toISOString()}::timestamptz - min(next_attempt_at)))::int FROM outbound_requests WHERE state = 'QUEUED' AND next_attempt_at <= ${now.toISOString()}::timestamptz) AS oldest_due_s,
        (SELECT count(*)::int FROM outbound_requests WHERE state = 'SENDING') AS sending,
        (SELECT count(*)::int FROM outbound_requests WHERE state = 'SENDING' AND send_started_at < ${now.toISOString()}::timestamptz - interval '2 minutes') AS stuck_sending,
        (SELECT count(*)::int FROM outbound_requests WHERE state = 'UNKNOWN_OUTCOME') AS unknown,
        (SELECT count(*)::int FROM outbound_requests WHERE state = 'HELD') AS held,
        (SELECT count(*)::int FROM outbound_requests WHERE state = 'REJECTED') AS rejected,
        (SELECT count(*)::int FROM outbound_requests WHERE send_started_at > ${now.toISOString()}::timestamptz - interval '5 minutes') AS sends_5m,
        (SELECT max(send_started_at) FROM outbound_requests) AS last_send,
        (SELECT count(*)::int FROM outbound_requests o JOIN messages m ON m.organization_id = o.organization_id AND m.id = o.message_id
          WHERE o.state = 'ACCEPTED' AND o.accepted_at < ${now.toISOString()}::timestamptz - interval '15 minutes' AND m.latest_status IS NULL) AS accepted_no_status,
        (SELECT count(*)::int FROM message_status_events WHERE message_id IS NULL AND created_at < ${now.toISOString()}::timestamptz - interval '15 minutes') AS orphan_statuses
    `)
  ).rows;
  const findings: OutboundFinding[] = [];
  if ((m?.unknown ?? 0) > 0)
    findings.push({
      code: "unknown_outcome_requests",
      severity: "attention",
      meaning: `${m!.unknown} outbound request(s) may or may not have been sent. They are never re-sent automatically.`,
      next: "whatsapp:outbound list --state UNKNOWN_OUTCOME, then inspect <id> and reconcile against the WhatsApp Business Manager message log.",
    });
  if ((m?.stuck_sending ?? 0) > 0)
    findings.push({
      code: "stuck_sending",
      severity: "attention",
      meaning: `${m!.stuck_sending} request(s) have been SENDING for over 2 minutes: a dispatcher died or is stalled.`,
      next: "They become UNKNOWN_OUTCOME after 5 minutes (when a dispatcher runs). Check the outbound worker's outbound.worker_* log lines.",
    });
  if ((m?.oldest_due_s ?? 0) > 120 && (m?.sends_5m ?? 0) === 0)
    findings.push({
      code: "queue_not_draining",
      severity: "attention",
      meaning: `The oldest due request has waited ${m!.oldest_due_s}s and nothing was sent in 5 minutes.`,
      next: "Is the outbound worker running (WHATSAPP_OUTBOUND_ENABLED and WHATSAPP_LIVE_SEND_ENABLED both true)? Both gates must be set deliberately; it is never started automatically.",
    });
  if ((m?.held ?? 0) > 0)
    findings.push({
      code: "held_requests",
      severity: "info",
      meaning: `${m!.held} request(s) were held by policy (window closed, consent, recipient, deadline).`,
      next: "Expected. whatsapp:outbound counts shows the reasons; staff send a new message if still needed.",
    });
  if ((m?.rejected ?? 0) > 0)
    findings.push({
      code: "rejected_requests",
      severity: "info",
      meaning: `${m!.rejected} request(s) were refused by WhatsApp.`,
      next: "whatsapp:outbound counts shows the failure codes.",
    });
  if ((m?.accepted_no_status ?? 0) > 0 || (m?.orphan_statuses ?? 0) > 0)
    findings.push({
      code: "status_reconciliation_pending",
      severity: "info",
      meaning: `${m!.accepted_no_status} accepted message(s) have no delivery status after 15 minutes; ${m!.orphan_statuses} status event(s) match no message.`,
      next: "Usually the STATUS webhook has not arrived yet or the inbound worker is stopped (whatsapp:status). Orphan statuses are linked automatically when their message id is recorded; they are never guessed.",
    });
  return {
    generatedAt: now.toISOString(),
    queue: {
      dueQueued: m?.queued_due ?? 0,
      oldestDueSeconds: m?.oldest_due_s ?? null,
      sending: m?.sending ?? 0,
      sendsLast5Minutes: m?.sends_5m ?? 0,
      lastSendStartedAt: m?.last_send ? new Date(m.last_send).toISOString() : null,
    },
    states: await outboundCounts(db),
    reconciliation: {
      acceptedWithoutDeliveryStatus: m?.accepted_no_status ?? 0,
      orphanStatusEvents: m?.orphan_statuses ?? 0,
    },
    workerActivity:
      "There is no heartbeat; a running outbound worker is inferred from sends being recorded.",
    findings,
    needsAttention: findings.some((f) => f.severity === "attention"),
  };
}

// ------------------------------------------------------------------------------------------------ templates

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/;

export async function listTemplates(db: Database) {
  const rows = await db
    .select({ tpl: schema.whatsappTemplates, slug: schema.organizations.slug })
    .from(schema.whatsappTemplates)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.whatsappTemplates.organizationId),
    )
    .orderBy(schema.organizations.slug, schema.whatsappTemplates.name);
  return rows.map(({ tpl, slug }) => ({
    id: tpl.id,
    organization: slug,
    accountId: tpl.whatsappAccountId,
    name: tpl.name,
    language: tpl.languageCode,
    category: tpl.category,
    status: tpl.status,
    bodyParameters: tpl.bodyParameterCount,
    attestedAt: tpl.attestedAt?.toISOString() ?? null,
  }));
}

/** Registers a template as PENDING_ATTESTATION. Nothing is verified with Meta and nothing becomes sendable by registering. */
export async function registerTemplate(
  db: Database,
  input: {
    accountId: string;
    name: string;
    language: string;
    category: string;
    bodyParameters: number;
  },
  apply: boolean,
) {
  if (!UUID.test(input.accountId))
    return { ok: false as const, refused: "invalid_input", detail: "account id must be a UUID" };
  if (!TEMPLATE_NAME.test(input.name))
    return {
      ok: false as const,
      refused: "invalid_input",
      detail: "name must be lower-case letters, digits and underscores",
    };
  if (!LANGUAGE.test(input.language))
    return {
      ok: false as const,
      refused: "invalid_input",
      detail: "language must look like en_US or si",
    };
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(input.category))
    return {
      ok: false as const,
      refused: "invalid_input",
      detail: "category must be UTILITY, MARKETING or AUTHENTICATION",
    };
  if (
    !Number.isInteger(input.bodyParameters) ||
    input.bodyParameters < 0 ||
    input.bodyParameters > 20
  )
    return {
      ok: false as const,
      refused: "invalid_input",
      detail: "body parameters must be 0 to 20",
    };
  const { applied, value } = await transact(db, apply, async (tx) => {
    const [account] = await tx
      .select()
      .from(schema.whatsappAccounts)
      .where(eq(schema.whatsappAccounts.id, input.accountId))
      .for("share");
    if (!account) return { ok: false as const, refused: "account_not_found" };
    const [row] = await tx
      .insert(schema.whatsappTemplates)
      .values({
        organizationId: account.organizationId,
        whatsappAccountId: account.id,
        name: input.name,
        languageCode: input.language,
        category: input.category as never,
        bodyParameterCount: input.bodyParameters,
      })
      .onConflictDoNothing()
      .returning({ id: schema.whatsappTemplates.id });
    return row
      ? { ok: true as const, id: row.id }
      : { ok: false as const, refused: "already_registered" };
  });
  return value.ok
    ? {
        ...value,
        applied,
        status: "PENDING_ATTESTATION",
        note: "Not sendable until an operator attests it is approved in Meta (approve --attest-approved-in-meta).",
      }
    : value;
}

export async function setTemplateStatus(
  db: Database,
  input: { templateId: string; to: "APPROVED" | "DISABLED"; attested: boolean },
  apply: boolean,
) {
  if (!UUID.test(input.templateId)) return { ok: false as const, refused: "invalid_input" };
  if (input.to === "APPROVED" && !input.attested)
    return {
      ok: false as const,
      refused: "attestation_required",
      detail:
        "pass --attest-approved-in-meta: you are stating that this exact template (name + language) is APPROVED in the Meta dashboard for this WhatsApp account. The platform cannot verify it.",
    };
  const { applied, value } = await transact(db, apply, async (tx) => {
    const [row] = await tx
      .update(schema.whatsappTemplates)
      .set({
        status: input.to,
        attestedAt:
          input.to === "APPROVED" ? new Date() : sql`${schema.whatsappTemplates.attestedAt}`,
      })
      .where(eq(schema.whatsappTemplates.id, input.templateId))
      .returning({ id: schema.whatsappTemplates.id, status: schema.whatsappTemplates.status });
    return row
      ? { ok: true as const, id: row.id, status: row.status }
      : { ok: false as const, refused: "not_found" };
  });
  return value.ok ? { ...value, applied } : value;
}

// ------------------------------------------------------------------------------------------------------ CLI

export async function runOutboundCli(argv: string[], db: Database, out: Out): Promise<number> {
  const [command, ...rest] = argv;
  const usage = () => {
    out({
      ok: false,
      usage: [
        "health [--check]",
        "counts",
        "list [--state QUEUED|SENDING|ACCEPTED|REJECTED|HELD|UNKNOWN_OUTCOME] [--limit n]",
        "inspect <request-id>",
        "templates list",
        "templates register --account <id> --name <n> --language <l> --category UTILITY|MARKETING|AUTHENTICATION [--body-parameters n] [--apply]",
        "templates approve <template-id> --attest-approved-in-meta [--apply]",
        "templates disable <template-id> [--apply]",
      ],
      note: "read-only except templates; state-changing commands are dry runs unless --apply is given; there is no resend or resolve command",
    });
    return 2;
  };
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        state: { type: "string" },
        limit: { type: "string" },
        check: { type: "boolean" },
        apply: { type: "boolean" },
        account: { type: "string" },
        name: { type: "string" },
        language: { type: "string" },
        category: { type: "string" },
        "body-parameters": { type: "string" },
        "attest-approved-in-meta": { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
    const apply = values.apply === true;
    const done = (r: { ok: boolean } & Record<string, unknown>, applied?: boolean) => {
      out(
        applied === false
          ? { ...r, dryRun: true, next: "Nothing was changed. Re-run with --apply to perform it." }
          : r,
      );
      return r.ok ? 0 : 1;
    };
    const limit =
      values.limit === undefined
        ? undefined
        : /^[0-9]{1,4}$/.test(values.limit)
          ? Number(values.limit)
          : Number.NaN;
    if (Number.isNaN(limit)) return usage();
    switch (command) {
      case "health": {
        const h = await outboundHealth(db);
        out({ ok: true, ...h });
        return values.check && h.needsAttention ? 1 : 0;
      }
      case "counts":
        out({ ok: true, states: await outboundCounts(db) });
        return 0;
      case "list":
        if (
          values.state !== undefined &&
          !(OUTBOUND_REQUEST_STATES as readonly string[]).includes(values.state)
        )
          return usage();
        out({
          ok: true,
          note: "recipients and message bodies are never listed",
          requests: await listOutbound(db, { state: values.state, limit }),
        });
        return 0;
      case "inspect":
        return positionals[0] ? done(await inspectOutbound(db, positionals[0])) : usage();
      case "templates": {
        const [sub, id] = positionals;
        if (sub === "list") {
          out({ ok: true, templates: await listTemplates(db) });
          return 0;
        }
        if (sub === "register") {
          if (!values.account || !values.name || !values.language || !values.category)
            return usage();
          const r = await registerTemplate(
            db,
            {
              accountId: values.account,
              name: values.name,
              language: values.language,
              category: values.category,
              bodyParameters: Number(values["body-parameters"] ?? "0"),
            },
            apply,
          );
          return done(r, "applied" in r ? r.applied : undefined);
        }
        if ((sub === "approve" || sub === "disable") && id) {
          const r = await setTemplateStatus(
            db,
            {
              templateId: id,
              to: sub === "approve" ? "APPROVED" : "DISABLED",
              attested: values["attest-approved-in-meta"] === true,
            },
            apply,
          );
          return done(r, "applied" in r ? r.applied : undefined);
        }
        return usage();
      }
      default:
        return usage();
    }
  } catch (error) {
    if (error instanceof TypeError && "code" in error) return usage();
    throw error;
  }
}
