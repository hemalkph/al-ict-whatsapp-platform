import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { Database } from "@/db";
import {
  activateAccount,
  archiveAccount,
  disableAccount,
  enableAccount,
  inspectAccount,
  listAccounts,
  registerAccount,
} from "./accounts";
import { deadSummary, inspectDead, listDead } from "./dead";
import { heldEventCounts, listHeldEvents, requeueRouted, requeueUnrouted } from "./events";
import { pipelineHealth } from "./health";

// Argument handling for the three operator scripts. Every command prints ONE JSON document to `out` and returns the
// process exit code: 0 success, 1 refused (nothing changed), 2 usage error. State-changing commands are dry runs unless
// `--apply` is given.

export type Out = (value: unknown) => void;
const USAGE = 2;

function parse<T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
  return parseArgs({ args: argv, options, strict: true, allowPositionals: true });
}

const done = (out: Out, result: { ok: boolean } & Record<string, unknown>, applied?: boolean) => {
  const dryRun = applied === false;
  out(
    dryRun
      ? { ...result, dryRun: true, next: "Nothing was changed. Re-run with --apply to perform it." }
      : result,
  );
  return result.ok ? 0 : 1;
};

export async function runAccountsCli(argv: string[], db: Database, out: Out): Promise<number> {
  const [command, ...rest] = argv;
  const usage = () => {
    out({
      ok: false,
      usage: [
        "list",
        "inspect <account-id>",
        "register --organization <slug|id> --waba-id <id> --phone-number-id <id> --display-phone-number <text> [--verified-name <text>] [--credential-ref <SECRET_NAME>] --confirm-single-portfolio [--apply]",
        "activate|enable|disable|archive <account-id> [--apply]",
      ],
      note: "state-changing commands are dry runs unless --apply is given",
    });
    return USAGE;
  };
  try {
    const { values, positionals } = parse(rest, {
      organization: { type: "string" },
      "waba-id": { type: "string" },
      "phone-number-id": { type: "string" },
      "display-phone-number": { type: "string" },
      "verified-name": { type: "string" },
      "credential-ref": { type: "string" },
      "confirm-single-portfolio": { type: "boolean" },
      apply: { type: "boolean" },
    });
    const apply = values.apply === true;
    const id = positionals[0];
    switch (command) {
      case "list":
        out({ ok: true, accounts: await listAccounts(db) });
        return 0;
      case "inspect":
        if (!id) return usage();
        return done(out, await inspectAccount(db, id));
      case "register": {
        const r = await registerAccount(
          db,
          {
            organization: values.organization,
            wabaId: values["waba-id"],
            phoneNumberId: values["phone-number-id"],
            displayPhoneNumber: values["display-phone-number"],
            verifiedName: values["verified-name"],
            credentialRef: values["credential-ref"],
            portfolioConfirmed: values["confirm-single-portfolio"] === true ? true : undefined,
          },
          { apply },
        );
        return done(out, r, "applied" in r ? r.applied : undefined);
      }
      case "activate":
      case "enable":
      case "disable":
      case "archive": {
        if (!id) return usage();
        const fn = {
          activate: activateAccount,
          enable: enableAccount,
          disable: disableAccount,
          archive: archiveAccount,
        }[command];
        const r = await fn(db, id, { apply });
        return done(out, r, "applied" in r ? r.applied : undefined);
      }
      default:
        return usage();
    }
  } catch (error) {
    if (error instanceof TypeError && "code" in error) return usage();
    throw error;
  }
}

export async function runEventsCli(argv: string[], db: Database, out: Out): Promise<number> {
  const [command, ...rest] = argv;
  const usage = () => {
    out({
      ok: false,
      usage: [
        "counts",
        "list [--status UNROUTABLE|IGNORED] [--reason <code>] [--account <id>] [--limit <n>]",
        "requeue-routed --account <id> --reason account_pending|account_disabled|account_archived [--max-age-days <n>] [--apply --expect <n>]",
        "requeue-unrouted --event <id> --account <id> [--max-age-days <n>] [--apply --approve-ownership [--reviewed-waba-mismatch]]",
        "dead summary",
        "dead list [--reason <code>] [--limit <n>]",
        "dead inspect <event-id> [--reveal-payload]   (refused unless WHATSAPP_ALLOW_PII_REVEAL=true; UNAPPROVED FOR REAL CUSTOMER DATA: see docs/RUNBOOK_WHATSAPP.md)",
      ],
      note: "state-changing commands are dry runs unless --apply is given; DEAD events are read-only",
    });
    return USAGE;
  };
  try {
    const { values, positionals } = parse(rest, {
      status: { type: "string" },
      reason: { type: "string" },
      account: { type: "string" },
      event: { type: "string" },
      limit: { type: "string" },
      "max-age-days": { type: "string" },
      expect: { type: "string" },
      apply: { type: "boolean" },
      "approve-ownership": { type: "boolean" },
      "reviewed-waba-mismatch": { type: "boolean" },
      "reveal-payload": { type: "boolean" },
    });
    const int = (v: string | undefined) =>
      v === undefined ? undefined : /^[0-9]{1,6}$/.test(v) ? Number(v) : Number.NaN;
    const limit = int(values.limit);
    const maxAgeDays = int(values["max-age-days"]);
    const expect = int(values.expect);
    if ([limit, maxAgeDays, expect].some((n) => n !== undefined && Number.isNaN(n))) return usage();

    switch (command) {
      case "counts":
        out({ ok: true, held: await heldEventCounts(db), dead: await deadSummary(db) });
        return 0;
      case "list": {
        const status = values.status;
        if (status !== undefined && status !== "UNROUTABLE" && status !== "IGNORED") return usage();
        out({
          ok: true,
          note: "payloads are never listed",
          events: await listHeldEvents(db, {
            status,
            reason: values.reason,
            accountId: values.account,
            limit,
          }),
        });
        return 0;
      }
      case "requeue-routed": {
        if (!values.account || !values.reason) return usage();
        const r = await requeueRouted(db, {
          accountId: values.account,
          reason: values.reason,
          maxAgeDays,
          apply: values.apply === true,
          expect,
        });
        return done(out, r, "applied" in r ? r.applied : undefined);
      }
      case "requeue-unrouted": {
        if (!values.event || !values.account) return usage();
        const r = await requeueUnrouted(db, {
          eventId: values.event,
          accountId: values.account,
          maxAgeDays,
          apply: values.apply === true,
          approveOwnership: values["approve-ownership"] === true,
          reviewedWabaMismatch: values["reviewed-waba-mismatch"] === true,
        });
        return done(out, r, "applied" in r ? r.applied : undefined);
      }
      case "dead": {
        const [sub, id] = positionals;
        if (sub === "summary") {
          out({ ok: true, dead: await deadSummary(db) });
          return 0;
        }
        if (sub === "list") {
          out({
            ok: true,
            note: "payloads are never listed",
            events: await listDead(db, { reason: values.reason, limit }),
          });
          return 0;
        }
        if (sub === "inspect" && id)
          return done(
            out,
            await inspectDead(db, id, { revealPayload: values["reveal-payload"] === true }),
          );
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

export async function runStatusCli(argv: string[], db: Database, out: Out): Promise<number> {
  try {
    const { values } = parse(argv, { check: { type: "boolean" } });
    const report = await pipelineHealth(db);
    out({ ok: true, ...report });
    return values.check && report.needsAttention ? 1 : 0;
  } catch (error) {
    if (error instanceof TypeError && "code" in error) {
      out({ ok: false, usage: ["[--check]  (exit 1 when a finding needs attention)"] });
      return USAGE;
    }
    throw error;
  }
}
