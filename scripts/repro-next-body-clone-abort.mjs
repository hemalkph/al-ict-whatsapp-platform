// Re-check of a Next.js behavior (docs/PRE_PRODUCTION_BLOCKERS.md, item 20). Run: node scripts/repro-next-body-clone-abort.mjs
//
// It mimics what next-server.js does for a request that passes the proxy and is not GET/HEAD: the router registers a
// no-op `error` listener, the body is cloned for the proxy, and after the proxy returns `finalize()` copies the clone's
// stream internals onto the request. Then the client disconnects while the route is still working.
//
// Expected with Next 16.3.8: "abort after finalize, body unread" prints UNCAUGHT ECONNRESET aborted; every other case
// is clean. If that line disappears after a Next upgrade, the behavior was fixed and item 20 can be closed.
import http from "node:http";
import { createRequire } from "node:module";

// Next's internal module is CommonJS and not part of its public API: this script exists to watch exactly that internal.
const { getCloneableBody } = createRequire(import.meta.url)("next/dist/server/body-streams.js");

const log = (...parts) => console.log(...parts);

function scenario(abortAt, handlerReadsBody) {
  return new Promise((resolve) => {
    const result = { abortAt, handlerReadsBody, uncaught: false };
    const onUncaught = (error) => {
      if (error && error.code === "ECONNRESET") result.uncaught = true;
    };
    process.on("uncaughtException", onUncaught);
    const server = http.createServer(async (req, res) => {
      req.on("error", () => {}); // router-server.js: req.on('error', noop)
      const body = getCloneableBody(req);
      body.cloneBodyStream(); // the proxy stage consumes a clone
      await new Promise((r) => setTimeout(r, 40)); // the proxy runs
      await body.finalize();
      if (handlerReadsBody) for await (const chunk of req) void chunk;
      await new Promise((r) => setTimeout(r, 200)); // the route handler works
      res.end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http.request({
        port: server.address().port,
        host: "127.0.0.1",
        method: "POST",
        headers: { "content-length": 2 },
      });
      client.on("error", () => {});
      client.write("{}");
      client.end();
      if (abortAt === "before-finalize") setTimeout(() => client.destroy(), 10);
      if (abortAt === "after-finalize") setTimeout(() => client.destroy(), 120);
      setTimeout(() => {
        process.off("uncaughtException", onUncaught);
        server.close();
        resolve(result);
      }, 500);
    });
  });
}

(async () => {
  for (const abortAt of ["never", "before-finalize", "after-finalize"]) {
    for (const handlerReadsBody of [false, true]) {
      const r = await scenario(abortAt, handlerReadsBody);
      log(
        `abort=${r.abortAt.padEnd(15)} handler reads body=${String(r.handlerReadsBody).padEnd(5)} ->`,
        r.uncaught ? "UNCAUGHT ECONNRESET aborted" : "clean",
      );
    }
  }
})();
