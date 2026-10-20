import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, eq, or } from "drizzle-orm";
import { schema, type Database } from "@/db";
import { can, type AccessContext, type Role } from "@/modules/access";
import { AppError } from "@/shared/errors/app-error";
import { BotControlError } from "./errors";
import type { Written } from "./common";
import { createBot, getBot, listBots, updateDraft, validateDraft } from "./drafts";
import { getVersion, listVersions, publishVersion } from "./publish";
import {
  activateDeployment,
  changeDeploymentVersion,
  emergencyStop,
  listDeployments,
  liveSessionCount,
  pauseDeployment,
  resumeDeployment,
  retireDeployment,
  stopActiveSessions,
} from "./deployments";
import { EMERGENCY_STOP_PHRASE } from "./schemas";

// OPERATOR-ONLY command line for bot management (Phase 08C, ADR 0019; owner default: CLI-only administration in 08C). Every
// command acts AS a real member of the organization, resolved from the database (--organization, --actor <email>); the
// services then re-check that member's status and permission under transaction locks, exactly as for any other caller.
// Prints ONE JSON document; returns the exit code: 0 success, 1 refused (nothing changed), 2 usage error. State-changing
// commands are dry runs (performed, then rolled back) unless --apply is given. Destructive controls also need a typed
// confirmation matching the current state (count preview). Output carries ids, codes and counts, never student content.

export type Out = (value: unknown) => void;
const USAGE = 2;

const COMMANDS = [
  "list",
  "show <bot-id>",
  "versions <bot-id>",
  "version <version-id>",
  "deployments",
  "create --key <key> --name <text> [--description <text>] [--apply]",
  "draft <bot-id> --file <config.json> --expected-revision <n> [--apply]",
  "validate <bot-id>",
  "publish <bot-id> --expected-revision <n> [--note <text>] [--apply]",
  "activate <bot-id> --version <version-id> --account <account-id> --priority <1-1000> [--apply]",
  "change-version <deployment-id> --version <version-id> [--apply]",
  "pause|resume <deployment-id> [--apply]",
  "stop-sessions <deployment-id> [--confirm-count <n>] [--apply]",
  "retire <deployment-id> [--confirm-count <n> --confirm-key <bot-key>] [--apply]",
  `emergency-stop [--account <account-id>] [--confirm-count <n> --confirm "${EMERGENCY_STOP_PHRASE}"] [--apply]`,
];

/** The acting member: ACTIVE membership of the named organization for the user with this email. */
async function resolveActor(
  db: Database,
  organization: string,
  email: string,
): Promise<AccessContext | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    organization,
  );
  const [row] = await db
    .select({
      userId: schema.users.id,
      membershipId: schema.organizationMemberships.id,
      organizationId: schema.organizationMemberships.organizationId,
      role: schema.organizationMemberships.role,
      status: schema.organizationMemberships.status,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.organizationMemberships.organizationId),
    )
    .where(
      and(
        eq(schema.users.email, email.trim().toLowerCase()),
        isUuid
          ? or(
              eq(schema.organizations.id, organization),
              eq(schema.organizations.slug, organization),
            )
          : eq(schema.organizations.slug, organization),
      ),
    )
    .limit(1);
  if (!row || row.status !== "ACTIVE") return null;
  const role: Role = row.role;
  return {
    userId: row.userId,
    membershipId: row.membershipId,
    organizationId: row.organizationId,
    role,
    can: (permission) => can(role, permission),
  };
}

const int = (value: string | undefined): number | undefined =>
  value !== undefined && /^-?[0-9]{1,9}$/.test(value) ? Number(value) : undefined;

function wrote(out: Out, written: Written<unknown>): number {
  out(
    written.applied
      ? { ok: true, applied: true, result: written.value }
      : {
          ok: true,
          applied: false,
          dryRun: true,
          result: written.value,
          next: "Nothing was changed. Re-run with --apply to perform it.",
        },
  );
  return 0;
}

