import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestTracker } from "../e2e/harness/tracker.mjs";
import { serverIdle } from "../e2e/support/settle";
import { SERVER_ERROR_PATTERN, flaggedServerLines } from "./e2e-log";

// The E2E harness is part of the safety net, so it has its own tests: the in-flight counter must never leak or report
// idle while work is outstanding, the idle poll must need two consecutive zero readings, and the server-log check must
// keep failing the run for real errors (including the exact log of the CI failure this suite once produced).

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("request tracker", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections();
            s.close(() => resolve());
          }),
      ),
    );
  });

  async function start(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const tracker = createRequestTracker();
    const server = createServer((req, res) => {
      tracker.track(res);
      handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { tracker, port };
  }

  const get = (port: number) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", agent: false });
    req.on("error", () => undefined);
    req.end();
    return req;
  };

  it("counts a request until its response has finished, and stays above zero while any response is outstanding", async () => {
    const pending: ServerResponse[] = [];
    const { tracker, port } = await start((_req, res) => void pending.push(res));
    expect(tracker.inFlight()).toBe(0);
    for (let i = 0; i < 5; i++) get(port);
    await until(() => tracker.inFlight() === 5);
    for (let i = 0; i < 4; i++) pending[i]!.end("done");
    await until(() => tracker.inFlight() === 1);
    await pause(60);
    expect(tracker.inFlight()).toBe(1); // never drops to zero while one answer is still owed
    pending[4]!.end("done");
    await until(() => tracker.inFlight() === 0);
  });

  it("does not leak when the client leaves before any response", async () => {
    const { tracker, port } = await start(() => undefined); // never answers
    const requests = [get(port), get(port), get(port)];
    await until(() => tracker.inFlight() === 3);
    requests.forEach((r) => r.destroy());
    await until(() => tracker.inFlight() === 0);
  });

  it("does not leak when the client leaves in the middle of a response", async () => {
    const { tracker, port } = await start((_req, res) => {
      res.write("first chunk");
      // the response is never ended
    });
    const req = get(port);
    await until(() => tracker.inFlight() === 1);
    req.destroy();
    await until(() => tracker.inFlight() === 0);
  });

  it("does not leak after an early refusal that closes the connection with the request body unread (the oversize 413 case)", async () => {
    const { tracker, port } = await start((_req, res) => {
      res.statusCode = 413;
      res.setHeader("connection", "close");
      res.end();
    });
    for (let i = 0; i < 5; i++) {
      const req = httpRequest({ host: "127.0.0.1", port, method: "POST", agent: false });
      req.on("error", () => undefined);
      req.write(Buffer.alloc(256 * 1024));
      req.end(Buffer.alloc(256 * 1024));
    }
    await until(() => tracker.inFlight() === 0);
    await pause(100);
    expect(tracker.inFlight()).toBe(0);
  });

  it("returns to exactly zero after many completed, abandoned and aborted requests", async () => {
    let n = 0;
    const { tracker, port } = await start((_req, res) => {
      n++;
      if (n % 3 === 0) return; // never answered; the client abandons it
      if (n % 3 === 1) res.end("ok");
      else res.write("partial"); // abandoned mid-response
    });
    const all: ReturnType<typeof get>[] = [];
    for (let i = 0; i < 60; i++) all.push(get(port));
    await pause(150);
    all.forEach((r) => r.destroy());
    await until(() => tracker.inFlight() === 0);
    await pause(50);
    expect(tracker.inFlight()).toBe(0);
  });

  it("never counts the same response twice, and ignores a response that is already gone", () => {
    const tracker = createRequestTracker();
    let closeHandler: (() => void) | undefined;
    const res = {
      destroyed: false,
      once: (_event: string, handler: () => void) => void (closeHandler = handler),
    };
    tracker.track(res as never);
    expect(tracker.inFlight()).toBe(1);
    closeHandler!();
    closeHandler!(); // a duplicate close must not drive the count negative
    expect(tracker.inFlight()).toBe(0);
    tracker.track({ destroyed: true, once: () => undefined } as never);
    expect(tracker.inFlight()).toBe(0);
  });

  describe("serverIdle (the test side of the counter)", () => {
    async function controlServer(readings: () => number) {
      const server = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ inFlight: readings() }));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      process.env.E2E_CONTROL_PORT = String((server.address() as AddressInfo).port);
    }
    afterEach(() => {
      delete process.env.E2E_CONTROL_PORT;
    });

    it("needs two consecutive zero readings: a single zero between busy readings is not idle", async () => {
      const script = [3, 0, 2, 0, 1, 0, 0, 5];
      let reads = 0;
      await controlServer(() => script[Math.min(reads++, script.length - 1)]!);
      await serverIdle(5000);
      expect(reads).toBe(7); // returned at the first pair of zeros, not at the earlier single zeros
    });

    it("fails (it does not pretend to be idle) while the server keeps reporting work", async () => {
      await controlServer(() => 1);
      await expect(serverIdle(300)).rejects.toThrow(/still has 1 request\(s\) in flight/);
    });

    it("is tied to a real tracker: not idle while a response is outstanding, idle once it ends", async () => {
      const tracker = createRequestTracker();
      const held: ServerResponse[] = [];
      const app = createServer((_req, res) => {
        tracker.track(res);
        held.push(res);
      });
      servers.push(app);
      await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
      await controlServer(() => tracker.inFlight());
      get((app.address() as AddressInfo).port);
      await until(() => tracker.inFlight() === 1);
      await expect(serverIdle(250)).rejects.toThrow(/in flight/);
      held[0]!.end("done");
      await serverIdle(2000);
      expect(tracker.inFlight()).toBe(0);
    });

    it("requires the control port", async () => {
      await expect(serverIdle(50)).rejects.toThrow(/E2E_CONTROL_PORT/);
    });
  });
});

