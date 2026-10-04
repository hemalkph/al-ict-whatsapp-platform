// Serves the REAL production build (`next build` output, NODE_ENV=production) over HTTPS for the E2E run, using Next's
// documented custom-server API and the throwaway certificate created by scripts/e2e.ts. A custom server is needed
// only because production requires an https BETTER_AUTH_URL and `next start` cannot serve https. It adds no routes,
// headers or behavior to the application's own port.
//
// Harness-only extras (never part of the application):
//  - a second listener on 127.0.0.1:E2E_CONTROL_PORT (plain http) whose only endpoint, GET /in-flight, reports how many
//    requests the application is still handling. The tests wait for it to read 0 before closing a page or abandoning a
//    navigation: a browser that cancels a request the server is still working on makes Node abort that request, and
//    Next logs it as `Error: aborted` / `ECONNRESET`. That is a harness ordering problem, so it is fixed here by
//    ordering, never by filtering the log.
//  - E2E_SLOW_JITTER_MS: delays each GET by a random 0..N ms to emulate a slow CI runner (used to prove the ordering
//    fix; unset in CI).
//  - graceful shutdown on SIGTERM (Playwright sends it after the browsers are closed).
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";
import next from "next";

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

const app = next({ dev: false, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();

// A request is in flight from the moment its headers arrive until BOTH its request stream and its response have closed.
let inFlight = 0;
const server = createServer(
  { key: readFileSync(join(tlsDir, "key.pem")), cert: readFileSync(join(tlsDir, "cert.pem")) },
  (req, res) => {
    inFlight++;
    let open = 2;
    const closed = () => {
      if (--open === 0) inFlight--;
    };
    req.once("close", closed);
    res.once("close", closed);
    if (jitterMs > 0 && req.method === "GET")
      setTimeout(() => handle(req, res), Math.random() * jitterMs);
    else handle(req, res);
  },
);
server.listen(port, hostname, () => console.log(`E2E server ready on https://${hostname}:${port}`));

const control = createHttpServer((req, res) => {
  if (req.method === "GET" && req.url === "/in-flight") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ inFlight }));
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
