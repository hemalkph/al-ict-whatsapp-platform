// Counts the requests an HTTP(S) server is currently answering (harness only; see e2e/server.mjs and support/settle.ts).
//
// A request is counted from the moment its headers have been parsed until its RESPONSE has closed: either it finished,
// or the client went away. Only the response matters here. (The request stream is deliberately not tracked: after an
// early refusal, such as an oversize 413 sent with `Connection: close`, the request stream never emits `close`, which
// would leak the count.) Note what this means: "zero" says no client is still waiting for an answer. It does NOT say
// the application has finished all of its own work for a request whose client already left.
export function createRequestTracker() {
  let inFlight = 0;
  return {
    inFlight: () => inFlight,
    /** Call once per request, from the server's `request` listener. */
    track(res) {
      if (res.destroyed) return; // already gone: `close` would never fire again
      inFlight++;
      let counted = true;
      res.once("close", () => {
        if (counted) {
          counted = false;
          inFlight--;
        }
      });
    },
  };
}
