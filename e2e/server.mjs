// Serves the REAL production build (`next build` output, NODE_ENV=production) over HTTPS for the E2E run, using Next's
// documented custom-server API and the throwaway certificate created by scripts/e2e.ts. A custom server is needed
// only because production requires an https BETTER_AUTH_URL and `next start` cannot serve https. It adds no routes,
// headers or behavior to the application's own port.
//
// Harness-only extras (never part of the application):
//  - a second listener on 127.0.0.1:E2E_CONTROL_PORT (plain http) whose only endpoint, GET /in-flight, reports how many
//    requests the application is still answering (see harness/tracker.mjs). The tests wait for it to read 0 before
//    closing a page or abandoning a navigation, so a browser never cancels a request the server is still answering.
//  - stress knobs that emulate a slow CI runner at specific boundaries (all unset in CI):
//      E2E_SLOW_JITTER_MS  delays each GET by a random 0..N ms before Next sees it;
//      E2E_DELAY_END_MS    for POST responses that are already under way (headers sent), finishes them N ms later, which
//                          widens the window between "first bytes written" and "response complete".
//  - E2E_DIAG=1: an opt-in, privacy-safe request timeline (harness/diag.mjs) for investigating a server error.
//  - graceful shutdown on SIGTERM (Playwright sends it after the browsers are closed).
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";
import next from "next";
import { createRequestTracker } from "./harness/tracker.mjs";

const hostname = process.env.E2E_HOST;
const port = Number(process.env.E2E_PORT);
const controlPort = Number(process.env.E2E_CONTROL_PORT);
const tlsDir = process.env.E2E_TLS_DIR;
if (!hostname || !port || !controlPort || !tlsDir) {
  throw new Error(
    "Run through `npm run test:e2e` (E2E_HOST, E2E_PORT, E2E_CONTROL_PORT and E2E_TLS_DIR are required).",
  );
}
const jitterMs = Number(process.env.E2E_SLOW_JITTER_MS ?? 0);
const delayEndMs = Number(process.env.E2E_DELAY_END_MS ?? 0);

const app = next({ dev: false, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();

const tracker = createRequestTracker();
const server = createServer(
  { key: readFileSync(join(tlsDir, "key.pem")), cert: readFileSync(join(tlsDir, "cert.pem")) },
  (req, res) => {
    tracker.track(res);
    if (delayEndMs > 0 && req.method === "POST") {
      const end = res.end.bind(res);
      res.end = (...args) => {
        if (!res.headersSent) return end(...args);
        setTimeout(() => end(...args), delayEndMs);
        return res;
      };
    }
    if (jitterMs > 0 && req.method === "GET")
      setTimeout(() => handle(req, res), Math.random() * jitterMs);
    else handle(req, res);
  },
);
if (process.env.E2E_DIAG === "1") (await import("./harness/diag.mjs")).installDiag(server);
server.listen(port, hostname, () => console.log(`E2E server ready on https://${hostname}:${port}`));

const control = createHttpServer((req, res) => {
  if (req.method === "GET" && req.url === "/in-flight") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ inFlight: tracker.inFlight() }));
  } else {
    res.statusCode = 404;
    res.end();
  }
});
control.listen(controlPort, "127.0.0.1");

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  control.close();
  server.close(() => process.exit(0)); // also closes idle keep-alive connections
  setTimeout(() => {
    server.closeAllConnections();
    process.exit(0);
  }, 3000).unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
