import type { Page, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import {
  actorIdsOf,
  contactIdFor,
  conversationIdFor,
  createdEventsFor,
  createdEventsOf,
  leadState,
  leadsFor,
  outboundRequestCountForOrg,
} from "./support/db";
import { INBOX_USERS, INTEG_CONTACTS, INTEG_USERS } from "./support/identities";
import { loginViaUi, navigate, pageFetch } from "./support/ui";

// Phase 07D-6: the whole Leads Management system in a real browser, as one person would use it:
//   WhatsApp conversation -> Contact -> Lead information (Inbox) -> Lead Details -> Status -> History -> Leads listing.
// Each journey owns its contact in organization H. Everything a journey did is checked in the DATABASE as well as on screen, and no
// journey may queue or send a WhatsApp message.

const panel = (page: Page) => page.getByRole("region", { name: "Lead information" });
const createButton = (page: Page) =>
  panel(page).getByRole("button", { name: /Create lead|Creating lead/ });
const summary = (page: Page) => page.getByRole("region", { name: "Lead summary" });
const rows = (page: Page) => page.locator("main tbody tr");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const select = (page: Page) => page.getByRole("combobox", { name: "Change status" });
const dialog = (page: Page) => page.getByRole("alertdialog");
const historyItems = (page: Page) =>
  page.getByRole("list", { name: "Lead history, newest first" }).getByRole("listitem");
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function openInbox(page: Page, email: string, contact: string) {
  await loginViaUi(page, email, undefined, `/inbox?c=${await conversationIdFor(contact)}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(contact);
  await expect(panel(page)).toBeVisible();
}
const goInbox = async (page: Page, contact: string) => {
  await navigate(page, `/inbox?c=${await conversationIdFor(contact)}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(contact);
  await expect(panel(page)).toBeVisible();
};
const choose = async (page: Page, label: string) => {
  await select(page).click();
  await page.getByRole("option", { name: label, exact: true }).click();
};
const noOutbound = async () => {
  const { organizationId } = await actorIdsOf(INTEG_USERS.staff.email);
  return outboundRequestCountForOrg(organizationId);
};

test.describe("Leads Management: an advertisement-attributed contact", () => {
  test("Inbox -> Lead information -> Lead Details (attribution, evidence, history) -> Leads listing and its filters; creating again returns the same lead", async ({
    page,
  }) => {
    const outbound = await noOutbound();
    await openInbox(page, INTEG_USERS.staff.email, INTEG_CONTACTS.ad);
    const [lead] = await leadsFor(INTEG_CONTACTS.ad);
    expect(await leadsFor(INTEG_CONTACTS.ad)).toHaveLength(1); // made by the reconciler, once

    // the Inbox shows this contact's open lead, with the wording of a referral, not of a result
    const p = panel(page);
    await expect(p).toContainText("Open lead");
    await expect(p).toContainText("New");
    await expect(p).toContainText("Meta ad referral recorded");
    await expect(createButton(page)).toHaveCount(0); // an open lead exists: can.create is false
    // WCAG 2.2 target size (2.5.8, AA): the panel's own controls are at least 24 x 24 CSS pixels
    for (const control of [
      p.getByRole("button", { name: /Refresh/ }),
      p.getByRole("link", { name: "View lead (open, New)" }),
    ]) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(24);
      expect(box.width).toBeGreaterThanOrEqual(24);
    }
    await p.getByRole("link", { name: "View lead (open, New)" }).click();

    // Lead Details: the same lead, how it came to exist, the evidence, and a history that starts with it
    await expect(page).toHaveURL(new RegExp(`/leads/${lead!.id}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(INTEG_CONTACTS.ad);
    await expect(summary(page)).toContainText("Created automatically from a Meta ad referral");
    await expect(summary(page)).toContainText("Meta ad referral recorded");
    await expect(summary(page)).toContainText(
      "not a confirmed registration, payment or marketing consent",
    );
    const evidence = page.getByRole("region", { name: "Referral evidence" });
    await expect(evidence).toContainText("1 referral record is linked to this lead.");
    await expect(
      evidence.getByRole("list", { name: "Evidence linked to this lead" }).getByRole("listitem"),
    ).toHaveCount(1);
    await expect(evidence).toContainText("Ad text as provided by Meta (not verified)");
    await expect(historyItems(page).last()).toContainText(/created/i);
    expect(await createdEventsOf(lead!.id)).toEqual([{ origin: "AD_REFERRAL", revision: 0 }]);

    // the Leads listing, reached through the application shell, agrees with the lead page
    await nav(page).getByRole("link", { name: "Leads" }).click();
    await expect(page).toHaveURL(/\/leads$/);
    await expect(row(page, INTEG_CONTACTS.ad)).toContainText("Meta ad referral recorded");
    await expect(row(page, INTEG_CONTACTS.ad)).toContainText("New");
    await expect(row(page, INTEG_CONTACTS.ad).getByRole("link")).toHaveAttribute(
      "href",
      `/leads/${lead!.id}`,
    );
    // the attribution and state filters use the backend's own semantics
    await navigate(page, "/leads?attribution=ad&state=open");
    await expect(row(page, INTEG_CONTACTS.ad)).toHaveCount(1);
    await expect(row(page, INTEG_CONTACTS.cycle)).toHaveCount(0); // a staff-created lead has no linked ad touch
    await navigate(page, "/leads?attribution=none");
    await expect(row(page, INTEG_CONTACTS.ad)).toHaveCount(0);
    await navigate(page, "/leads?state=closed");
    await expect(row(page, INTEG_CONTACTS.ad)).toHaveCount(0);

    // Scenario C: the backend's existing-lead answer, forced from the page, is "created: false" with the same lead
    const again = await pageFetch(page, "POST", "/api/leads", {
      body: { contactId: await contactIdFor(INTEG_CONTACTS.ad) },
    });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ created: false, lead: { id: lead!.id } });
    expect(await leadsFor(INTEG_CONTACTS.ad)).toHaveLength(1);
    expect(await createdEventsFor(INTEG_CONTACTS.ad)).toBe(1);
    expect(await noOutbound()).toBe(outbound);
  });
});

test.describe("Leads Management: manual creation", () => {
  test("a contact without a lead: staff create one (MANUAL, New, revision 0, one CREATED event); the Inbox shows the server's lead, Lead Details and the listing contain it; no message is sent", async ({
    page,
  }) => {
    const outbound = await noOutbound();
    await openInbox(page, INTEG_USERS.staff.email, INTEG_CONTACTS.manual);
    await expect(panel(page)).toContainText("No lead has been recorded for this contact.");
    await createButton(page).click();
    const done = panel(page).getByRole("status").filter({ hasText: "A new lead was created" });
    await expect(done).toBeVisible();
    await expect(done).toContainText("no WhatsApp message was sent");
    await expect(panel(page)).toContainText("Open lead");

    const leads = await leadsFor(INTEG_CONTACTS.manual);
    expect(leads).toHaveLength(1);
    const id = leads[0]!.id;
    expect(await leadState(id)).toMatchObject({ status: "NEW", revision: 0, status_events: 0 });
    expect(await createdEventsOf(id)).toEqual([{ origin: "MANUAL", revision: 0 }]);
    expect(await noOutbound()).toBe(outbound);

    await done.getByRole("link", { name: "Open the new lead" }).click();
    await expect(page).toHaveURL(new RegExp(`/leads/${id}$`));
    await expect(summary(page)).toContainText("Created by staff");
    await expect(summary(page)).toContainText("No referral recorded");
    await expect(historyItems(page)).toHaveCount(1);

    await nav(page).getByRole("link", { name: "Leads" }).click();
    await expect(row(page, INTEG_CONTACTS.manual)).toContainText("New");
    await expect(row(page, INTEG_CONTACTS.manual)).toContainText("No referral recorded");
  });

  test("a viewer reads the same lead information but cannot create: no control, and a forced creation is refused by the server", async ({
    page,
  }) => {
    await openInbox(page, INTEG_USERS.viewer.email, INTEG_CONTACTS.viewer);
    await expect(panel(page)).toContainText("Your role can view leads but cannot create them.");
    await expect(createButton(page)).toHaveCount(0);
    const forced = await pageFetch(page, "POST", "/api/leads", {
      body: { contactId: await contactIdFor(INTEG_CONTACTS.viewer) },
    });
    expect(forced.status).toBe(403);
    expect(await leadsFor(INTEG_CONTACTS.viewer)).toHaveLength(0);
  });
});

test.describe("Leads Management: a closed lead and a new cycle", () => {
  test("close in Lead Details (confirmed), see it in the Inbox and the listing, start a new cycle, and reopening the old lead is refused while the new one is open", async ({
    page,
  }) => {
    const outbound = await noOutbound();
    await openInbox(page, INTEG_USERS.staff.email, INTEG_CONTACTS.cycle);
    const [first] = await leadsFor(INTEG_CONTACTS.cycle);
    await expect(panel(page)).toContainText("Open lead");
    await panel(page).getByRole("link", { name: "View lead (open, New)" }).click();
    await expect(page).toHaveURL(new RegExp(`/leads/${first!.id}$`));

    // closing needs a confirmation that says what it does; cancelling changes nothing
    await choose(page, "Not interested");
    await page.getByRole("button", { name: "Update status" }).click();
    await expect(
      dialog(page).getByRole("heading", { name: "Close this lead as Not interested?" }),
    ).toBeVisible();
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    expect(await leadState(first!.id)).toMatchObject({ status: "NEW", revision: 0 });
    await page.getByRole("button", { name: "Update status" }).click();
    await dialog(page).getByRole("button", { name: "Close as Not interested" }).click();
    await expect(summary(page)).toContainText("Closed");
    await expect(historyItems(page).first()).toContainText(
      "changed the status from New to Not interested",
    );
    expect(await leadState(first!.id)).toMatchObject({
      status: "NOT_INTERESTED",
      revision: 1,
      status_events: 1,
    });

    // the Inbox is read afresh when the conversation is opened: the lead is closed, a new one may be created
    await goInbox(page, INTEG_CONTACTS.cycle);
    await expect(panel(page)).toContainText("This contact has no open lead.");
    await expect(
      panel(page).getByRole("list", { name: "Previous leads" }).getByRole("listitem"),
    ).toHaveCount(1);
    await expect(panel(page).getByRole("list", { name: "Previous leads" })).toContainText(
      "Not interested",
    );
    await createButton(page).click();
    await expect(
      panel(page).getByRole("status").filter({ hasText: "A new lead was created" }),
    ).toBeVisible();

    const leads = await leadsFor(INTEG_CONTACTS.cycle);
    expect(leads).toHaveLength(2);
    const second = leads[1]!;
    expect(second.id).not.toBe(first!.id);
    expect(await leadState(first!.id)).toMatchObject({ status: "NOT_INTERESTED", revision: 1 }); // never reopened
    expect(await leadState(second.id)).toMatchObject({ status: "NEW", revision: 0 });
    expect(await createdEventsFor(INTEG_CONTACTS.cycle)).toBe(2);
    expect(await noOutbound()).toBe(outbound);

    // the listing shows both cycles, told apart by state and status
    await navigate(page, `/leads?q=${encodeURIComponent("Integ Cycle")}`);
    await expect(row(page, INTEG_CONTACTS.cycle)).toHaveCount(2);
    await expect(row(page, INTEG_CONTACTS.cycle).filter({ hasText: "Not interested" })).toHaveCount(
      1,
    );
    await expect(row(page, INTEG_CONTACTS.cycle).filter({ hasText: "New" })).toHaveCount(1);
    // and by the state filter, which is the backend's: one open cycle, one closed
    for (const [state, count] of [
      ["open", 1],
      ["closed", 1],
    ] as const) {
      await navigate(page, `/leads?q=${encodeURIComponent("Integ Cycle")}&state=${state}`);
      await expect(row(page, INTEG_CONTACTS.cycle)).toHaveCount(count);
    }
    await navigate(page, `/leads?q=${encodeURIComponent("Integ Cycle")}`);
    await expect(row(page, INTEG_CONTACTS.cycle)).toHaveCount(2);

    // Scenario E: reopening the first lead while the second is open is refused, and says so
    await row(page, INTEG_CONTACTS.cycle)
      .filter({ hasText: "Not interested" })
      .getByRole("link")
      .click();
    await expect(page).toHaveURL(new RegExp(`/leads/${first!.id}(\\?|$)`)); // the list's filters ride along
    await choose(page, "New");
    await page.getByRole("button", { name: "Update status" }).click();
    await dialog(page).getByRole("button", { name: "Reopen as New" }).click();
    const refused = page.locator("main").getByRole("alert").filter({ hasText: "was not reopened" });
    await expect(refused).toBeVisible();
    await expect(refused).toContainText("Nothing was saved");
    await expect(summary(page)).toContainText("Closed");
    expect(await leadState(first!.id)).toMatchObject({ status: "NOT_INTERESTED", revision: 1 });
    expect(await leadState(second.id)).toMatchObject({ status: "NEW", revision: 0 });
    await expect(refused.getByRole("link", { name: /current lead/ })).toHaveAttribute(
      "href",
      `/leads/${second.id}`,
    );
  });
});

test.describe("Leads Management: reserved statuses and other organizations", () => {
  test("a Paid lead is shown as read-only everywhere and no staff control can change it; the server refuses a forced change", async ({
    page,
  }) => {
    await openInbox(page, INTEG_USERS.staff.email, INTEG_CONTACTS.reserved);
    await expect(panel(page)).toContainText("Paid");
    await expect(panel(page)).toContainText("Read-only");
    await expect(createButton(page)).toHaveCount(0);
    await panel(page)
      .getByRole("link", { name: /View lead/ })
      .click();
    await expect(summary(page)).toContainText("Paid");
    await expect(summary(page)).toContainText("Read-only");
    await expect(select(page)).toHaveCount(0);
    const [lead] = await leadsFor(INTEG_CONTACTS.reserved);
    const forced = await pageFetch(page, "POST", `/api/leads/${lead!.id}/status`, {
      body: { to: "NEW", expectedRevision: (await leadState(lead!.id)).revision },
    });
    expect(forced.status).toBe(409);
    expect(await leadState(lead!.id)).toMatchObject({ status: "PAID", status_events: 0 });
    await nav(page).getByRole("link", { name: "Leads" }).click();
    await expect(row(page, INTEG_CONTACTS.reserved)).toContainText("Read-only");
  });

  test("another organization's staff cannot read, create for, or change anything of this organization: every answer is the same 404", async ({
    page,
  }) => {
    await loginViaUi(page, INBOX_USERS.staff.email, undefined, "/inbox");
    await expect(page.getByRole("main", { name: "Inbox" })).toBeVisible();
    const contactId = await contactIdFor(INTEG_CONTACTS.ad);
    const [lead] = await leadsFor(INTEG_CONTACTS.ad);
    const missing = "00000000-0000-4000-8000-0000000000ff";
    const statuses = [];
    for (const [method, path, body] of [
      ["GET", `/api/leads/for-contact/${contactId}`, undefined],
      ["GET", `/api/leads/for-contact/${missing}`, undefined],
      ["GET", `/api/leads/${lead!.id}`, undefined],
      ["GET", `/api/leads/${lead!.id}/events`, undefined],
      ["POST", "/api/leads", { contactId }],
      ["POST", `/api/leads/${lead!.id}/status`, { to: "QUALIFIED", expectedRevision: 0 }],
      ["GET", "/api/leads/not-a-uuid", undefined],
    ] as const) {
      const r = await pageFetch(page, method, path, body === undefined ? {} : { body });
      statuses.push([r.status, r.text.includes(INTEG_CONTACTS.ad)]);
    }
    expect(statuses).toEqual(statuses.map(() => [404, false]));
    expect(await leadsFor(INTEG_CONTACTS.ad)).toHaveLength(1);
    expect(await leadState(lead!.id)).toMatchObject({ status: "NEW", revision: 0 });
    // and their own Leads page does not list it
    await navigate(page, "/leads");
    await expect(page.getByText(INTEG_CONTACTS.ad)).toHaveCount(0);
  });
});

test.describe("Leads Management: an identifier that is not a UUID, on every page that links by id", () => {
  // a lone surrogate is a string by type; building a link from it throws and (before the check) replaced the whole page by the
  // error screen. Uncaught page errors fail a test (support/fixtures.ts), so "no crash" is enforced by every test here.
  const BAD = "\uD800";
  const tamper = (change: (json: Record<string, unknown>) => void) => async (route: Route) => {
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    change(json);
    await route.fulfill({ response, json });
  };

  test("the Leads listing: a refreshed page with a malformed row id is a retryable error, the rows shown stay, and the next good page is accepted", async ({
    page,
  }) => {
    await loginViaUi(page, INTEG_USERS.staff.email, undefined, "/leads");
    await expect(row(page, INTEG_CONTACTS.ad)).toHaveCount(1);
    let calls = 0;
    await page.route(/\/api\/leads(\?|$)/, (route) =>
      ++calls > 1
        ? route.continue()
        : tamper((j) => ((j.items as { id: string }[])[0]!.id = BAD))(route),
    );
    await page.getByRole("button", { name: "Refresh" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "could not be" });
    await expect(alert).toBeVisible();
    await expect(row(page, INTEG_CONTACTS.ad)).toHaveCount(1); // what was shown stays
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(alert).toHaveCount(0);
    await expect(row(page, INTEG_CONTACTS.ad)).toHaveCount(1);
    expect(calls).toBe(2);
  });

  test("Lead Details: a refreshed answer with a malformed conversation id is a failed refresh, the lead stays, Try again recovers", async ({
    page,
  }) => {
    const [lead] = await leadsFor(INTEG_CONTACTS.ad);
    await loginViaUi(page, INTEG_USERS.staff.email, undefined, `/leads/${lead!.id}`);
    await expect(summary(page)).toBeVisible();
    let calls = 0;
    await page.route(/\/api\/leads\/[^/?]+$/, (route) =>
      ++calls > 1
        ? route.continue()
        : tamper((j) => ((j.conversations as { id: string }[])[0]!.id = BAD))(route),
    );
    await page.getByRole("button", { name: "Refresh" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "could not be refreshed" });
    await expect(alert).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(INTEG_CONTACTS.ad);
    await expect(page.getByRole("link", { name: /Inbox/ }).first()).toBeVisible();
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(alert).toHaveCount(0);
    expect(calls).toBe(2);
  });
});

test.describe("Leads Management: keyboard, small screens and widths", () => {
  test("390px, keyboard only: sidebar to Leads and back to the Inbox, open a conversation, create a lead, follow the link, dismiss the sidebar with Escape", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, INTEG_USERS.staff.email, undefined, "/inbox");
    const sidebar = page.getByRole("dialog", { name: "Sidebar" });
    const trigger = page.locator("[data-sidebar=trigger]");

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole("link", { name: "Leads" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/leads$/);
    await expect(sidebar).toHaveCount(0);
    await trigger.focus();
    await page.keyboard.press("Enter");
    await sidebar.getByRole("link", { name: "Inbox" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(sidebar).toHaveCount(0);

    await page
      .getByRole("region", { name: "Conversations" })
      .getByRole("button", { name: new RegExp(INTEG_CONTACTS.mobile) })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(INTEG_CONTACTS.mobile);
    await page.getByRole("button", { name: "Details" }).focus();
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();
    await createButton(page).focus();
    await page.keyboard.press("Enter");
    const done = panel(page).getByRole("status").filter({ hasText: "A new lead was created" });
    await expect(done).toBeVisible();
    await expect(done).toBeFocused(); // the button went away; focus moved to the outcome
    await page.keyboard.press("Tab"); // the next stop is the link in the message
    await expect(done.getByRole("link", { name: "Open the new lead" })).toBeFocused();
    await page.keyboard.press("Enter");
    const [lead] = await leadsFor(INTEG_CONTACTS.mobile);
    await expect(page).toHaveURL(new RegExp(`/leads/${lead!.id}$`));
    expect(await leadsFor(INTEG_CONTACTS.mobile)).toHaveLength(1);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(sidebar).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sidebar).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  for (const width of [320, 390, 768, 1280]) {
    test(`${width}px: Inbox with its details, the Leads listing and Lead Details never scroll sideways`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const [lead] = await leadsFor(INTEG_CONTACTS.ad);
      await loginViaUi(
        page,
        INTEG_USERS.staff.email,
        undefined,
        `/inbox?c=${await conversationIdFor(INTEG_CONTACTS.ad)}`,
      );
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(INTEG_CONTACTS.ad);
      const details = page.getByRole("button", { name: "Details" }); // below the wide layout the panel sits behind it
      if (await details.isVisible()) await details.click();
      await expect(panel(page)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await navigate(page, "/leads");
      await expect(row(page, INTEG_CONTACTS.ad)).toHaveCount(1);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await navigate(page, `/leads/${lead!.id}`);
      await expect(summary(page)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }
});
