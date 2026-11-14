import { getDb } from "@/db";
import { logToStderr } from "@/shared/logging/logger";
import { runBotsCli } from "@/modules/bot-control/operator";

// OPERATOR-ONLY bot management (Phase 08C, ADR 0019). Prints exactly ONE JSON document on stdout (audit log lines go to stderr);
// state-changing commands are dry runs unless --apply is given. Run with no arguments for the command list.
// It manages drafts, versions and deployments only: no bot runtime exists before Phase 08E, and nothing here sends messages.

logToStderr();
runBotsCli(process.argv.slice(2), getDb(), (value) => console.log(JSON.stringify(value, null, 2)))
  .then((code) => process.exit(code))
  .catch(() => {
    console.error(
      "Command failed unexpectedly. Check DATABASE_URL and that the database is migrated.",
    );
    process.exit(1);
  });
