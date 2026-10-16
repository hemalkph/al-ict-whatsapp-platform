import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { INBOX_CONTACTS, INBOX_TEXT, INBOX_USERS } from "./support/identities";
import {
  conversationIdFor,
  conversationState,
  messageCount,
  noteCount,
  outboundRequestsFor,
} from "./support/db";
import { loginViaUi, navigate, pageFetch } from "./support/ui";

// The staff inbox in a real browser against the production build and a disposable database (fake students, fake messages,
// no Meta credentials, no outbound worker: a reply can be QUEUED here but nothing can be sent).

const row = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(name) });
const openInbox = async (page: Page, email: string) => {
  await loginViaUi(page, email, undefined, "/inbox");
  await expect(page.getByRole("region", { name: "Conversations" })).toBeVisible();
};
const open = async (page: Page, name: string) => {
  await row(page, name).first().click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
};

test.describe("staff inbox", () => {
  test("a signed-out visitor is sent to sign in and returns to the inbox afterwards", async ({
    page,
  }) => {
    await navigate(page, "/inbox");
    await expect(page).toHaveURL(/\/login\?next=%2Finbox/);
    await page.getByLabel("Email").fill(INBOX_USERS.viewer.email);
    await page.getByLabel("Password").fill("e2e-initial-password-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("region", { name: "Conversations" })).toBeVisible();
    await expect(page).toHaveURL(/\/inbox/);
  });

  test("staff work a conversation end to end: read, status, assign, note, tag, quick reply, queue a reply", async ({
    page,
  }) => {
    const id = await conversationIdFor(INBOX_CONTACTS.nimal);
    const before = await conversationState(id);
    const messagesBefore = await messageCount(id);
    await openInbox(page, INBOX_USERS.staff.email);

    // finds the student, sees it is unread
    await expect(
      row(page, INBOX_CONTACTS.nimal)
        .first()
        .getByLabel(/unread/),
    ).toBeVisible();
    await open(page, INBOX_CONTACTS.nimal);

    // reads the history: Sinhala text, a reply relationship, a delivered outbound message, a photo placeholder
    const log = page.getByRole("log", { name: "Messages" });
    await expect(log.getByText(INBOX_TEXT.nimalSinhala)).toBeVisible();
    // the earlier outbound message, and the quote of it inside the customer's reply ("ok sir, thank you")
    await expect(log.getByText("ICT theory class starts at 8.00 am.")).toHaveCount(2);
    await expect(log.getByText("ok sir, thank you")).toBeVisible();
    await expect(log.getByText("Delivered", { exact: true })).toBeVisible();
    await expect(log.getByText("Photo")).toBeVisible();
    await expect(log.getByText("New messages")).toBeVisible();
    // opening it marks it seen for this staff member only (the badge goes away)
    await expect(
      row(page, INBOX_CONTACTS.nimal)
        .first()
        .getByLabel(/unread/),
    ).toHaveCount(0);

    // a refresh keeps the conversation open (it is in the URL) and keeps it read
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: INBOX_CONTACTS.nimal })).toBeVisible();
    await expect(
      row(page, INBOX_CONTACTS.nimal)
        .first()
        .getByLabel(/unread/),
    ).toHaveCount(0);

    // status: Open -> Pending
    const details = page.getByRole("complementary", { name: "Contact and conversation details" });
    await details.getByRole("button", { name: "Pending", exact: true }).click();
    await expect(details.getByRole("button", { name: "Pending", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(details.getByText(/changed the status from Open to Pending/)).toBeVisible();

    // assignment: to a colleague, then to me
    await details.getByLabel("Assigned to").selectOption({ label: INBOX_USERS.staff2.name });
    await expect(
      details.getByText(new RegExp(`assigned it to ${INBOX_USERS.staff2.name}`)),
    ).toBeVisible();
    await details.getByRole("button", { name: "Assign to me" }).click();
    await expect(details.getByLabel("Assigned to")).toHaveValue(
      (await conversationState(id)).assigned_membership_id ?? "never",
    );

    // an internal note: durable, separate from the chat
    await details
      .getByLabel("Add an internal note")
      .fill("Student asked about the next ICT theory class.");
    await details.getByRole("button", { name: "Save note" }).click();
    await expect(
      details
        .getByRole("list", { name: "Internal notes" })
        .getByText("Student asked about the next ICT theory class."),
    ).toBeVisible();
    expect(await noteCount(id)).toBe(1);

    // a tag: create it, see it, remove it
    await details.getByLabel("New tag name").fill("Theory batch");
    await details.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      details.getByRole("list", { name: "Contact tags" }).getByText("Theory batch"),
    ).toBeVisible();
    await details.getByRole("button", { name: "Remove tag Theory batch" }).click();
    await expect(
      details.getByRole("list", { name: "Contact tags" }).getByText("Theory batch"),
    ).toHaveCount(0);

    // a quick reply: create one, insert it. Inserting does not send anything.
    await page.getByRole("button", { name: "Quick replies" }).click();
    const picker = page.getByRole("dialog", { name: "Quick replies" });
    await picker.getByRole("button", { name: "New quick reply" }).click();
    await picker.getByLabel("Title").fill("Class time");
    await picker.getByLabel("Text").fill("Our next theory session begins on Sunday at 8.00 am.");
    await picker.getByRole("button", { name: "Save quick reply" }).click();
    await picker
      .getByRole("button", { name: /Class time/ })
      .first()
      .click();
    const composer = page.getByLabel("Message to the customer");
    await expect(composer).toHaveValue("Our next theory session begins on Sunday at 8.00 am.");
    expect(await outboundRequestsFor(id)).toHaveLength(0);

    // queue the reply: the UI says QUEUED, not sent, not delivered
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Queued." })).toContainText(
      "has not been sent to WhatsApp yet",
    );
    const log2 = page.getByRole("log", { name: "Messages" });
    await expect(
      log2.getByText("Our next theory session begins on Sunday at 8.00 am."),
    ).toBeVisible();
    await expect(log2.getByText("Queued", { exact: true })).toBeVisible();
    await expect(log2.getByText(/has not been sent to WhatsApp yet/)).toBeVisible();
    await expect(composer).toHaveValue("");
    const requests = await outboundRequestsFor(id);
    expect(requests).toEqual([{ state: "QUEUED", recipient_kind: "PHONE", message_type: "TEXT" }]);

    // none of the staff-only actions touched the customer-service window; only the queued reply added a message
    const after = await conversationState(id);
    expect(after.last_inbound_at).toEqual(before.last_inbound_at);
    expect(await messageCount(id)).toBe(messagesBefore + 1);
  });

  test("a double click on Send queues exactly one message", async ({ page }) => {
    const id = await conversationIdFor(INBOX_CONTACTS.ruwan);
    // Ruwan's last message is inside the window; his earlier outbound message is UNKNOWN_OUTCOME.
    const before = (await outboundRequestsFor(id)).length;
    await openInbox(page, INBOX_USERS.staff2.email);
    await open(page, INBOX_CONTACTS.ruwan);
    await page.getByLabel("Message to the customer").fill("Exam is on the 14th.");
    await page.getByRole("button", { name: "Send reply" }).dblclick();
    await expect(page.getByRole("status").filter({ hasText: "Queued." })).toBeVisible();
    await expect.poll(async () => (await outboundRequestsFor(id)).length).toBe(before + 1);
    await page.waitForTimeout(300);
    expect((await outboundRequestsFor(id)).length).toBe(before + 1);
  });

  test("an unknown outcome is shown as a warning, with no way to resend it", async ({ page }) => {
    await openInbox(page, INBOX_USERS.staff2.email);
    await open(page, INBOX_CONTACTS.ruwan);
    const log = page.getByRole("log", { name: "Messages" });
    const warning = log.getByRole("alert").filter({ hasText: "Outcome unknown" });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("may or may not have been sent");
    await expect(warning).toContainText("supervisor");
    await expect(
      page.getByRole("button", { name: /resend|retry|send again|try again/i }),
    ).toHaveCount(0);
    await expect(log.getByText(INBOX_TEXT.unknownOutcomeBody)).toBeVisible();
  });

  test("when a reply is not allowed the composer says why and cannot queue it", async ({
    page,
  }) => {
    const kavindi = await conversationIdFor(INBOX_CONTACTS.kavindi);
    await openInbox(page, INBOX_USERS.staff2.email);
    await open(page, INBOX_CONTACTS.kavindi);
    await expect(
      page.getByRole("log", { name: "Messages" }).getByText(INBOX_TEXT.kavindiTamil),
    ).toBeVisible();
    await expect(
      page.getByRole("note").filter({ hasText: "24-hour reply window has closed" }),
    ).toBeVisible();
    await page.getByLabel("Message to the customer").fill("Hello");
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
    expect(await outboundRequestsFor(kavindi)).toHaveLength(0);

    // a contact known only by a BSUID with a retained phone: a reply is not sent to the old number
    await page
      .getByRole("button", { name: /Unnamed contact/ })
      .first()
      .click();
    await expect(page.getByRole("note").filter({ hasText: "cannot send to yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
    await expect(page.getByText(/may not belong to them now/)).toBeVisible();
  });

  test("a viewer can read but cannot change or send anything", async ({ page }) => {
    await openInbox(page, INBOX_USERS.viewer.email);
    await open(page, INBOX_CONTACTS.nimal);
    const details = page.getByRole("complementary", { name: "Contact and conversation details" });
    await expect(
      page.getByText("You have read-only access, so you cannot send replies."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Send reply" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Quick replies" })).toHaveCount(0);
    await expect(details.getByRole("group", { name: "Conversation status" })).toHaveCount(0);
    await expect(details.getByLabel("Add an internal note")).toHaveCount(0);
    await expect(details.getByLabel("Assigned to")).toHaveCount(0);
    const id = await conversationIdFor(INBOX_CONTACTS.nimal);
    const status = await pageFetch(page, "POST", `/api/inbox/conversations/${id}/status`, {
      body: { to: "RESOLVED", expected: "OPEN" },
    });
    expect(status.status).toBe(403);
    const send = await pageFetch(page, "POST", `/api/conversations/${id}/messages`, {
      body: { idempotencyKey: "viewer-should-not-send-1", message: { type: "text", body: "no" } },
    });
    expect(send.status).toBe(403);
    expect((await pageFetch(page, "GET", `/api/inbox/conversations/${id}/notes`)).status).toBe(403);
  });

  test("another organization's conversation cannot be opened or listed", async ({ page }) => {
    const theirs = await conversationIdFor(INBOX_CONTACTS.orgB);
    await openInbox(page, INBOX_USERS.staff.email);
    await expect(page.getByText(INBOX_CONTACTS.orgB)).toHaveCount(0);
    await navigate(page, `/inbox?c=${theirs}`);
    await expect(page.getByText("This conversation is not available")).toBeVisible();
    await expect(page.getByText(INBOX_TEXT.orgBSecret)).toHaveCount(0);
    const detail = await pageFetch(page, "GET", `/api/inbox/conversations/${theirs}`);
    expect(detail.status).toBe(404);
    const status = await pageFetch(page, "POST", `/api/inbox/conversations/${theirs}/status`, {
      body: { to: "RESOLVED", expected: "OPEN" },
    });
    expect(status.status).toBe(404);
    expect(detail.text).not.toContain(INBOX_TEXT.orgBSecret);
    expect((await conversationState(theirs)).status).toBe("OPEN");
  });

  test("search, filters, the second WhatsApp number and loading more", async ({ page }) => {
    await openInbox(page, INBOX_USERS.admin.email);
    const list = page.getByRole("region", { name: "Conversations" });
    // pagination: the first page does not contain everything
    await expect(list.getByRole("button", { name: /Filler Student 35/ })).toHaveCount(0);
    await list.getByRole("button", { name: "Load more conversations" }).click();
    await expect(list.getByRole("button", { name: /Filler Student 35/ })).toBeVisible();
    // search by name, and a Tamil/Sinhala-safe search that matches nothing
    await list.getByLabel("Search conversations").fill("kavi");
    await expect(list.getByRole("button", { name: /Kavindi Selvaraj/ })).toBeVisible();
    await expect(list.getByRole("button", { name: /Nimal Perera/ })).toHaveCount(0);
    await list.getByLabel("Search conversations").fill("zzzzzz");
    await expect(list.getByText("No conversations here")).toBeVisible();
    await list.getByLabel("Search conversations").fill("");
    // filters
    await list.getByRole("button", { name: "Pending", exact: true }).click();
    await expect(list.getByRole("button", { name: /Kavindi Selvaraj/ })).toBeVisible();
    await expect(list.getByRole("button", { name: /Ruwan Jayasinghe/ })).toHaveCount(0);
    await list.getByRole("button", { name: "All", exact: true }).click();
    // the second WhatsApp number
    await list.getByLabel("WhatsApp number").selectOption({ label: "+94 71 765 4321" });
    await expect(list.getByRole("button", { name: /Dilani Fernando/ })).toBeVisible();
    await expect(list.getByRole("button", { name: /Ruwan Jayasinghe/ })).toHaveCount(0);
    // an attachment that has not been downloaded, and an unsupported type, are shown safely
    await open(page, INBOX_CONTACTS.dilani);
    const log = page.getByRole("log", { name: "Messages" });
    await expect(
      log.getByText(/project\.jpg · image\/jpeg · 47 KB · not downloaded/),
    ).toBeVisible();
    await expect(log.getByText("Unsupported message")).toBeVisible();
  });

  test("on a phone the inbox shows one view at a time and the composer stays usable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openInbox(page, INBOX_USERS.mobile.email);
    const list = page.getByRole("region", { name: "Conversations" });
    await expect(list).toBeVisible();
    await expect(
      page
        .getByRole("main", { name: "Inbox" })
        .locator(":scope > section[aria-label='Conversation']"),
    ).toBeHidden();
    await open(page, INBOX_CONTACTS.nimal);
    await expect(list).toBeHidden();
    await expect(page.getByLabel("Message to the customer")).toBeVisible();
    await page.getByLabel("Message to the customer").fill("typing on a phone");
    await expect(page.getByLabel("Message to the customer")).toHaveValue("typing on a phone");
    await page.getByRole("button", { name: "Details" }).click();
    const details = page.getByRole("complementary", { name: "Contact and conversation details" });
    await expect(details).toBeVisible();
    await details.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Back to conversations" }).click();
    await expect(list).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
