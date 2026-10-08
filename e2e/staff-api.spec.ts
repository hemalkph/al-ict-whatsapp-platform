import { expect, test } from "./support/fixtures";
import { E2E_PASSWORD, USERS } from "./support/identities";
import { membershipOf, userCount, userExists } from "./support/db";
import { closeWhenIdle, errorCode, loginViaUi, pageFetch, submitLogin } from "./support/ui";

// Representative staff-API checks from a REAL authenticated browser. The 35 route-level integration tests already
// cover the permutations; this proves cookies, Origin/Sec-Fetch-Site and the production build work together.

const SAFE_DTO_KEYS = [
  "createdAt",
  "email",
  "membershipId",
  "name",
  "passwordChangeRequired",
  "role",
  "status",
  "userId",
];
const MISSING_ID = "00000000-0000-4000-8000-0000000000ff";

type StaffList = { staff: Array<Record<string, unknown>> };

test.describe("staff API as a signed-in ADMIN", () => {
  test("lists own organization only, creates staff, changes role, suspends and reactivates", async ({
    page,
  }) => {
    await loginViaUi(page, USERS.apiAdmin.email);
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    const target = await membershipOf(USERS.apiTarget.email);
    const orgB = await membershipOf(USERS.orgBStaff.email);
    const bodies: string[] = [];

    // forged organization / role headers change nothing
    const list = await pageFetch(page, "GET", "/api/staff", {
      headers: { "x-organization-id": orgB.organization_id, "x-role": "VIEWER" },
    });
    expect(list.status).toBe(200);
    bodies.push(list.text);
    const emails = (list.json as StaffList).staff.map((s) => s.email);
    expect(emails).toContain(USERS.apiAdmin.email);
    expect(emails).toContain(USERS.apiTarget.email);
    expect(emails).not.toContain(USERS.orgBStaff.email);
    for (const member of (list.json as StaffList).staff) {
      expect(Object.keys(member).sort()).toEqual(SAFE_DTO_KEYS);
    }

    const email = "created.by.e2e@e2e.test";
    const created = await pageFetch(page, "POST", "/api/staff", {
      body: { email, name: "Created By E2E", role: "VIEWER", initialPassword: E2E_PASSWORD },
    });
    expect(created.status).toBe(201);
    bodies.push(created.text);
    expect(created.json).toMatchObject({
      staff: { email, role: "VIEWER", status: "ACTIVE", passwordChangeRequired: true },
    });
    expect((await membershipOf(email)).organization_id).toBe(target.organization_id);

    const role = await pageFetch(page, "PATCH", `/api/staff/${target.id}/role`, {
      body: { role: "VIEWER" },
    });
    expect(role.status).toBe(200);
    bodies.push(role.text);
    expect((await membershipOf(USERS.apiTarget.email)).role).toBe("VIEWER");
    expect(
      (await pageFetch(page, "PATCH", `/api/staff/${target.id}/role`, { body: { role: "STAFF" } }))
        .status,
    ).toBe(200);

    const suspended = await pageFetch(page, "POST", `/api/staff/${target.id}/suspend`);
    expect(suspended.status).toBe(200);
    bodies.push(suspended.text);
    expect((await membershipOf(USERS.apiTarget.email)).status).toBe("SUSPENDED");
    const reactivated = await pageFetch(page, "POST", `/api/staff/${target.id}/reactivate`);
    expect(reactivated.status).toBe(200);
    expect(await membershipOf(USERS.apiTarget.email)).toMatchObject({
      role: "STAFF",
      status: "ACTIVE",
    });

    // mass assignment is refused
    const mass = await pageFetch(page, "POST", "/api/staff", {
      body: {
        email: "mass@e2e.test",
        name: "Mass",
        role: "STAFF",
        initialPassword: E2E_PASSWORD,
        organizationId: orgB.organization_id,
      },
    });
    expect(mass.status).toBe(400);
    expect(await userExists("mass@e2e.test")).toBe(false);

    // a foreign membership id is indistinguishable from a missing one
    const foreign = await pageFetch(page, "PATCH", `/api/staff/${orgB.id}/role`, {
      body: { role: "ADMIN" },
    });
    const missing = await pageFetch(page, "PATCH", `/api/staff/${MISSING_ID}/role`, {
      body: { role: "ADMIN" },
    });
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    expect(foreign.text).toBe(missing.text);
    expect((await membershipOf(USERS.orgBStaff.email)).role).toBe("STAFF");

    for (const body of bodies) {
      expect(body).not.toContain(E2E_PASSWORD);
      expect(body).not.toMatch(/[0-9a-f]{32}:[0-9a-f]{128}/); // no scrypt hash
      expect(body).not.toMatch(/token|secret/i);
    }
  });
});

