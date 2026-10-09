import { getDb } from "@/db";
import { logToStderr } from "@/shared/logging/logger";
import { runStatusCli } from "@/modules/whatsapp/operator";

// OPERATOR-ONLY. Prints exactly ONE JSON document on stdout (audit and diagnostic log lines go to stderr); state-changing commands are dry runs unless --apply is given.
// Usage and the rules behind each command: docs/RUNBOOK_WHATSAPP.md (run with no arguments for the command list).

logToStderr();
runStatusCli(process.argv.slice(2), getDb(), (value) => console.log(JSON.stringify(value, null, 2)))
  .then((code) => process.exit(code))
  .catch(() => {
    console.error(
      "Command failed unexpectedly. Check DATABASE_URL and that the database is migrated.",
    );
    process.exit(1);
  });
