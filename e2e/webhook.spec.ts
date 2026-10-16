import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:tls";
import { expect, test } from "./support/fixtures";
import { webhookDelivery } from "./support/db";

// The Meta webhook through the REAL production server over HTTPS and the REAL proxy. Unit and database tests cannot show
// that Next.js hands the route the exact request bytes, or that the proxy leaves this path alone. A cookie-less client
// stands in for Meta (the endpoint is public by design: it authenticates by token and signature).

const URL_PATH = "/api/webhooks/whatsapp";
const secret = process.env.E2E_META_APP_SECRET!;
const token = process.env.E2E_WEBHOOK_VERIFY_TOKEN!;
const sign = (bytes: Uint8Array) =>
  `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fixture = (name: string) => readFileSync(`src/modules/whatsapp/__fixtures__/${name}`);
const headers = (signature: string | null) => ({
  "content-type": "application/json",
  ...(signature ? { "x-hub-signature-256": signature } : {}),
});

// A unique, valid delivery for a phone number no account is configured for: it is stored and held as UNROUTABLE.
const unroutable = () =>
  Buffer.from(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "200000000000777",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550100777",
                  phone_number_id: "100000000000777",
                },
                messages: [
                  {
                    from: "15550100123",
                    id: `wamid.E2E${Date.now()}${Math.random()}`,
                    timestamp: "1790000000",
                    type: "text",
                    text: { body: "e2e" },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  );

/** What the SERVER answered the request marked `x-e2e-attempt: <id>` (test harness record; e2e/harness/attempts.mjs). */
async function serverAnswer(
  attempt: string,
  waitMs: number,
): Promise<{ status: number | null } | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${process.env.E2E_CONTROL_PORT}/attempts/${attempt}`);
    if (res.ok) return (await res.json()) as { status: number | null };
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The oversize verdict for ONE attempt. The server refuses from the declared length, before reading the body, and closes the
 * connection (`Connection: close`, handler.ts), so a client still uploading 4 MiB can lose the 413 to a reset (EPIPE /
 * ECONNRESET: closing a socket with unread inbound data resets it, and the reset discards what the client had not read; RFC 9112
 * section 9.6). The client's error alone proves nothing (it can come from anywhere, even before anything was sent), so the
 * evidence is always the server's own answer to THIS attempt, recorded by the harness: it must be 413 (413 comes only from the
 * size guard). Passes as "413" (the client read it too) or "reset-after-413"; anything else fails.
 */
async function judgeOversize(attempt: string, send: () => Promise<number>): Promise<string> {
  const sent = await send().then(
    (status) => ({ status }),
    (error: Error) => ({ error }),
  );
  if ("error" in sent && !/\b(EPIPE|ECONNRESET)\b/.test(sent.error.message)) throw sent.error;
  // the record is written when the response closes, right after the answer; 3 s bounds the wait when there is none
  const server = await serverAnswer(attempt, 3000);
  if (server?.status !== 413)
    throw new Error(
      `no 413 from the server is recorded for this attempt (server: ${JSON.stringify(server)}, client: ${
        "error" in sent ? sent.error.message : sent.status
      })`,
    );
  if ("status" in sent) {
    expect(sent.status).toBe(413);
    return "413";
  }
  return "reset-after-413";
}

