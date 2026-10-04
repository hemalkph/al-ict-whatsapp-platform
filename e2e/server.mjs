// Serves the REAL production build (`next build` output, NODE_ENV=production) over HTTPS for the E2E run, using Next's
// documented custom-server API and the throwaway certificate created by scripts/e2e.ts. A custom server is needed
// only because production requires an https BETTER_AUTH_URL and `next start` cannot serve https. It adds no routes,
// headers or behavior of its own.
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import next from "next";

const hostname = process.env.E2E_HOST;
const port = Number(process.env.E2E_PORT);
const tlsDir = process.env.E2E_TLS_DIR;
if (!hostname || !port || !tlsDir) {
  throw new Error(
    "Run through `npm run test:e2e` (E2E_HOST, E2E_PORT and E2E_TLS_DIR are required).",
  );
}

const app = next({ dev: false, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer(
  { key: readFileSync(join(tlsDir, "key.pem")), cert: readFileSync(join(tlsDir, "cert.pem")) },
  (req, res) => handle(req, res),
);
server.listen(port, hostname, () => console.log(`E2E server ready on https://${hostname}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
