import { createWorkerDatabase } from "@/db";
import { logToStderr } from "@/shared/logging/logger";
import { runRetentionCli } from "@/modules/bot-control/retention";

// OPERATOR-ONLY bot data retention (Phase 08F-1). Prints exactly ONE JSON document on stdout (log lines go to stderr).
//
//   npm run bots:retention            dry run: counts what is eligible now, changes nothing
//   npm run bots:retention -- --apply redacts expired terminal sessions (30 days) and deletes terminal triggers (14 days)
//
// Runs only when invoked: no schedule, no HTTP route, no membership. It never sends a message, reads no automation gate and
// starts no worker. Its own one-connection pool bounds every lock wait and statement.

logToStderr();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const database = createWorkerDatabase(url, {
  maxConnections: 1,
  applicationName: "al-ict-bots-retention",
  sessionSettings: { lock_timeout: "5s", statement_timeout: "60s" },
  onPoolError: () => undefined, // the failure reaches the pending query; no stack is printed
});
runRetentionCli(process.argv.slice(2), database.db, (value) =>
  console.log(JSON.stringify(value, null, 2)),
)
  .then(async (code) => {
    await database.close();
    process.exit(code);
  })
  .catch(() => {
    console.error(
      "Command failed unexpectedly. Check DATABASE_URL and that the database is migrated.",
    );
    process.exit(1);
  });
