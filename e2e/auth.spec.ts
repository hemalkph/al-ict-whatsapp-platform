import { expect, test } from "./support/fixtures";
import { E2E_NEW_PASSWORD, E2E_PASSWORD, FIRST_ADMIN, ORG_A, USERS } from "./support/identities";
import { passwordChangeRequired, sessionCount } from "./support/db";
import {
  closeWhenIdle,
  errorCode,
  loginViaUi,
  navigate,
  pageFetch,
  sessionCookie,
  submitLogin,
} from "./support/ui";

test.describe("logged-out access and invalid login", () => {
  test("a protected page redirects to /login with a safe next destination", async ({
    page,
    context,
  }) => {
    await page.goto("/reports?tab=1");
    await expect(page).toHaveURL(/\/login\?next=%2Freports%3Ftab%3D1$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    expect(await sessionCookie(context)).toBeUndefined();

    await navigate(page, "/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("invalid credentials show one generic message, reveal nothing and create no session", async ({
    page,
    context,
  }) => {
    const messages: string[] = [];
    for (const [email, password] of [
      ["nobody.here@e2e.test", "some-wrong-password-1"], // unknown account
      [USERS.invalidLogin.email, "some-wrong-password-1"], // known account, wrong password
    ] as const) {
      await navigate(page, "/login");
      await submitLogin(page, email, password);
      const alert = page.locator("p[role=alert]");
      await expect(alert).toBeVisible();
      messages.push((await alert.textContent()) ?? "");
      await expect(page).toHaveURL(/\/login$/);
      expect(await sessionCookie(context)).toBeUndefined();
      expect(await page.locator("body").innerText()).not.toMatch(
        /USER_NOT_FOUND|INVALID_EMAIL|INVALID_PASSWORD|credential|does not exist|not found/i,
      );
    }
    expect(messages).toEqual(["Invalid email or password.", "Invalid email or password."]);
    expect(await sessionCount(USERS.invalidLogin.email)).toBe(0);
  });
});

test.describe.serial("first login and forced password change", () => {
  test("first login lands on the password change, and nothing else is reachable", async ({
    page,
    context,
  }) => {
    await loginViaUi(page, FIRST_ADMIN.email);
    await expect(page).toHaveURL(/\/change-password$/);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();

    const cookie = await sessionCookie(context);
    expect(cookie, "the browser received the Better Auth session cookie").toBeDefined();
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
    expect(cookie!.name).toMatch(/^__Secure-/);

    await navigate(page, "/");
    await expect(page).toHaveURL(/\/change-password$/);
    await expect(page.getByText("Signed in")).toHaveCount(0);

    const staff = await pageFetch(page, "GET", "/api/staff");
    expect(staff.status).toBe(403);
    expect(errorCode(staff)).toBe("PASSWORD_CHANGE_REQUIRED");
    expect(await passwordChangeRequired(FIRST_ADMIN.email)).toBe(true);
  });

  test("the change form rejects bad input and the server enforces the same rules", async ({
    page,
  }) => {
    await loginViaUi(page, FIRST_ADMIN.email);
    await expect(page).toHaveURL(/\/change-password$/);
    const changeRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/account/change-password")) changeRequests.push(r.url());
    });

    const fill = async (current: string, next: string, confirm: string) => {
      await page.getByLabel(/^Current password/).fill(current);
      await page.getByLabel(/^New password/).fill(next);
      await page.getByLabel(/^Confirm new password/).fill(confirm);
      await page.getByRole("button", { name: "Change password" }).click();
    };

    await fill("wrong-current-password", E2E_NEW_PASSWORD, E2E_NEW_PASSWORD);
    await expect(page.locator("p[role=alert]")).toHaveText("The current password is incorrect.");

    await fill(E2E_PASSWORD, E2E_NEW_PASSWORD, "something-else-entirely-3");
    await expect(page.locator("p[role=alert]")).toHaveText("The new passwords do not match.");

    const requestsBefore = changeRequests.length;
    await fill(E2E_PASSWORD, "short-pw-1", "short-pw-1"); // 10 characters, the minimum is 12
    await expect(page).toHaveURL(/\/change-password$/);
    expect(
      changeRequests.length,
      "the browser blocks a too-short password before any request",
    ).toBe(requestsBefore);

    const tooShort = await pageFetch(page, "POST", "/api/account/change-password", {
      body: { currentPassword: E2E_PASSWORD, newPassword: "short-pw-1" },
    });
    expect(tooShort.status).toBe(400);
    expect(errorCode(tooShort)).toBe("VALIDATION_ERROR");
    expect(tooShort.text).not.toContain(E2E_PASSWORD);
    expect(await passwordChangeRequired(FIRST_ADMIN.email)).toBe(true);
  });

  test("a valid change clears the gate, replaces the session and signs out other sessions", async ({
    page,
    context,
    browser,
  }) => {
    await loginViaUi(page, FIRST_ADMIN.email);
    await expect(page).toHaveURL(/\/change-password$/);
    const before = await sessionCookie(context);

    // A second browser profile with its own session for the same user.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto("/login");
    await submitLogin(otherPage, FIRST_ADMIN.email);
    await expect(otherPage).toHaveURL(/\/change-password$/);
    expect(await sessionCount(FIRST_ADMIN.email)).toBeGreaterThanOrEqual(2);

    await page.getByLabel(/^Current password/).fill(E2E_PASSWORD);
    await page.getByLabel(/^New password/).fill(E2E_NEW_PASSWORD);
    await page.getByLabel(/^Confirm new password/).fill(E2E_NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    // Everything displayed is derived on the server from the session and the membership.
    await expect(page.getByText(FIRST_ADMIN.name)).toBeVisible();
    await expect(page.getByText(ORG_A.name)).toBeVisible();
    await expect(page.getByText("ADMIN", { exact: true })).toBeVisible();
    expect(await passwordChangeRequired(FIRST_ADMIN.email)).toBe(false);

    // The replacement cookie round-trips: a reload stays signed in with the NEW cookie.
    const after = await sessionCookie(context);
    expect(after).toBeDefined();
    expect(after!.value).not.toBe(before!.value);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    expect(await sessionCount(FIRST_ADMIN.email)).toBe(1); // every other session was revoked

    await navigate(otherPage, "/");
    await expect(otherPage).toHaveURL(/\/login$/);
    await expect(otherPage.getByText("Signed in")).toHaveCount(0);
    await closeWhenIdle(other);

    // The gate no longer applies: the staff API is available to the ADMIN.
    expect((await pageFetch(page, "GET", "/api/staff")).status).toBe(200);
  });

  test("the old password no longer works and the new one does", async ({ page }) => {
    await loginViaUi(page, FIRST_ADMIN.email, E2E_PASSWORD);
    await expect(page.locator("p[role=alert]")).toHaveText("Invalid email or password.");
    await expect(page).toHaveURL(/\/login$/);

    await submitLogin(page, FIRST_ADMIN.email, E2E_NEW_PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
  });
});

test.describe("logout", () => {
  test("signing out invalidates the database session and a stale cookie cannot restore access", async ({
    page,
    context,
  }) => {
    const { logout } = USERS;
    await loginViaUi(page, logout.email);
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    expect(await sessionCount(logout.email)).toBe(1);
    const stale = await sessionCookie(context);
    expect(stale).toBeDefined();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await sessionCookie(context)).toBeUndefined();
    expect(await sessionCount(logout.email)).toBe(0); // deleted, not just hidden

    await navigate(page, "/");
    await expect(page).toHaveURL(/\/login$/);

    // Put the previous cookie back, as an attacker holding a copy would.
    await context.addCookies([stale!]);
    await navigate(page, "/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText("Signed in")).toHaveCount(0);
    expect((await context.request.get("/api/staff")).status()).toBe(401);
  });
});