test.describe("Meta webhook endpoint", () => {
  test("GET verification: the right token returns the challenge as text/plain, a wrong one is 403 (not a proxy 401)", async ({
    request,
  }) => {
    const ok = await request.get(
      `${URL_PATH}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=987654321`,
    );
    expect(ok.status()).toBe(200);
    expect(await ok.text()).toBe("987654321");
    expect(ok.headers()["content-type"]).toContain("text/plain");
    expect(ok.headers()["x-content-type-options"]).toBe("nosniff");

    const wrong = await request.get(
      `${URL_PATH}?hub.mode=subscribe&hub.verify_token=${"x".repeat(46)}&hub.challenge=1`,
    );
    expect(wrong.status()).toBe(403);
    expect(await wrong.text()).toBe("");
  });

  test("a signed POST with no session cookie is accepted and stored by the real server (the proxy does not touch it)", async ({
    request,
  }) => {
    const body = unroutable();
    const res = await request.post(URL_PATH, { data: body, headers: headers(sign(body)) });
    expect(res.status()).toBe(200); // not 401: src/proxy.ts would have answered a cookie-less /api request with 401
    const [stored] = await webhookDelivery(sha(body));
    expect(stored).toBeDefined();
    expect(stored!.ingest_status).toBe("ACCEPTED");
    expect(stored!.events).toBe(1);
    expect(stored!.event_status).toBe("UNROUTABLE");
    expect(stored!.event_reason).toBe("unknown_account");
    expect(Buffer.compare(stored!.raw_body, body)).toBe(0);
  });

  test("the exact bytes survive the real Next.js server, including literal UTF-8 Sinhala, byte for byte", async ({
    request,
  }) => {
    const literal = fixture("text-sinhala-raw-utf8.json");
    const res = await request.post(URL_PATH, { data: literal, headers: headers(sign(literal)) });
    expect(res.status()).toBe(200);
    const [stored] = await webhookDelivery(sha(literal));
    expect(stored).toBeDefined();
    expect(Buffer.compare(stored!.raw_body, literal)).toBe(0);
  });

  test("a signature over the escaped form does not validate the literal bytes (and the reverse), and stores nothing", async ({
    request,
  }) => {
    const literal = fixture("text-sinhala-raw-utf8.json");
    const escaped = fixture("text-sinhala-escaped.json");
    const a = await request.post(URL_PATH, { data: literal, headers: headers(sign(escaped)) });
    const b = await request.post(URL_PATH, { data: escaped, headers: headers(sign(literal)) });
    expect([a.status(), b.status()]).toEqual([403, 403]);
    // each is stored only if it was ever validly signed; the escaped form was never validly delivered in this run
    expect(await webhookDelivery(sha(escaped))).toHaveLength(0);
  });

  test("missing and wrong signatures are 403 and store nothing", async ({ request }) => {
    const body = unroutable();
    for (const signature of [null, "sha256=zz", sign(Buffer.from("different bytes"))]) {
      const res = await request.post(URL_PATH, { data: body, headers: headers(signature) });
      expect(res.status()).toBe(403);
    }
    expect(await webhookDelivery(sha(body))).toHaveLength(0);
  });

  test("a body over 4 MiB is refused with 413: the client reads it, or the SERVER's 413 for this very request is on record", async ({
    request,
  }) => {
    const body = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
    const attempt = randomUUID();
    const outcome = await judgeOversize(attempt, () =>
      request
        .post(URL_PATH, {
          data: body,
          headers: { ...headers(sign(Buffer.alloc(1))), "x-e2e-attempt": attempt },
        })
        .then((res) => res.status()),
    );
    console.log(`OVERSIZE-OUTCOME ${outcome}`); // tallied by the stress runs
    expect(await webhookDelivery(sha(body))).toHaveLength(0); // never stored, never processed
  });

  test("the oversize verdict cannot be faked: a socket error with no 413 recorded for THAT request fails, and so does any other status", async ({
    request,
  }) => {
    test.setTimeout(60_000); // each attempt with no record waits the bounded 3 s before it fails
    // fault injection: the request fails before anything reaches the network (the reviewer's false positive)
    for (const code of ["EPIPE", "ECONNRESET"])
      await expect(
        judgeOversize(randomUUID(), () =>
          Promise.reject(new Error(`apiRequestContext.post: write ${code}`)),
        ),
      ).rejects.toThrow(/no 413 from the server is recorded for this attempt/);

    // a real 413 for ANOTHER attempt is not evidence for this one
    const other = randomUUID();
    await judgeOversize(other, () =>
      request
        .post(URL_PATH, {
          data: Buffer.alloc(4 * 1024 * 1024 + 1, 0x20),
          headers: { ...headers(sign(Buffer.alloc(1))), "x-e2e-attempt": other },
        })
        .then((res) => res.status()),
    );
    await expect(
      judgeOversize(randomUUID(), () => Promise.reject(new Error("write EPIPE"))),
    ).rejects.toThrow(/no 413 from the server is recorded for this attempt/);

    // a status the client reads must be 413, and must be the server's own answer to this attempt
    for (const status of [200, 403, 500])
      await expect(judgeOversize(randomUUID(), async () => status)).rejects.toThrow();
    await expect(judgeOversize(randomUUID(), async () => 413)).rejects.toThrow(
      /no 413 from the server is recorded for this attempt/,
    );

    // a REAL request the server answered with something else (403: wrong signature) is not a size refusal either
    const refused = randomUUID();
    const res = await request.post(URL_PATH, {
      data: Buffer.from("{}"),
      headers: { ...headers(sign(Buffer.from("other bytes"))), "x-e2e-attempt": refused },
    });
    expect(res.status()).toBe(403);
    await expect(
      judgeOversize(refused, () => Promise.reject(new Error("write ECONNRESET"))),
    ).rejects.toThrow(
      /no 413 from the server is recorded for this attempt \(server: \{"status":403\}/,
    );

    // and an unrelated error is never turned into a verdict
    await expect(
      judgeOversize(randomUUID(), () => Promise.reject(new Error("getaddrinfo ENOTFOUND"))),
    ).rejects.toThrow(/ENOTFOUND/);
  });

  test("an oversize body is refused with 413 and the connection is closed, even when the client stalls mid-upload", async () => {
    // A client declares a 4 MiB+1 body, sends a sliver, then stops. The server must answer 413 and DROP the connection
    // rather than hold the request open waiting for an upload it has already refused (it used to hold it until Node's
    // 5-minute request timeout).
    const port = Number(process.env.E2E_PORT);
    const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false });
    let statusLine = "";
    let closed = false;
    socket.on("data", (chunk) => {
      if (!statusLine) statusLine = String(chunk).split("\r\n")[0]!;
    });
    socket.on("close", () => (closed = true));
    await new Promise<void>((resolve) => socket.once("secureConnect", () => resolve()));
    socket.write(
      `POST ${URL_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${4 * 1024 * 1024 + 1}\r\nx-hub-signature-256: sha256=${"0".repeat(64)}\r\n\r\n`,
    );
    socket.write(" ".repeat(10_000));
    await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
    socket.destroy();
    expect(statusLine).toContain("413");
  });

  test("other API paths stay protected by the proxy", async ({ request }) => {
    const res = await request.post("/api/staff", {
      data: {},
      headers: { "content-type": "application/json" },
    });
    expect(res.status()).toBe(401);
  });
});
