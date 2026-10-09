import { emitWebhookLog } from "@/modules/whatsapp/logging";
import { EXIT_FATAL, runWorker } from "@/modules/whatsapp/worker";

// The standalone WhatsApp webhook worker. DISABLED BY DEFAULT: it does nothing unless WHATSAPP_WORKER_ENABLED=true.
//
//   WHATSAPP_WORKER_ENABLED=true npm run whatsapp:worker      (stop with Ctrl-C or SIGTERM)
//
// It claims already-stored webhook events and runs the MESSAGE and STATUS handlers. It makes no request to Meta, sends
// nothing and never changes the database schema. All logic lives in src/modules/whatsapp/worker; this file only wires
// the process signals. Nothing else starts it: not the web server, the build, migrations, tests or the webhook route.

const controller = new AbortController();
// First SIGTERM/SIGINT: stop claiming, let in-flight events finish (bounded by the shutdown grace period). A repeat is a no-op.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => controller.abort());

// An unexpected crash must not dump a stack (a connection error can name a host or user): fixed log line, non-zero exit.
const crash = () => {
  emitWebhookLog({ event: "worker.fatal", outcome: "failure", reason: "uncaught_exception" });
  process.exit(EXIT_FATAL);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

runWorker({ env: process.env, signal: controller.signal })
  .then((code) => process.exit(code))
  .catch(crash);
