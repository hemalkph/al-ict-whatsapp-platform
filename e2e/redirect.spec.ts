import { expect, test } from "./support/fixtures";
import { USERS } from "./support/identities";
import { loginViaUi, navigate } from "./support/ui";

// Post-login redirect targets (?next=) come from the URL, so they are attacker-controlled.

const MALICIOUS_NEXT = [
  "https://evil.example",
  "https://evil.example/path",
  "http://evil.example",
  "//evil.example",
  "///evil.example",
  "/\\evil.example",
  "\\\\evil.example",
  "\\/evil.example",
  "/%5Cevil.example", // encoded backslash
  "%2F%2Fevil.example", // encoded protocol-relative (arrives still-encoded)
  "/%2Fevil.example",
  "javascript:alert(document.domain)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "https:evil.example",
  "/\r\nSet-Cookie: pwned=1", // CRLF
  "/\tevil.example",
  "/\u0000evil.example", // NUL
  " //evil.example", // leading whitespace
];

test.describe("redirect security", () => {
  for (const next of MALICIOUS_NEXT) {
    test(`refuses next=${JSON.stringify(next)}`, async ({ page, context, baseURL }) => {
      const origin = new URL(baseURL!).origin;
      const foreignRequests: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).origin !== origin) foreignRequests.push(request.url());
      });

      await loginViaUi(page, USERS.redirect.email, undefined, next);
      await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();

      const landed = new URL(page.url());
      expect(landed.origin).toBe(origin);
      expect(landed.pathname + landed.search).toBe("/"); // the safe fallback
      expect(foreignRequests).toEqual([]);
      expect((await context.cookies()).find((c) => c.name === "pwned")).toBeUndefined();
    });
  }

  test("a valid internal path is honored after login", async ({ page, baseURL }) => {
    await loginViaUi(page, USERS.redirect.email, undefined, "/?welcome=1");
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    expect(page.url()).toBe(`${new URL(baseURL!).origin}/?welcome=1`);
  });

  test("an already signed-in visitor is not redirected off-site by /login?next=", async ({
    page,
    baseURL,
  }) => {
    await loginViaUi(page, USERS.redirect.email);
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    await navigate(page, `/login?next=${encodeURIComponent("//evil.example")}`);
    await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
  });
});
