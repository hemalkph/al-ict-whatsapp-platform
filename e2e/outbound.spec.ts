import { expect, test } from "./support/fixtures";

// Outbound messaging through the REAL production server and proxy: there is no public send path. Both endpoints are staff-only,
// and the E2E environment has every outbound gate off and no Meta credential, so nothing here can reach Meta.

const CONVERSATION = "00000000-0000-4000-8000-0000000000aa";
const REQUEST = "00000000-0000-4000-8000-0000000000bb";

test.describe("outbound endpoints reject unauthenticated callers", () => {
  test("no cookie: the proxy answers 401 before any handler runs", async ({ request }) => {
    const send = await request.post(`/api/conversations/${CONVERSATION}/messages`, {
      data: { idempotencyKey: "e2e-idempotency-key-1", message: { type: "text", body: "hello" } },
      maxRedirects: 0,
    });
    expect(send.status()).toBe(401);
    const read = await request.get(`/api/outbound-requests/${REQUEST}`, { maxRedirects: 0 });
    expect(read.status()).toBe(401);
  });

  test("a forged session cookie is still rejected with 401 and the body is not echoed", async ({
    request,
    baseURL,
  }) => {
    const cookie = "better-auth.session_token=forged.value-that-is-not-a-session";
    const body = {
      idempotencyKey: "e2e-idempotency-key-2",
      message: { type: "text", body: "hello" },
    };
    // without a same-origin Origin the CSRF guard answers 403 before authentication is even attempted
    const crossSite = await request.post(`/api/conversations/${CONVERSATION}/messages`, {
      headers: { cookie },
      data: body,
      maxRedirects: 0,
    });
    expect(crossSite.status()).toBe(403);
    // same-origin: it reaches authentication, which rejects the forged session
    const send = await request.post(`/api/conversations/${CONVERSATION}/messages`, {
      headers: { cookie, origin: new URL(baseURL!).origin },
      data: body,
      maxRedirects: 0,
    });
    expect(send.status()).toBe(401);
    expect(await send.text()).not.toContain("hello");
    const read = await request.get(`/api/outbound-requests/${REQUEST}`, {
      headers: { cookie },
      maxRedirects: 0,
    });
    expect(read.status()).toBe(401);
  });
});
