import { emitBotRuntimeLog } from "@/modules/bot-runtime";
import { EXIT_FATAL, runBotWorker } from "@/modules/bot-worker";

// The standalone BOT worker (Phase 08E-7). DISABLED BY DEFAULT: it refuses to start, before connecting to anything, unless
// BOTS_RUNTIME_ENABLED and WHATSAPP_OUTBOUND_ENABLED are both exactly "true".
//
//   npm run bots:worker      (stop with Ctrl-C or SIGTERM)
//
// It processes captured bot triggers and reconciles live sessions. It never calls Meta and never sends: a BOT message it
// queues is sent, if ever, by the separately gated outbound worker. All logic lives in src/modules/bot-worker; this file only
// wires the process environment and signals. Nothing else starts it: not the web server, the build, migrations, tests or any
// other worker.

const controller = new AbortController();
// First SIGTERM/SIGINT: stop claiming and sweeping; started transactions finish within the grace period. A repeat is a no-op.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => controller.abort());

// An unexpected crash must not dump a stack (a connection error can name a host or user): fixed log line, non-zero exit.
const crash = () => {
  emitBotRuntimeLog({
    event: "bots.worker_fatal",
    outcome: "failure",
    reason: "uncaught_exception",
  });
  process.exit(EXIT_FATAL);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

runBotWorker({ env: process.env, signal: controller.signal })
  .then((code) => process.exit(code))
  .catch(crash);
