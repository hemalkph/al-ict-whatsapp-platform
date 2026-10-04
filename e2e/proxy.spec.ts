import { expect, test } from "./support/fixtures";
import { USERS } from "./support/identities";
import { errorCode, loginViaUi, pageFetch, sessionCookie } from "./support/ui";

// The proxy is an optimistic cookie-PRESENCE check; it never queries PostgreSQL and never authorizes. The probe path
// /reports does not exist: whether a request reaches routing (404) or is turned away earlier (redirect to /login)
// shows what the proxy decided, independent of the real server-side checks that guard the actual pages and APIs.

test.describe("the proxy is not authorization", () => {
  test("no cookie: the proxy turns the request away before routing", async ({ request }) => {
    const page = await request.get("/reports", { maxRedirects: 0 });
    expect(page.status()).toBe(307);
    expect(page.headers().location).toMatch(/\/login\?next=%2Freports$/);

    const api = await request.get("/api/staff", { maxRedirects: 0 });
    expect(api.status()).toBe(401);
  });

  test("a forged cookie passes the proxy but real authorization still rejects it", async ({
    page,
    context,
    request,
    baseURL,
  }) => {
    // Learn the cookie NAME from a real login (never hard-coded), then forge a value under it.
    await loginViaUi(page, USERS.proxy.email);
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    const real = await sessionCookie(context);
    const cookie = `${real!.name}=forged.value-that-is-not-a-session`;

    expect((await request.get("/reports", { headers: { cookie }, maxRedirects: 0 })).status()).toBe(
      404, // passed the proxy and reached routing
    );
    const home = await request.get("/", { headers: { cookie }, maxRedirects: 0 });
    expect(home.status()).toBe(307);
    expect(home.headers().location).toMatch(/\/login/); // the server layout rejected it
    const api = await request.get("/api/staff", { headers: { cookie }, maxRedirects: 0 });
    expect(api.status()).toBe(401);
    expect(errorCode({ status: 401, text: "", json: await api.json() })).toBe("UNAUTHENTICATED");

    // Same in a real browser holding the forged cookie.
    const forged = await page.context().browser()!.newContext({ ignoreHTTPSErrors: true });
    await forged.addCookies([
      {
        name: real!.name,
        value: "forged.value-that-is-not-a-session",
        url: baseURL!,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    const forgedPage = await forged.newPage();
    await forgedPage.goto(`${baseURL}/`);
    await expect(forgedPage).toHaveURL(/\/login$/);
    await expect(forgedPage.getByText("Signed in")).toHaveCount(0);
    await forged.close();
  });

  test("a revoked (stale) real cookie passes the proxy and is rejected by the server", async ({
    page,
    context,
    request,
  }) => {
    await loginViaUi(page, USERS.proxy.email);
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    const real = (await sessionCookie(context))!;
    const cookie = `${real.name}=${real.value}`;
    expect((await request.get("/api/staff", { headers: { cookie } })).status()).toBe(200);

    // Revoke the session server-side (a normal sign-out), keeping a copy of the cookie.
    expect((await pageFetch(page, "POST", "/api/auth/sign-out", { body: {} })).status).toBe(200);

    expect((await request.get("/reports", { headers: { cookie }, maxRedirects: 0 })).status()).toBe(
      404,
    );
    const home = await request.get("/", { headers: { cookie }, maxRedirects: 0 });
    expect(home.status()).toBe(307);
    expect((await request.get("/api/staff", { headers: { cookie } })).status()).toBe(401);
  });
});
