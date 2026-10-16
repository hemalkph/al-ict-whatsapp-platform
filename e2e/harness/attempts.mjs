// Per-attempt evidence for the E2E harness (never part of the application): which status the SERVER answered a specific
// request with. A test marks a request with `x-e2e-attempt: <id>`; when that response closes, the status the server actually
// wrote is recorded (null if it closed without sending headers) and served on the control port (GET /attempts/<id>).
//
// Why: a client uploading a large body can lose the server's early answer to a connection reset (EPIPE / ECONNRESET). The
// client's error then proves nothing about the server; this record says what the server did with THAT request. The header is
// read here only, after the TLS server parsed the request; the application never sees a difference in behavior.
const ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX = 10_000;

export function createAttemptLog() {
  const attempts = new Map();
  return {
    /** Call once per request, from the server's `request` listener. */
    track(req, res) {
      const id = req.headers["x-e2e-attempt"];
      if (typeof id !== "string" || !ID.test(id)) return;
      res.once("close", () => {
        if (attempts.size >= MAX) attempts.delete(attempts.keys().next().value);
        attempts.set(id, { status: res.headersSent ? res.statusCode : null });
      });
    },
    /** The recorded outcome of an attempt, or undefined while (or if never) seen. */
    get: (id) => attempts.get(id),
  };
}
