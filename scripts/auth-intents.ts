import { parseArgs } from "node:util";
import {
  OperatorRefusedError,
  inspectIntent,
  listIntents,
  removeIntent,
  resumeIntent,
} from "@/modules/access/operator";
import { ValidationError } from "@/shared/errors/http-errors";

// OPERATOR-ONLY recovery/inspection of unresolved staff_provisioning_intents. Intents are NEVER expired or deleted
// automatically; this tool only acts when ownership can be proven and otherwise refuses for operator review.
//
//   npm run auth:intents -- list
//   npm run auth:intents -- inspect <intent-id>
//   npm run auth:intents -- resume <intent-id> --role ADMIN|STAFF|VIEWER
//   npm run auth:intents -- remove <intent-id> [--min-age-minutes 10]
//
// Output contains identifiers and classifications only (never passwords, tokens or credential data).

function print(report: Awaited<ReturnType<typeof inspectIntent>>) {
  console.log(JSON.stringify({ ...report, createdAt: report.createdAt.toISOString() }, null, 2));
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: { role: { type: "string" }, "min-age-minutes": { type: "string" } },
    strict: true,
    allowPositionals: true,
  });
  const [command, intentId] = positionals;
  try {
    if (command === "list") {
      const reports = await listIntents();
      if (reports.length === 0) console.log("No unresolved provisioning intents.");
      for (const r of reports) print(r);
      return 0;
    }
    if (!intentId) {
      console.error(
        "Usage: auth:intents list | inspect <id> | resume <id> --role <ROLE> | remove <id> [--min-age-minutes N]",
      );
      return 2;
    }
    if (command === "inspect") {
      print(await inspectIntent(intentId));
      return 0;
    }
    if (command === "resume") {
      const result = await resumeIntent(intentId, { role: values.role });
      console.log(
        `Intent finalized. membership: ${result.membershipId} (organization ${result.organizationId}). The user must change the password at first sign-in.`,
      );
      return 0;
    }
    if (command === "remove") {
      const minAge =
        values["min-age-minutes"] === undefined ? undefined : Number(values["min-age-minutes"]);
      await removeIntent(intentId, { minAgeMinutes: minAge });
      console.log("Intent removed (no auth identity existed for it).");
      return 0;
    }
    console.error(`Unknown command: ${String(command)}`);
    return 2;
  } catch (error) {
    if (error instanceof OperatorRefusedError) console.error(`Refused: ${error.message}`);
    else if (error instanceof ValidationError)
      console.error(`Invalid input: ${error.fields.join(", ")}`);
    else console.error("Command failed unexpectedly. Check DATABASE_URL.");
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unexpected error.");
    process.exit(1);
  });
