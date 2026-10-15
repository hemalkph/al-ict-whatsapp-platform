import { EXIT_FATAL, runReconcileCli } from "@/modules/leads/reconcile";

// The opt-in lead reconciler. DISABLED BY DEFAULT: it does nothing unless LEADS_RECONCILER_ENABLED=true is set explicitly.
//
//   LEADS_RECONCILER_ENABLED=true npm run leads:reconcile
//
// It reads confirmed Meta ad referral evidence that the webhook worker already stored, links it to open leads or creates leads
// from it, runs ONE bounded pass and prints counts as one JSON line. It makes no request to Meta, sends no message, never changes
// the database schema and never runs by itself: not the web server, the build, migrations, tests or the webhook worker. All logic
// lives in src/modules/leads/reconcile; this file only wires the process.

// An unexpected crash must not dump a stack (a connection error can name a host or user): fixed line, non-zero exit.
const crash = () => {
  console.log(
    JSON.stringify({
      event: "leads.reconcile.run",
      outcome: "failure",
      reason: "uncaught_exception",
    }),
  );
  process.exit(EXIT_FATAL);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

runReconcileCli({ env: process.env })
  .then((code) => process.exit(code))
  .catch(crash);
