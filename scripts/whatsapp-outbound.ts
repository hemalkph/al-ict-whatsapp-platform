import { getDb } from "@/db";
import { runOutboundCli } from "@/modules/messaging/operator";
import { logToStderr } from "@/shared/logging/logger";

// OPERATOR-ONLY, database-only. Prints exactly ONE JSON document on stdout (log lines go to stderr). Read-only diagnostics of
// the outbound pipeline plus template registration (a dry run unless --apply). It sends nothing and has no resend command.
// Usage and the rules behind it: docs/RUNBOOK_WHATSAPP.md (run with no arguments for the command list).

logToStderr();
runOutboundCli(process.argv.slice(2), getDb(), (value) =>
  console.log(JSON.stringify(value, null, 2)),
)
  .then((code) => process.exit(code))
  .catch(() => {
    console.error(
      "Command failed unexpectedly. Check DATABASE_URL and that the database is migrated.",
    );
    process.exit(1);
  });