test.describe("staff API as STAFF and VIEWER", () => {
  test("STAFF may read but every mutation is 403 (forged headers do not help)", async ({
    page,
  }) => {
    await loginViaUi(page, USERS.apiStaff.email);
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    const target = await membershipOf(USERS.apiTarget.email);
    const forged = { "x-role": "ADMIN", "x-organization-id": target.organization_id };

    expect((await pageFetch(page, "GET", "/api/staff")).status).toBe(200);
    const users = await userCount();
    const attempts = [
      await pageFetch(page, "POST", "/api/staff", {
        headers: forged,
        body: {
          email: "nope@e2e.test",
          name: "Nope",
          role: "ADMIN",
          initialPassword: E2E_PASSWORD,
        },
      }),
      await pageFetch(page, "PATCH", `/api/staff/${target.id}/role`, {
        headers: forged,
        body: { role: "ADMIN" },
      }),
      await pageFetch(page, "POST", `/api/staff/${target.id}/suspend`, { headers: forged }),
    ];
    for (const attempt of attempts) {
      expect(attempt.status).toBe(403);
      expect(errorCode(attempt)).toBe("FORBIDDEN");
    }
    expect(await userCount()).toBe(users);
    expect(await membershipOf(USERS.apiTarget.email)).toMatchObject({
      role: "STAFF",
      status: "ACTIVE",
    });
  });

  test("VIEWER cannot list staff under the current permission matrix", async ({ page }) => {
    await loginViaUi(page, USERS.apiViewer.email);
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    const res = await pageFetch(page, "GET", "/api/staff");
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("FORBIDDEN");
  });
});

test.describe("same-origin protection", () => {
  test("foreign, missing and cross-site requests cannot mutate with the browser's real session", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginViaUi(page, USERS.apiAdmin.email);
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    const target = await membershipOf(USERS.apiTarget.email);
    const url = `/api/staff/${target.id}/suspend`;
    const unchanged = async () =>
      expect(await membershipOf(USERS.apiTarget.email)).toMatchObject({ status: "ACTIVE" });

    // correct application origin (the browser sets it): works, and is undone below
    expect((await pageFetch(page, "POST", url)).status).toBe(200);
    expect((await pageFetch(page, "POST", `/api/staff/${target.id}/reactivate`)).status).toBe(200);
    await unchanged();

    // The context's request API shares the browser's cookies, so these carry the real session.
    const hostile: Array<Record<string, string>> = [
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: "not a url" },
      {}, // no Origin and no Sec-Fetch-Site at all
      { "sec-fetch-site": "cross-site" },
    ];
    for (const headers of hostile) {
      const res = await context.request.post(url, { headers });
      expect(res.status(), JSON.stringify(headers)).toBe(403);
    }
    await unchanged();

    // A real cross-site page in the same browser, submitting the classic CSRF form (a top-level cross-site POST
    // navigation). `localhost` and `127.0.0.1` are different sites, and the session cookie is host-only and
    // SameSite=Lax, which keeps it off a cross-site POST: the request is turned away as unauthenticated before it can
    // mutate anything. (A public origin such as evil.example cannot be used here: Chromium blocks public-to-loopback
    // requests itself, which would prove nothing about the application.)
    //
    // This is a form navigation on purpose, not fetch(..., { mode: "no-cors" }): Chromium cancels an opaque cross-origin
    // response as soon as it sees its headers (net::ERR_ABORTED) and closes the connection, so that variant raced the
    // server finishing its response and, on a slow runner, made Next.js log `Error: aborted` (ECONNRESET) for a request
    // whose body it never read. A navigation is never cancelled, and the test waits for the whole response.
    const attackerOrigin = `https://localhost:${new URL(baseURL!).port}`;
    const attacker = await context.newPage();
    await attacker.goto(`${attackerOrigin}/login`);
    const answered = attacker.waitForResponse(
      (r) => r.url().endsWith(url) && r.request().method() === "POST",
    );
    await attacker.evaluate(
      ({ target }) => {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = target;
        form.enctype = "text/plain";
        const field = document.createElement("input");
        field.type = "hidden";
        field.name = "csrf";
        field.value = "attempt";
        form.append(field);
        document.body.append(form);
        form.submit();
      },
      { target: `${baseURL}${url}` },
    );
    const response = await answered;
    const request = response.request();
    const sent = await request.allHeaders();
    // The browser's own statements that this was a genuinely different site (not an inference): a top-level form
    // navigation whose Origin is the attacker's site, never the application's.
    expect(attackerOrigin).not.toBe(new URL(baseURL!).origin);
    expect(sent["sec-fetch-site"]).toBe("cross-site");
    expect(sent["sec-fetch-mode"]).toBe("navigate");
    expect(sent["origin"]).toBe(attackerOrigin);
    expect(sent["referer"]).toBe(`${attackerOrigin}/`);
    // SameSite=Lax kept the real session off this request, and the server turned it away as unauthenticated.
    expect(sent["cookie"]).toBeUndefined();
    expect(response.status()).toBe(401);
    await response.finished(); // the complete response has arrived: nothing is still being sent when the page closes
    await closeWhenIdle(attacker);
    await unchanged();
  });
});

test.describe("login rate limiting", () => {
  test("repeated sign-in attempts from one client IP reach 429 in the browser", async ({
    page,
    context,
  }) => {
    // The browser sends no client IP of its own, so the limiter has nothing to key on and is skipped (documented
    // deployment blocker). The test supplies a deterministic IP header for this context only; the application's
    // proxy-header trust is NOT changed. This proves the database limiter is wired in the production build and
    // that the UI reports it; it does not (and cannot) prove client-IP trust, which is a deployment concern.
    await context.setExtraHTTPHeaders({ "x-forwarded-for": "198.51.100.77" });
    await page.goto("/login");
    for (let attempt = 1; attempt <= 5; attempt++) {
      await submitLogin(page, "nobody.here@e2e.test", `wrong-password-${attempt}-xx`);
      await expect(page.locator("p[role=alert]")).toHaveText("Invalid email or password.");
    }
    await submitLogin(page, "nobody.here@e2e.test", "wrong-password-6-xx");
    await expect(page.locator("p[role=alert]")).toHaveText(
      "Too many attempts. Please wait and try again.",
    );
  });
});