describe("server log check (what makes an E2E run fail)", () => {
  // The exact server output of the failing GitHub Actions run (run 37733238526, 05:38:14.722Z), unchanged.
  const ORIGINAL_CI_FAILURE = [
    "[WebServer] Error: aborted",
    "[WebServer]     at ignore-listed frames {",
    "[WebServer]   code: 'ECONNRESET'",
    "[WebServer] }",
    "[WebServer] \u2a2f uncaughtException:  Error: aborted",
    "[WebServer]     at ignore-listed frames {",
    "[WebServer]   code: 'ECONNRESET'",
    "[WebServer] }",
  ];

  it("still flags the original failure: Error: aborted / ECONNRESET / uncaughtException are NOT filtered", () => {
    expect(flaggedServerLines(ORIGINAL_CI_FAILURE)).toEqual([0, 2, 4, 6]);
    for (const line of [
      "[WebServer] Error: aborted",
      "[WebServer]   code: 'ECONNRESET'",
      "[WebServer] \u2a2f uncaughtException:  Error: aborted",
    ])
      expect(SERVER_ERROR_PATTERN.test(line), line).toBe(true);
  });

  it("flags genuine unexpected server errors of every kind, so a broken application request cannot hide", () => {
    for (const line of [
      '[WebServer] Error: relation "nope" does not exist',
      "[WebServer] \u2a2f Error: something broke while rendering",
      "[WebServer] TypeError: Cannot read properties of undefined (reading 'x')",
      "[WebServer] ReferenceError: x is not defined",
      "[WebServer] RangeError: Invalid array length",
      "[WebServer] \u2a2f unhandledRejection: Error: boom",
      "[WebServer] error: terminating connection due to administrator command 57P01",
      '[WebServer] {"level":"error","message":"webhook","webhook_event":"webhook.ingest_failed"}',
      "[WebServer] ECONNRESET",
    ])
      expect(SERVER_ERROR_PATTERN.test(line), line).toBe(true);
  });

  it("does not flag the expected, deliberately provoked 4xx security and webhook events", () => {
    const quiet = [
      "E2E server ready on https://127.0.0.1:3100",
      '[WebServer] {"level":"warn","message":"security event","time":"2026-10-08T05:38:15.244Z","security_event":"auth.login_failed","outcome":"failure","reason":"http_401","email_hash":"d3355cd8fe5bd81f"}',
      '[WebServer] {"level":"warn","message":"security event","security_event":"access.permission_denied","outcome":"denied"}',
      '[WebServer] {"level":"warn","message":"security event","security_event":"access.cross_origin_rejected","outcome":"denied","reason":"origin_mismatch"}',
      '[WebServer] {"level":"warn","message":"webhook","webhook_event":"webhook.verification_failed","outcome":"denied","reason":"token_mismatch"}',
      '[WebServer] {"level":"warn","message":"webhook","webhook_event":"webhook.signature_invalid","outcome":"denied"}',
      "[WebServer] 2026-10-08T05:38:15.243Z WARN [Better Auth]: User not found",
    ];
    expect(flaggedServerLines(quiet)).toEqual([]);
  });

  it("reports the position of every offending line", () => {
    expect(flaggedServerLines(["fine", "Error: x", "fine", "fine", "uncaught"])).toEqual([1, 4]);
    expect(flaggedServerLines([])).toEqual([]);
  });
});
