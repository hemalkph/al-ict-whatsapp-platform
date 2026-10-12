import { expect, test } from "./support/fixtures";
import { INBOX_CONTACTS, INBOX_USERS } from "./support/identities";
import { conversationIdFor, outboundRequestsFor } from "./support/db";
import { loginViaUi, pageFetch } from "./support/ui";

// Runs against the SECOND E2E application server, which has WHATSAPP_OUTBOUND_ENABLED off (see playwright.config.ts).
// The gate is environment-only and is never bypassed: with it off the inbox must say so and nothing can be queued.

test("with outbound messaging switched off the composer explains it, cannot queue, and the API refuses", async ({
  page,
}) => {
  const id = await conversationIdFor(INBOX_CONTACTS.nimal);
  const before = (await outboundRequestsFor(id)).length;
  await loginViaUi(page, INBOX_USERS.staff2.email, undefined, "/inbox");
  await page
    .getByRole("button", { name: new RegExp(INBOX_CONTACTS.nimal) })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: INBOX_CONTACTS.nimal })).toBeVisible();

  await expect(page.getByRole("note").filter({ hasText: "Sending is switched off" })).toBeVisible();
  await expect(page.getByLabel("Message to the customer")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Quick replies" })).toBeDisabled();

  // the browser cannot get around it by calling the API directly either
  const refused = await pageFetch(page, "POST", `/api/conversations/${id}/messages`, {
    body: {
      idempotencyKey: "e2e-off-should-not-queue-1",
      message: { type: "text", body: "hello" },
    },
  });
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain("outbound_disabled");
  expect((await outboundRequestsFor(id)).length).toBe(before);
  await page.waitForLoadState("networkidle");
});
