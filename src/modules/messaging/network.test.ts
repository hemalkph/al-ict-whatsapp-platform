import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MetaTransport, postToMeta, singleAttemptPost } from "./meta-transport";
import { HttpAttemptError, type SendRequest } from "./transport";

// The ACTUAL HTTP implementation against REAL local sockets (loopback only; Meta is never contacted). The properties: one
// logical send puts at most ONE POST on the wire; nothing is replayed, redirected or retried by the transport; every
// uncertain outcome is UNKNOWN. These tests exist because Node's fetch was observed to replay a POST internally (a 421
// answer, then a second connection attempt whose ECONNREFUSED became the reported error), which a fake `fetch` cannot show.

type Seen = {
  posts: number;
  connections: number;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;
};
type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  server: http.Server,
) => void;

const servers: http.Server[] = [];
const sockets = new Set<Socket>();
afterEach(() => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  for (const s of servers.splice(0)) s.close();
});

async function serve(handler: Handler) {
  const seen: Seen = { posts: 0, connections: 0, requests: [] };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method === "POST") seen.posts++;
      seen.requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      handler(req, res, body, server);
    });
  });
  server.on("connection", (s) => {
    seen.connections++;
    sockets.add(s);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { seen, port, server };
}

const TOKEN = "EAAB-test-token-0123456789abcdef";
const live = {
  WHATSAPP_OUTBOUND_ENABLED: "true",
  WHATSAPP_LIVE_SEND_ENABLED: "true",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
  WA_TOKEN: TOKEN,
};
const text: SendRequest = {
  phoneNumberId: "123456789012345",
  credentialRef: "WA_TOKEN",
  recipient: { kind: "PHONE", id: "94771234567" },
  message: { type: "text", body: "Hello සිංහල", replyToWamid: null },
};
const transportTo = (port: number, timeoutMs = 2_000, hostname = "127.0.0.1") =>
  new MetaTransport({
    env: () => live,
    post: singleAttemptPost(
      http.request,
      { protocol: "http:", hostname, port },
      { timeoutMs, maxBytes: 64 * 1024 },
    ),
  });
const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

describe("single-attempt transport against real sockets", () => {
  it("sends exactly the documented request (path, method, headers, JSON body) over one connection and returns the answer", async () => {
    const { seen, port } = await serve((_req, res) =>
      json(res, 200, { messages: [{ id: "wamid.REAL1" }] }),
    );
    const result = await transportTo(port).send(text, new AbortController().signal);
    expect(result).toMatchObject({ kind: "accepted", wamid: "wamid.REAL1" });
    expect(seen.posts).toBe(1);
    expect(seen.connections).toBe(1);
    const [r] = seen.requests;
    expect(r!.method).toBe("POST");
    expect(r!.url).toBe("/v25.0/123456789012345/messages");
    expect(r!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r!.headers["content-type"]).toBe("application/json");
    expect(r!.headers.connection).toBe("close"); // a fresh connection per attempt, no keep-alive reuse
    expect(Number(r!.headers["content-length"])).toBe(Buffer.byteLength(r!.body));
    expect(JSON.parse(r!.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "94771234567",
      type: "text",
      text: { body: "Hello සිංහල" },
    });
    expect(r!.url).not.toContain(TOKEN);
  });

  it("THE REPRODUCED DEFECT: a complete POST answered with HTTP 421, then the listener is gone. One POST, one connection, no replay; the answer is UNKNOWN", async () => {
    const { seen, port } = await serve((_req, res, _b, server) => {
      json(res, 421, {});
      server.close(); // any further connection attempt is refused (this is what native fetch ran into)
    });
    const result = await transportTo(port).send(text, new AbortController().signal);
    await settle();
    expect(result).toMatchObject({ kind: "unknown", httpStatus: 421 });
    expect(seen.posts).toBe(1);
    expect(seen.connections).toBe(1);
    expect(seen.requests).toHaveLength(1);
  });

  it.each([
    [307, "307 Temporary Redirect"],
    [308, "308 Permanent Redirect"],
  ])(
    "HTTP %i is not followed: UNKNOWN after one POST, the Location is never requested",
    async (status) => {
      const { seen, port } = await serve((_req, res) => {
        res.writeHead(status, { location: "/elsewhere" });
        res.end();
      });
      const result = await transportTo(port).send(text, new AbortController().signal);
      await settle();
      expect(result).toMatchObject({
        kind: "unknown",
        reason: "unexpected_status",
        httpStatus: status,
      });
      expect(seen.requests).toHaveLength(1);
      expect(seen.connections).toBe(1);
    },
  );

  it("a redirect to another host is not followed either, and the bearer token goes nowhere else", async () => {
    const other = await serve((_req, res) => json(res, 200, { messages: [{ id: "wamid.EVIL" }] }));
    const { seen, port } = await serve((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${other.port}/steal` });
      res.end();
    });
    const result = await transportTo(port).send(text, new AbortController().signal);
    await settle();
    expect(result.kind).toBe("unknown");
    expect(seen.posts).toBe(1);
    expect(other.seen.requests).toHaveLength(0);
    expect(other.seen.connections).toBe(0);
  });

  it.each([
    [
      "429 with a documented rate code",
      429,
      { error: { code: 130429 } },
      "rate_limited_semantics_unverified",
    ],
    ["a bare 429", 429, "", "rate_limit_unrecognized"],
    [
      "429 with success-shaped data",
      429,
      { error: { code: 130429 }, messages: [{ id: "x1" }] },
      "contradictory_error_response",
    ],
    ["HTTP 500", 500, { error: { code: 131000 } }, "provider_server_error"],
    ["HTTP 503", 503, "", "provider_server_error"],
    ["a malformed 200", 200, "{ not json", "malformed_success_response"],
    ["a 200 without an id", 200, { messages: [] }, "malformed_success_response"],
  ])(
    "%s: UNKNOWN after exactly one POST on one connection",
    async (_name, status, body, reason) => {
      const { seen, port } = await serve((_req, res) => json(res, status, body));
      const result = await transportTo(port).send(text, new AbortController().signal);
      await settle();
      expect(result).toMatchObject({ kind: "unknown", reason, httpStatus: status });
      expect(seen.posts).toBe(1);
      expect(seen.connections).toBe(1);
    },
  );

  it("a documented rejection is REJECTED after one POST", async () => {
    const { seen, port } = await serve((_req, res) => json(res, 400, { error: { code: 100 } }));
    const result = await transportTo(port).send(text, new AbortController().signal);
    expect(result).toMatchObject({ kind: "rejected", reason: "invalid_request" });
    expect(seen.posts).toBe(1);
  });

  it("an oversized response is cut off safely: UNKNOWN, one POST", async () => {
    const { seen, port } = await serve((_req, res) => json(res, 200, "x".repeat(200_000)));
    const result = await transportTo(port).send(text, new AbortController().signal);
    expect(result).toMatchObject({ kind: "unknown", reason: "malformed_success_response" });
    expect(seen.posts).toBe(1);
  });

  it("no response before the deadline: UNKNOWN (timeout) after one POST, and the request is not re-sent", async () => {
    const { seen, port } = await serve(() => undefined); // received, never answered
    const started = Date.now();
    const result = await transportTo(port, 300).send(text, new AbortController().signal);
    await settle();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result).toEqual({ kind: "unknown", reason: "transport_timeout", httpStatus: null });
    expect(seen.posts).toBe(1);
    expect(seen.connections).toBe(1);
  });

  it("a connection reset AFTER the request was received: UNKNOWN after one POST", async () => {
    const { seen, port } = await serve((req) => req.socket.destroy());
    const result = await transportTo(port).send(text, new AbortController().signal);
    await settle();
    expect(result).toMatchObject({ kind: "unknown", httpStatus: null });
    expect(seen.posts).toBe(1);
    expect(seen.connections).toBe(1);
  });

  it("a response that breaks off half way: UNKNOWN after one POST", async () => {
    const { seen, port } = await serve((req, res) => {
      res.writeHead(200, { "content-length": "500", "content-type": "application/json" });
      res.write('{"messages":[');
      setTimeout(() => req.socket.destroy(), 20);
    });
    const result = await transportTo(port).send(text, new AbortController().signal);
    expect(result).toMatchObject({ kind: "unknown", reason: "transport_response_incomplete" });
    expect(seen.posts).toBe(1);
  });

  it("connection refused: UNKNOWN, never not_sent (an error code proves nothing about the whole operation)", async () => {
    const { port, server } = await serve(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await transportTo(port).send(text, new AbortController().signal);
    expect(result).toEqual({ kind: "unknown", reason: "transport_network", httpStatus: null });
  });

  it("a name that does not resolve (the reserved .invalid TLD): UNKNOWN", async () => {
    const result = await transportTo(9, 3_000, "no-such-host.invalid").send(
      text,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ kind: "unknown", httpStatus: null });
  });

  it("an abort during transmission: UNKNOWN (aborted) after one POST", async () => {
    const received = Promise.withResolvers<void>();
    const { seen, port } = await serve(() => received.resolve()); // received, never answered
    const controller = new AbortController();
    const sending = transportTo(port, 5_000).send(text, controller.signal);
    await received.promise;
    controller.abort();
    expect(await sending).toEqual({
      kind: "unknown",
      reason: "transport_aborted",
      httpStatus: null,
    });
    expect(seen.posts).toBe(1);
  });

  it("tells the caller before it begins, never when it refuses", async () => {
    const { port } = await serve((_req, res) =>
      json(res, 200, { messages: [{ id: "wamid.HOOK" }] }),
    );
    let started = 0;
    await transportTo(port).send(text, new AbortController().signal, {
      httpStarted: () => started++,
    });
    expect(started).toBe(1);
    const offline = new MetaTransport({
      env: () => ({ ...live, WHATSAPP_LIVE_SEND_ENABLED: "no" }),
      post: singleAttemptPost(http.request, { protocol: "http:", hostname: "127.0.0.1", port }),
    });
    expect(
      await offline.send(text, new AbortController().signal, { httpStarted: () => started++ }),
    ).toMatchObject({ kind: "not_sent" });
    expect(started).toBe(1);
  });
});

describe("what the transport cannot be pointed at", () => {
  it("the destination is fixed when the post function is built; the URL's host is ignored and only its path is used", async () => {
    const { seen, port } = await serve((_req, res) =>
      json(res, 200, { messages: [{ id: "wamid.FIXED" }] }),
    );
    const post = singleAttemptPost(http.request, {
      protocol: "http:",
      hostname: "127.0.0.1",
      port,
    });
    const out = await post("https://attacker.example:9999/v25.0/1/messages", {
      headers: {},
      body: "{}",
      signal: new AbortController().signal,
    });
    expect(out.status).toBe(200);
    expect(seen.requests[0]!.url).toBe("/v25.0/1/messages");
  });

  it.each([
    "https://evil.example/v25.0/1/messages",
    "https://graph.facebook.com.evil.example/v25.0/1/messages",
    "http://graph.facebook.com/v25.0/1/messages",
    "https://graph.facebook.com:8443/v25.0/1/messages",
    "https://user:pw@graph.facebook.com/v25.0/1/messages",
    "not a url",
  ])("the production implementation refuses %s without any network use", async (url) => {
    await expect(
      postToMeta(url, { headers: {}, body: "{}", signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(HttpAttemptError);
  });

  const haveOpenssl = (() => {
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!haveOpenssl)(
    "TLS verification stays on: a server with an untrusted certificate is never sent the request",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "al-ict-tls-"));
      try {
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            join(dir, "k.pem"),
            "-out",
            join(dir, "c.pem"),
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost",
          ],
          { stdio: "ignore" },
        );
        let handled = 0;
        const server = https.createServer(
          { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) },
          (_req, res) => {
            handled++;
            res.end("{}");
          },
        );
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
          const port = (server.address() as AddressInfo).port;
          const post = singleAttemptPost(https.request, {
            protocol: "https:",
            hostname: "localhost",
            port,
          });
          await expect(
            post("https://graph.facebook.com/v25.0/1/messages", {
              headers: {},
              body: "{}",
              signal: new AbortController().signal,
            }),
          ).rejects.toBeInstanceOf(HttpAttemptError);
          expect(handled).toBe(0); // the handshake failed before any HTTP request reached the application
        } finally {
          server.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