export async function runBotsCli(argv: string[], db: Database, out: Out): Promise<number> {
  const [command, ...rest] = argv;
  const usage = (problem?: string) => {
    out({
      ok: false,
      ...(problem ? { problem } : {}),
      usage: COMMANDS.map((c) => `${c} --organization <slug|id> --actor <email>`),
      note: "state-changing commands are dry runs unless --apply is given",
    });
    return USAGE;
  };
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        organization: { type: "string" },
        actor: { type: "string" },
        key: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        file: { type: "string" },
        "expected-revision": { type: "string" },
        note: { type: "string" },
        version: { type: "string" },
        account: { type: "string" },
        priority: { type: "string" },
        "confirm-count": { type: "string" },
        "confirm-key": { type: "string" },
        confirm: { type: "string" },
        apply: { type: "boolean" },
      },
    }));
  } catch {
    return usage("unknown or malformed option");
  }
  if (!command || !COMMANDS.some((c) => c.split(" ")[0]!.split("|").includes(command)))
    return usage();
  const str = (name: string) =>
    typeof values[name] === "string" ? (values[name] as string) : undefined;
  const organization = str("organization");
  const email = str("actor");
  if (!organization || !email) return usage("--organization and --actor are required");
  const ctx = await resolveActor(db, organization, email);
  if (!ctx) {
    out({ ok: false, error: "ACTOR_NOT_FOUND", note: "no ACTIVE membership for this actor here" });
    return 1;
  }
  const deps = { db };
  const options = { dryRun: values.apply !== true };
  const id = positionals[0];

  try {
    switch (command) {
      case "list":
        out({ ok: true, bots: await listBots(ctx, deps) });
        return 0;
      case "show":
        if (!id) return usage("a bot id is required");
        out({ ok: true, bot: await getBot(ctx, id, deps) });
        return 0;
      case "versions":
        if (!id) return usage("a bot id is required");
        out({ ok: true, versions: await listVersions(ctx, id, deps) });
        return 0;
      case "version":
        if (!id) return usage("a version id is required");
        out({ ok: true, version: await getVersion(ctx, id, deps) });
        return 0;
      case "deployments":
        out({ ok: true, deployments: await listDeployments(ctx, deps) });
        return 0;
      case "validate":
        if (!id) return usage("a bot id is required");
        out({ ok: true, validation: await validateDraft(ctx, id, deps) });
        return 0;
      case "create":
        return wrote(
          out,
          await createBot(
            ctx,
            {
              key: str("key"),
              name: str("name"),
              ...(str("description") === undefined ? {} : { description: str("description") }),
            },
            deps,
            options,
          ),
        );
      case "draft": {
        const file = str("file");
        if (!id || !file) return usage("a bot id and --file are required");
        let config: unknown;
        try {
          config = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          out({ ok: false, error: "FILE_UNREADABLE", note: "the file is not readable JSON" });
          return 1;
        }
        return wrote(
          out,
          await updateDraft(
            ctx,
            { botId: id, expectedRevision: int(str("expected-revision")), config },
            deps,
            options,
          ),
        );
      }
      case "publish":
        if (!id) return usage("a bot id is required");
        return wrote(
          out,
          await publishVersion(
            ctx,
            {
              botId: id,
              expectedRevision: int(str("expected-revision")),
              ...(str("note") === undefined ? {} : { changeNote: str("note") }),
            },
            deps,
            options,
          ),
        );
      case "activate":
        if (!id) return usage("a bot id is required");
        return wrote(
          out,
          await activateDeployment(
            ctx,
            {
              botId: id,
              versionId: str("version"),
              whatsappAccountId: str("account"),
              priority: int(str("priority")),
            },
            deps,
            options,
          ),
        );
      case "change-version":
        if (!id) return usage("a deployment id is required");
        return wrote(
          out,
          await changeDeploymentVersion(
            ctx,
            { deploymentId: id, versionId: str("version") },
            deps,
            options,
          ),
        );
      case "pause":
      case "resume":
        if (!id) return usage("a deployment id is required");
        return wrote(
          out,
          await (command === "pause" ? pauseDeployment : resumeDeployment)(
            ctx,
            { deploymentId: id },
            deps,
            options,
          ),
        );
      case "stop-sessions":
      case "retire": {
        if (!id) return usage("a deployment id is required");
        const expected = int(str("confirm-count"));
        if (expected === undefined) {
          // Count preview: what the confirmation must match.
          out({
            ok: true,
            preview: { deploymentId: id, liveSessions: await liveSessionCount(ctx, id, deps) },
            next: "Re-run with --confirm-count <liveSessions> (and, to retire, --confirm-key <bot-key>).",
          });
          return 0;
        }
        return wrote(
          out,
          command === "retire"
            ? await retireDeployment(
                ctx,
                {
                  deploymentId: id,
                  expectedLiveSessions: expected,
                  confirmBotKey: str("confirm-key"),
                },
                deps,
                options,
              )
            : await stopActiveSessions(
                ctx,
                { deploymentId: id, expectedLiveSessions: expected },
                deps,
                options,
              ),
        );
      }
      case "emergency-stop": {
        const expected = int(str("confirm-count"));
        const account = str("account");
        if (expected === undefined) {
          const targets = (await listDeployments(ctx, deps)).filter(
            (d) =>
              (d.status === "ACTIVE" || d.status === "PAUSED") &&
              (account === undefined || d.whatsappAccountId === account),
          );
          out({
            ok: true,
            preview: { deployments: targets.length },
            next: `Re-run with --confirm-count <deployments> --confirm "${EMERGENCY_STOP_PHRASE}".`,
          });
          return 0;
        }
        return wrote(
          out,
          await emergencyStop(
            ctx,
            {
              ...(account === undefined ? {} : { whatsappAccountId: account }),
              expectedDeployments: expected,
              confirmPhrase: str("confirm"),
            },
            deps,
            options,
          ),
        );
      }
    }
    return usage();
  } catch (error) {
    if (error instanceof AppError) {
      out({
        ok: false,
        error: error.code,
        ...(error instanceof BotControlError && error.reason ? { reason: error.reason } : {}),
        ...(error instanceof BotControlError && error.diagnostics
          ? { diagnostics: error.diagnostics }
          : {}),
        ...("fields" in error ? { fields: (error as { fields: unknown }).fields } : {}),
      });
      return 1;
    }
    throw error;
  }
}
