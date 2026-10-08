// Opt-in request timeline for investigating E2E server errors (E2E_DIAG=1; off by default and in CI). Privacy-safe by construction: it records request
// ids, methods, sanitized route patterns (path only: no query string, no ids), timings and socket ids. It never reads
// headers' values, cookies, bodies, or any WhatsApp content.
export function installDiag(server) {
  let seq = 0;
  let sockSeq = 0;
  const sockIds = new WeakMap();
  const live = new Map();
  const recent = [];
  const route = (url = "") =>
    url
      .split("?")[0]
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":uuid")
      .replace(/\/\d{6,}/g, "/:n");
  const brief = (r) => ({
    id: r.id,
    sock: r.sock,
    m: r.m,
    r: r.r,
    body: r.body,
    ageMs: Date.now() - r.t0,
    aborted: r.aborted,
    closedAfterMs: r.closed,
    finished: r.finished,
    status: r.status,
    reqComplete: r.reqComplete,
  });
  const emit = (kind, data) =>
    console.log(`[DIAG] ${new Date().toISOString()} ${kind} ${JSON.stringify(data)}`);

  server.on("secureConnection", (tls) => {
    const id = ++sockSeq;
    sockIds.set(tls, id);
    emit("socket_open", { sock: id });
    tls.once("close", () => {
      const open = [...live.values()].filter((r) => r.sock === id).map(brief);
      emit("socket_close", { sock: id, unfinished: open });
    });
  });

  server.prependListener("request", (req, res) => {
    const rec = {
      id: ++seq,
      sock: sockIds.get(req.socket),
      m: req.method,
      r: route(req.url),
      t0: Date.now(),
      body:
        req.headers["content-length"] !== undefined ||
        req.headers["transfer-encoding"] !== undefined,
    };
    live.set(rec.id, rec);
    emit("req_start", { id: rec.id, sock: rec.sock, m: rec.m, r: rec.r, body: rec.body });
    req.once("aborted", () => {
      rec.aborted = Date.now() - rec.t0;
      emit("req_aborted", brief(rec));
    });
    res.once("close", () => {
      rec.closed = Date.now() - rec.t0;
      rec.finished = res.writableFinished;
      rec.status = res.statusCode;
      rec.reqComplete = req.complete;
      live.delete(rec.id);
      recent.push(rec);
      if (recent.length > 300) recent.shift();
      if (!rec.finished || rec.aborted !== undefined) emit("res_closed_early", brief(rec));
      else emit("res_done", { id: rec.id, status: rec.status, ms: rec.closed });
    });
  });

  process.on("uncaughtException", (err) => {
    emit("UNCAUGHT", {
      code: err?.code,
      message: err?.message,
      stack: String(err?.stack).split("\n").slice(0, 14),
      live: [...live.values()].map(brief),
      recentEarly: recent
        .filter((r) => !r.finished || r.aborted !== undefined)
        .slice(-5)
        .map(brief),
    });
  });
}
