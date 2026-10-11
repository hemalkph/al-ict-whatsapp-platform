import { emitWebhookLog } from "@/modules/whatsapp/logging";
import { MetaTransport } from "@/modules/messaging/meta-transport";
import { EXIT_FATAL, runOutboundWorker } from "@/modules/messaging/worker";

// The standalone OUTBOUND worker. DISABLED BY DEFAULT: it does nothing unless BOTH WHATSAPP_OUTBOUND_ENABLED=true and
// WHATSAPP_LIVE_SEND_ENABLED=true are set, and it is the only process that can make an HTTP request to Meta.
//
//   WHATSAPP_OUTBOUND_ENABLED=true WHATSAPP_LIVE_SEND_ENABLED=true WHATSAPP_GRAPH_API_VERSION=vNN.N npm run whatsapp:outbound-worker
//
// It claims queued outbound requests and sends them through the official Cloud API. Nothing else starts it: not the web
// server, the build, migrations, tests or the webhook route. A real send needs the account's credential_ref to name an
// environment variable that holds its access token. Stop with Ctrl-C or SIGTERM: it stops claiming and lets the request in
// flight finish; an interrupted send is never retried (it becomes UNKNOWN_OUTCOME).

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => controller.abort());
const crash = () => {
  emitWebhookLog({
    event: "outbound.worker_fatal",
    outcome: "failure",
    reason: "uncaught_exception",
  });
  process.exit(EXIT_FATAL);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

runOutboundWorker({
  env: process.env,
  signal: controller.signal,
  transport: new MetaTransport({ env: () => process.env }),
})
  .then((code) => process.exit(code))
  .catch(crash);
