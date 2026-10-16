import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import {
  actorIdsOf,
  contactIdFor,
  conversationIdFor,
  createdEventsFor,
  leadsFor,
  outboundRequestCountForOrg,
} from "./support/db";
import { INBOX_USERS, PANEL_CONTACTS, PANEL_USERS } from "./support/identities";
import { loginViaUi, navigate, pageFetch } from "./support/ui";

// The Inbox lead panel (Phase 07D-5) in a real browser against the production build and a disposable database (organization G).
// What a creation did is checked in the DATABASE as well as on the screen. Every test that creates owns its contact.

const panel = (page: Page) => page.getByRole("region", { name: "Lead information" });
const createButton = (page: Page) =>
  panel(page).getByRole("button", { name: /Create lead|Creating lead/ });
const conversations = (page: Page) => page.getByRole("region", { name: "Conversations" });
const LEADS_FOR_CONTACT = /\/api\/leads\/for-contact\/[^/]+$/;
const CREATE_URL = /\/api\/leads$/;

async function openConversation(page: Page, email: string, contact: string) {
  await loginViaUi(page, email, undefined, `/inbox?c=${await conversationIdFor(contact)}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(contact);
  await expect(panel(page)).toBeVisible();
}
const switchTo = (page: Page, contact: string) =>
  conversations(page)
    .getByRole("button", { name: new RegExp(contact) })
    .click();

/** Every lead request the page sends (counted when issued, so a held or dropped one counts too). */
function recordLeadRequests(page: Page) {
  const seen: { method: string; path: string; actor: string | undefined }[] = [];
  page.on("request", (r: Request) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/leads"))
      seen.push({ method: r.method(), path: url.pathname, actor: r.headers()["x-expected-actor"] });
  });
  return {
    posts: () => seen.filter((s) => s.method === "POST"),
    reads: (contactId?: string) =>
      seen.filter(
        (s) =>
          s.method === "GET" &&
          s.path.startsWith("/api/leads/for-contact/") &&
          (contactId === undefined || s.path.endsWith(contactId)),
      ),
    all: () => seen,
  };
}
/** Holds matching requests until released (they reach the server only then). */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((r) => (release = r));
  return { opened, release };
}

/** Errors the page throws (an uncaught exception is what took the whole Inbox down), and whether React's error screen is showing. */
function watchCrashes(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return {
    errors,
    expectNone: async () => {
      expect(errors).toEqual([]);
      await expect(page.getByText("This page couldn't load")).toHaveCount(0);
      await expect(page.getByRole("main", { name: "Inbox" })).toBeVisible();
    },
  };
}
/** The server's answer to a request, with `change` applied to its JSON body (status and headers kept). */
async function tampered(route: Route, change: (body: Record<string, unknown>) => void) {
  const response = await route.fetch();
  const json = (await response.json()) as Record<string, unknown>;
  change(json);
  await route.fulfill({ response, json });
}
// a lone surrogate: a string by type, accepted by a "non-empty string" test, and encodeURIComponent throws on it
const LONE_SURROGATE = "\uD800";
/** Another tab signs this browser's account out and signs `email` in: the first tab's page now belongs to a previous actor. */
async function switchAccount(context: BrowserContext, email: string) {
  const tab = await context.newPage();
  await navigate(tab, "/inbox");
  await tab.getByRole("button", { name: "Sign out" }).click();
  await expect(tab).toHaveURL(/\/login/);
  await loginViaUi(tab, email, undefined, "/inbox");
  await expect(tab.getByRole("main", { name: "Inbox" })).toBeVisible();
  return tab;
}

test.describe("Inbox lead panel: what it shows", () => {
  test("an open lead with its status, a previous closed lead, and links to the lead page built from the server's ids", async ({
    page,
  }) => {
    const seen = recordLeadRequests(page);
    await openConversation(page, PANEL_USERS.staff.email, PANEL_CONTACTS.open);
    const [first, current] = await leadsFor(PANEL_CONTACTS.open);
    const p = panel(page);
    await expect(p).toContainText("Open lead");
    await expect(p).toContainText("Qualified");
    await expect(p.getByRole("list", { name: "Previous leads" }).getByRole("listitem")).toHaveCount(
      1,
    );
    await expect(p.getByRole("list", { name: "Previous leads" })).toContainText("Not interested");
    await expect(p.getByRole("link", { name: "View lead (open, Qualified)" })).toHaveAttribute(
      "href",
      `/leads/${current!.id}`,
    );
    await expect(p.getByRole("list", { name: "Previous leads" }).getByRole("link")).toHaveAttribute(
      "href",
      `/leads/${first!.id}`,
    );
    await expect(createButton(page)).toHaveCount(0); // an open lead exists
    await expect(p.getByRole("combobox")).toHaveCount(0); // no status control in the Inbox
    // the read carried the page's actor assertion
    expect(seen.reads().length).toBeGreaterThan(0);
    for (const r of seen.reads()) expect(r.actor).toBeTruthy();

    await p.getByRole("link", { name: "View lead (open, Qualified)" }).click();
    await expect(page).toHaveURL(new RegExp(`/leads/${current!.id}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(PANEL_CONTACTS.open);
  });

  test("closed leads only: no open lead, both previous leads listed, creation offered; no lead at all: an accurate empty state", async ({
    page,
  }) => {
    await openConversation(page, PANEL_USERS.staff.email, PANEL_CONTACTS.closed);
    const p = panel(page);
    await expect(p).toContainText("This contact has no open lead.");
    await expect(p.getByRole("list", { name: "Previous leads" }).getByRole("listitem")).toHaveCount(
      2,
    );
    await expect(createButton(page)).toBeVisible();
    await switchTo(page, PANEL_CONTACTS.none);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(PANEL_CONTACTS.none);
    await expect(p).toContainText("No lead has been recorded for this contact.");
    await expect(p.getByRole("list", { name: "Previous leads" })).toHaveCount(0);
    await expect(createButton(page)).toBeVisible();
    await expect(p).toContainText("It does not message the customer");
  });

  test("a failed read is told apart from 'no lead', and Try again reads again", async ({
    page,
  }) => {
    await loginViaUi(page, PANEL_USERS.staff.email, undefined, "/inbox");
    let calls = 0;
    await page.route(LEADS_FOR_CONTACT, async (route) => {
      if (++calls > 1) return route.continue();
      await route.fulfill({
        status: 500,
        json: { error: { code: "INTERNAL_ERROR", message: "x" } },
      });
    });
    await navigate(page, `/inbox?c=${await conversationIdFor(PANEL_CONTACTS.none)}`);
    const alert = panel(page).getByRole("alert");
    await expect(alert).toContainText("Lead information could not be loaded.");
    await expect(panel(page)).not.toContainText("No lead has been recorded");
    await expect(createButton(page)).toHaveCount(0);
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(panel(page)).toContainText("No lead has been recorded for this contact.");
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
  });

  test("a viewer reads the leads but is offered nothing to create, and a forced creation is refused by the server", async ({
    page,
  }) => {
    await openConversation(page, PANEL_USERS.viewer.email, PANEL_CONTACTS.none);
    await expect(panel(page)).toContainText("No lead has been recorded for this contact.");
    await expect(panel(page)).toContainText("Your role can view leads but cannot create them.");
    await expect(createButton(page)).toHaveCount(0);
    const forced = await pageFetch(page, "POST", "/api/leads", {
      body: { contactId: await contactIdFor(PANEL_CONTACTS.none) },
    });
    expect(forced.status).toBe(403);
    expect(await leadsFor(PANEL_CONTACTS.none)).toHaveLength(0);
    await switchTo(page, PANEL_CONTACTS.open);
    await expect(panel(page)).toContainText("Qualified");
  });

  test("an archived contact: explained, nothing to create, and a forced creation is refused (CONTACT_ARCHIVED)", async ({
    page,
  }) => {
    await openConversation(page, PANEL_USERS.staff.email, PANEL_CONTACTS.archived);
    await expect(panel(page)).toContainText(
      "This contact is archived, so a lead cannot be created for it.",
    );
    await expect(createButton(page)).toHaveCount(0);
    const forced = await pageFetch(page, "POST", "/api/leads", {
      body: { contactId: await contactIdFor(PANEL_CONTACTS.archived) },
    });
    expect(forced.status).toBe(409);
    expect((forced.json as { error: { code: string } }).error.code).toBe("CONTACT_ARCHIVED");
    expect(await leadsFor(PANEL_CONTACTS.archived)).toHaveLength(0);
  });

  test("another organization's contact: reading and creating both answer 404 and change nothing", async ({
    page,
  }) => {
    await loginViaUi(page, INBOX_USERS.staff.email, undefined, "/inbox");
    await expect(page.getByRole("main", { name: "Inbox" })).toBeVisible();
    const foreign = await contactIdFor(PANEL_CONTACTS.none);
    const read = await pageFetch(page, "GET", `/api/leads/for-contact/${foreign}`);
    expect(read.status).toBe(404);
    const create = await pageFetch(page, "POST", "/api/leads", { body: { contactId: foreign } });
    expect(create.status).toBe(404);
    expect(JSON.stringify(create.json)).not.toContain(PANEL_CONTACTS.none);
    expect(await leadsFor(PANEL_CONTACTS.none)).toHaveLength(0);
  });
});

test.describe("Inbox lead panel: creating a lead", () => {
  test("staff create one: one POST, a read shows it, it opens in Lead Details; a second attempt returns the existing lead; nothing is sent to WhatsApp", async ({
    page,
  }) => {
    const seen = recordLeadRequests(page);
    const sendPaths: string[] = [];
    page.on("request", (r) => {
      if (
        /\/(send|messages)\b|\/api\/conversations\//.test(new URL(r.url()).pathname) &&
        r.method() !== "GET"
      )
        sendPaths.push(new URL(r.url()).pathname);
    });
    await openConversation(page, PANEL_USERS.staff.email, PANEL_CONTACTS.create);
    const { organizationId } = await actorIdsOf(PANEL_USERS.staff.email);
    const outboundBefore = await outboundRequestCountForOrg(organizationId);
    await createButton(page).click();
    const done = panel(page).getByRole("status").filter({ hasText: "A new lead was created" });
    await expect(done).toBeVisible();
    await expect(done).toContainText("no WhatsApp message was sent");
    await expect(done).toBeFocused(); // the button disappears; focus is not lost
    await expect(panel(page)).toContainText("Open lead");
    await expect(panel(page)).toContainText("New");
    await expect(createButton(page)).toHaveCount(0);

    const leads = await leadsFor(PANEL_CONTACTS.create);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.status).toBe("NEW");
    expect(await createdEventsFor(PANEL_CONTACTS.create)).toBe(1);
    expect(seen.posts()).toHaveLength(1);
    expect(seen.posts()[0]!.actor).toBeTruthy();
    expect(sendPaths).toEqual([]);
    expect(await outboundRequestCountForOrg(organizationId)).toBe(outboundBefore);

    // the backend's existing-open-lead semantics: 200, created:false, the same lead
    const again = await pageFetch(page, "POST", "/api/leads", {
      body: { contactId: await contactIdFor(PANEL_CONTACTS.create) },
    });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ created: false, lead: { id: leads[0]!.id } });
    expect(await leadsFor(PANEL_CONTACTS.create)).toHaveLength(1);

    await done.getByRole("link", { name: "Open the new lead" }).click();
    await expect(page).toHaveURL(new RegExp(`/leads/${leads[0]!.id}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(PANEL_CONTACTS.create);
  });
});

test.describe("Inbox lead panel: switching conversations", () => {
  test("A -> B: A's late answer never shows on B", async ({ page }) => {
    await loginViaUi(page, PANEL_USERS.staff.email, undefined, "/inbox");
    const a = await contactIdFor(PANEL_CONTACTS.raceA);
    const hold = gate();
    await page.route(LEADS_FOR_CONTACT, async (route) => {
      if (new URL(route.request().url()).pathname.endsWith(a)) await hold.opened;
      await route.continue().catch(() => undefined); // the page may have abandoned it
    });
    await navigate(page, `/inbox?c=${await conversationIdFor(PANEL_CONTACTS.raceA)}`);
    await expect(panel(page).getByRole("status")).toContainText("Loading lead information…");
    await switchTo(page, PANEL_CONTACTS.raceB);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(PANEL_CONTACTS.raceB);
    await expect(panel(page)).toContainText("No lead has been recorded for this contact.");
    hold.release();
    await page.waitForTimeout(600);
    await expect(panel(page)).toContainText("No lead has been recorded for this contact.");
    await expect(panel(page)).not.toContainText("Open lead");
  });

  test("A -> B -> A: the first read of A is outdated even though A is shown again", async ({
    page,
  }) => {
    await loginViaUi(page, PANEL_USERS.staff.email, undefined, "/inbox");
    const a = await contactIdFor(PANEL_CONTACTS.raceA);
    const hold = gate();
    let readsOfA = 0;
    await page.route(LEADS_FOR_CONTACT, async (route: Route) => {
      if (!new URL(route.request().url()).pathname.endsWith(a) || ++readsOfA > 1)
        return route.continue();
      // the FIRST read of A: answered by the server, held, and altered to look like "no lead" so a leak would show
      const response = await route.fetch();
      const json = (await response.json()) as Record<string, unknown>;
      await hold.opened;
      await route
        .fulfill({ response, json: { ...json, openLead: null, leads: [] } })
        .catch(() => undefined);
    });
    await navigate(page, `/inbox?c=${await conversationIdFor(PANEL_CONTACTS.raceA)}`);
    await expect.poll(() => readsOfA).toBe(1);
    await switchTo(page, PANEL_CONTACTS.raceB);
    await expect(panel(page)).toContainText("No lead has been recorded for this contact.");
    await switchTo(page, PANEL_CONTACTS.raceA);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(PANEL_CONTACTS.raceA);
    await expect(panel(page)).toContainText("Open lead");
    hold.release();
    await page.waitForTimeout(600);
    await expect(panel(page)).toContainText("Open lead");
    await expect(panel(page)).not.toContainText("No lead has been recorded");
  });

  test("a creation still on its way when another contact is opened: committed for ITS contact, never shown on the other, and reported when its contact is opened again", async ({
    page,
  }) => {
    const seen = recordLeadRequests(page);
    await openConversation(page, PANEL_USERS.staff.email, PANEL_CONTACTS.navigate);
    const hold = gate();
    await page.route(CREATE_URL, async (route) => {
      await hold.opened;
      await route.continue().catch(() => undefined);
    });
    await createButton(page).click();
    await expect(createButton(page)).toHaveText("Creating lead…");
    await switchTo(page, PANEL_CONTACTS.raceB);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(PANEL_CONTACTS.raceB);
    await expect(panel(page)).toContainText("No lead has been recorded for this contact.");
    hold.release();
    await expect.poll(() => leadsFor(PANEL_CONTACTS.navigate).then((l) => l.length)).toBe(1);
    await page.waitForTimeout(600);
    await expect(panel(page)).not.toContainText("A new lead was created");
    await expect(panel(page)).toContainText("No lead has been recorded for this contact.");
    expect(await leadsFor(PANEL_CONTACTS.raceB)).toHaveLength(0);
    expect(seen.posts()).toHaveLength(1);
    expect(seen.posts()[0]!.path).toBe("/api/leads");

    await switchTo(page, PANEL_CONTACTS.navigate);
    await expect(
      panel(page).getByRole("status").filter({ hasText: "A new lead was created" }),
    ).toBeVisible();
    await expect(panel(page)).toContainText("Open lead");
    expect(seen.posts()).toHaveLength(1);
    expect(await createdEventsFor(PANEL_CONTACTS.navigate)).toBe(1);
  });
});

test.describe("Inbox lead panel: an outcome that cannot be known", () => {
  test("the answer is lost AFTER the server created the lead: uncertain, never repeated, the read shows the lead", async ({
    page,
  }) => {
    const seen = recordLeadRequests(page);
    await openConversation(page, PANEL_USERS.staff.email, PANEL_CONTACTS.lostAfter);
    const contactId = await contactIdFor(PANEL_CONTACTS.lostAfter);
    await page.route(CREATE_URL, async (route) => {
      await route.fetch(); // the server commits...
      await route.abort("connectionreset"); // ...and the browser never hears it
    });
    await createButton(page).click();
    const unknown = panel(page)
      .getByRole("alert")
      .filter({ hasText: "could not confirm whether the lead was created" });
    await expect(unknown).toBeVisible();
    await expect(unknown).toContainText("The request was not repeated.");
    await expect(panel(page)).toContainText("Open lead"); // the recovery read
    await expect(panel(page).getByText("A new lead was created")).toHaveCount(0);
    await page.waitForTimeout(600);
    expect(seen.posts()).toHaveLength(1);
    expect(seen.reads(contactId).length).toBe(2); // the first read and the recovery read
    expect(await createdEventsFor(PANEL_CONTACTS.lostAfter)).toBe(1);
  });

  test("the request is lost BEFORE the server saw it: still uncertain (never 'failed'), the read shows no lead, and a new explicit creation works", async ({
    page,
  }) => {
    const seen = recordLeadRequests(page);
    await openConversation(page, PANEL_USERS.staff.email, PANEL_CONTACTS.lostBefore);
    await page.route(CREATE_URL, (route) => route.abort("connectionreset"));
    await createButton(page).click();
    const unknown = panel(page)
      .getByRole("alert")
      .filter({ hasText: "could not confirm whether the lead was created" });
    await expect(unknown).toBeVisible();
    await expect(unknown).toContainText(
      "If no new lead is shown, the request may still be completing",
    );
    await expect(panel(page)).toContainText("No lead has been recorded for this contact.");
    await expect(createButton(page)).toHaveAttribute("aria-disabled", "false");
    await page.waitForTimeout(600);
    expect(seen.posts()).toHaveLength(1);
    expect(await leadsFor(PANEL_CONTACTS.lostBefore)).toHaveLength(0);

    await page.unrouteAll({ behavior: "wait" });
    await createButton(page).click();
    await expect(
      panel(page).getByRole("status").filter({ hasText: "A new lead was created" }),
    ).toBeVisible();
    expect(seen.posts()).toHaveLength(2);
    expect(await leadsFor(PANEL_CONTACTS.lostBefore)).toHaveLength(1);
  });

  test("HTTP 201 with an envelope that is not the contract: not believed, uncertain, one POST, the read shows the committed lead", async ({
    page,
  }) => {
    const seen = recordLeadRequests(page);
    await openConversation(page, PANEL_USERS.staff.email, PANEL_CONTACTS.malformed);
    await page.route(CREATE_URL, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { created: true } });
    });
    await createButton(page).click();
    await expect(
      panel(page)
        .getByRole("alert")
        .filter({ hasText: "could not confirm whether the lead was created" }),
    ).toBeVisible();
    await expect(panel(page).getByText("A new lead was created")).toHaveCount(0);
    await expect(panel(page)).toContainText("Open lead");
    await page.waitForTimeout(600);
    expect(seen.posts()).toHaveLength(1);
    expect(await createdEventsFor(PANEL_CONTACTS.malformed)).toBe(1);
  });
});

test.describe("Inbox lead panel: a lead id that is not a UUID", () => {
  test("a malformed openLead.id on the first read: a recoverable panel error, no crash; Try again reads again and the link then works", async ({
    page,
  }) => {
    const crashes = watchCrashes(page);
    await loginViaUi(page, PANEL_USERS.staff.email, undefined, "/inbox");
    const seen = recordLeadRequests(page);
    let calls = 0;
    await page.route(LEADS_FOR_CONTACT, async (route) => {
      if (++calls > 1) return route.continue();
      await tampered(route, (r) => {
        (r.openLead as { id: string }).id = LONE_SURROGATE;
        (r.leads as { id: string }[])[0]!.id = LONE_SURROGATE;
      });
    });
    await navigate(page, `/inbox?c=${await conversationIdFor(PANEL_CONTACTS.open)}`);
    const alert = panel(page).getByRole("alert");
    await expect(alert).toContainText("Lead information could not be loaded.");
    await expect(panel(page).getByRole("link", { name: /View lead/ })).toHaveCount(0);
    await expect(createButton(page)).toHaveCount(0);
    await expect(panel(page)).not.toContainText("No lead has been recorded");
    await crashes.expectNone();
    await expect(conversations(page)).toBeVisible(); // the rest of the Inbox is usable
    const before = seen.reads().length;

    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(panel(page)).toContainText("Open lead");
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
    expect(seen.reads().length).toBe(before + 1); // Retry is one GET
    expect(seen.posts()).toHaveLength(0);
    const [, current] = await leadsFor(PANEL_CONTACTS.open);
    const view = panel(page).getByRole("link", { name: "View lead (open, Qualified)" });
    await expect(view).toHaveAttribute("href", `/leads/${current!.id}`);
    await crashes.expectNone();
    await view.click();
    await expect(page).toHaveURL(new RegExp(`/leads/${current!.id}$`));
  });

  test("a malformed id in the history on a refresh: none of that answer is trusted, what was shown stays (marked possibly out of date), Try again recovers", async ({
    page,
  }) => {
    const crashes = watchCrashes(page);
    await openConversation(page, PANEL_USERS.staff.email, PANEL_CONTACTS.open);
    const [first, current] = await leadsFor(PANEL_CONTACTS.open);
    let bad = true;
    await page.route(LEADS_FOR_CONTACT, async (route) => {
      if (!bad) return route.continue();
      // the open lead is fine; only a historical lead is malformed: a partial acceptance would be possible
      await tampered(route, (r) => {
        (r.leads as { id: string }[]).at(-1)!.id = LONE_SURROGATE;
      });
    });
    await panel(page)
      .getByRole("button", { name: /Refresh/ })
      .click();
    const alert = panel(page).getByRole("alert");
    await expect(alert).toContainText("may be out of date");
    await expect(
      panel(page).getByRole("link", { name: "View lead (open, Qualified)" }),
    ).toHaveAttribute("href", `/leads/${current!.id}`);
    await expect(
      panel(page).getByRole("list", { name: "Previous leads" }).getByRole("link"),
    ).toHaveAttribute("href", `/leads/${first!.id}`);
    await crashes.expectNone();
    bad = false;
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
    await expect(panel(page)).toContainText("Open lead");
    await crashes.expectNone();
  });

  test("created:true committed, answered with a malformed lead id: one POST, unknown outcome, a recovery GET shows the real lead, no malformed link, no crash", async ({
    page,
  }) => {
    const crashes = watchCrashes(page);
    const seen = recordLeadRequests(page);
    await openConversation(page, PANEL_USERS.staff.email, PANEL_CONTACTS.badCreated);
    const contactId = await contactIdFor(PANEL_CONTACTS.badCreated);
    await page.route(CREATE_URL, (route) =>
      tampered(route, (r) => {
        expect(r.created).toBe(true);
        (r.lead as { id: string }).id = LONE_SURROGATE;
      }),
    );
    await createButton(page).click();
    const unknown = panel(page)
      .getByRole("alert")
      .filter({ hasText: "could not confirm whether the lead was created" });
    await expect(unknown).toBeVisible();
    await expect(unknown).toContainText("The request was not repeated.");
    await expect(panel(page).getByText("A new lead was created")).toHaveCount(0);
    const [real] = await leadsFor(PANEL_CONTACTS.badCreated);
    await expect(panel(page).getByRole("link", { name: "View lead (open, New)" })).toHaveAttribute(
      "href",
      `/leads/${real!.id}`,
    );
    await expect(page.locator('a[href*="%"]')).toHaveCount(0);
    await crashes.expectNone();
    await page.waitForTimeout(600);
    expect(seen.posts()).toHaveLength(1);
    expect(seen.reads(contactId)).toHaveLength(2); // the first read and the recovery read
    expect(await leadsFor(PANEL_CONTACTS.badCreated)).toHaveLength(1);
    expect(await createdEventsFor(PANEL_CONTACTS.badCreated)).toBe(1);
  });

  test("created:false (the lead already existed) answered with a malformed id: the same recovery, and still one lead", async ({
    page,
  }) => {
    const crashes = watchCrashes(page);
    const seen = recordLeadRequests(page);
    await openConversation(page, PANEL_USERS.staff.email, PANEL_CONTACTS.badExisting);
    // the lead appears behind the page's back (another tab): the panel still offers Create
    const forced = await pageFetch(page, "POST", "/api/leads", {
      body: { contactId: await contactIdFor(PANEL_CONTACTS.badExisting) },
    });
    expect(forced.status).toBe(201);
    await expect(createButton(page)).toBeVisible();
    await page.route(CREATE_URL, (route) =>
      tampered(route, (r) => {
        expect(r.created).toBe(false);
        (r.lead as { id: string }).id = LONE_SURROGATE;
      }),
    );
    await createButton(page).click();
    await expect(
      panel(page)
        .getByRole("alert")
        .filter({ hasText: "could not confirm whether the lead was created" }),
    ).toBeVisible();
    const [real] = await leadsFor(PANEL_CONTACTS.badExisting);
    await expect(panel(page).getByRole("link", { name: "View lead (open, New)" })).toHaveAttribute(
      "href",
      `/leads/${real!.id}`,
    );
    await crashes.expectNone();
    await page.waitForTimeout(600);
    expect(seen.posts()).toHaveLength(2); // the forced one and the click: never an automatic repeat
    expect(await leadsFor(PANEL_CONTACTS.badExisting)).toHaveLength(1);
    expect(await createdEventsFor(PANEL_CONTACTS.badExisting)).toBe(1);
  });
});

test.describe("Inbox lead panel: the signed-in account changes", () => {
  test("a creation held while the account changes is refused by the server; the Inbox stops, shows no lead data, requests nothing more, and does not claim nothing changed", async ({
    page,
    context,
  }) => {
    const seen = recordLeadRequests(page);
    await openConversation(page, PANEL_USERS.actor.email, PANEL_CONTACTS.actor);
    const hold = gate();
    await page.route(CREATE_URL, async (route) => {
      await hold.opened;
      await route.continue().catch(() => undefined);
    });
    await createButton(page).click();
    await expect.poll(() => seen.posts().length).toBe(1);

    const tab2 = await context.newPage();
    await navigate(tab2, "/inbox");
    await tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(tab2).toHaveURL(/\/login/);
    await loginViaUi(tab2, PANEL_USERS.admin.email, undefined, "/inbox");
    await expect(tab2.getByRole("main", { name: "Inbox" })).toBeVisible();

    hold.release(); // goes out with the OLD actor
    const notice = page
      .getByRole("alert")
      .filter({ hasText: "Your signed-in account has changed" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("may already have completed");
    await expect(notice).toContainText("No new message was submitted");
    await expect(notice).not.toContainText(/nothing was changed|was not cancelled|rolled back/i);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByRole("main").getByText(PANEL_CONTACTS.actor)).toHaveCount(0);
    const count = seen.all().length;
    await page.waitForTimeout(600);
    expect(seen.all()).toHaveLength(count);
    expect(await leadsFor(PANEL_CONTACTS.actor)).toHaveLength(0); // the server refused it
    await tab2.close();
  });

  test("the creation COMMITTED and was answered, the follow-up read is held, the account changes: the Inbox blocks, never says nothing changed, shows no old data, and the lead stays", async ({
    page,
    context,
  }) => {
    const seen = recordLeadRequests(page);
    await openConversation(page, PANEL_USERS.actor.email, PANEL_CONTACTS.actorAfter);
    const hold = gate();
    let reads = 0;
    await page.route(LEADS_FOR_CONTACT, async (route) => {
      if (++reads === 1) return route.continue();
      await hold.opened; // the read after the creation
      await route.continue().catch(() => undefined);
    });
    await createButton(page).click();
    await expect.poll(() => seen.reads().length).toBe(2); // the POST is answered; its follow-up read is on its way
    expect(await leadsFor(PANEL_CONTACTS.actorAfter)).toHaveLength(1); // committed
    expect(await createdEventsFor(PANEL_CONTACTS.actorAfter)).toBe(1);

    const tab2 = await switchAccount(context, INBOX_USERS.staff.email); // another ORGANIZATION
    hold.release();
    const notice = page
      .getByRole("alert")
      .filter({ hasText: "Your signed-in account has changed" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("may already have completed");
    await expect(notice).not.toContainText(/nothing was changed|was not cancelled|rolled back/i);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByRole("main").getByText(PANEL_CONTACTS.actorAfter)).toHaveCount(0);
    const count = seen.all().length;
    await page.waitForTimeout(600);
    expect(seen.all()).toHaveLength(count);
    expect(seen.posts()).toHaveLength(1);
    expect(await leadsFor(PANEL_CONTACTS.actorAfter)).toHaveLength(1); // blocking the page does not undo it
    expect(await createdEventsFor(PANEL_CONTACTS.actorAfter)).toBe(1);

    await page.unrouteAll({ behavior: "wait" });
    await notice.getByRole("button", { name: "Reload as the current account" }).click();
    await expect(page.getByRole("main", { name: "Inbox" })).toBeVisible();
    await expect(page.getByText(PANEL_CONTACTS.actorAfter)).toHaveCount(0); // the other organization's inbox
    await tab2.close();
  });

  test("an unknown outcome whose recovery read meets the account change: blocked, honest notice, the POST is not repeated, the old lead never reappears", async ({
    page,
    context,
  }) => {
    const seen = recordLeadRequests(page);
    await openConversation(page, PANEL_USERS.actor.email, PANEL_CONTACTS.actorUnknown);
    const hold = gate();
    let reads = 0;
    await page.route(LEADS_FOR_CONTACT, async (route) => {
      if (++reads === 1) return route.continue();
      await hold.opened;
      await route.continue().catch(() => undefined);
    });
    await page.route(CREATE_URL, async (route) => {
      await route.fetch(); // committed...
      await route.abort("connectionreset"); // ...and never answered
    });
    await createButton(page).click();
    await expect.poll(() => seen.reads().length).toBe(2); // the recovery read, held
    expect(await createdEventsFor(PANEL_CONTACTS.actorUnknown)).toBe(1);

    const tab2 = await switchAccount(context, INBOX_USERS.staff.email);
    hold.release();
    const notice = page
      .getByRole("alert")
      .filter({ hasText: "Your signed-in account has changed" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("may already have completed");
    await expect(notice).not.toContainText(/nothing was changed|was not cancelled|rolled back/i);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByRole("main").getByText(PANEL_CONTACTS.actorUnknown)).toHaveCount(0);
    const count = seen.all().length;
    await page.waitForTimeout(600);
    expect(seen.all()).toHaveLength(count);
    expect(seen.posts()).toHaveLength(1);
    expect(await leadsFor(PANEL_CONTACTS.actorUnknown)).toHaveLength(1);

    await page.unrouteAll({ behavior: "wait" });
    await notice.getByRole("button", { name: "Reload as the current account" }).click();
    await expect(page.getByRole("main", { name: "Inbox" })).toBeVisible();
    await expect(page.getByText(PANEL_CONTACTS.actorUnknown)).toHaveCount(0);
    await tab2.close();
  });

  test("no mutation at all: an actor change found by a plain read blocks the Inbox with the same conservative notice, and the old data goes", async ({
    page,
    context,
  }) => {
    const seen = recordLeadRequests(page);
    await openConversation(page, PANEL_USERS.actor.email, PANEL_CONTACTS.noMutation);
    const tab2 = await switchAccount(context, INBOX_USERS.staff.email);
    await panel(page)
      .getByRole("button", { name: /Refresh/ })
      .click(); // the page learns of the change from this request
    const notice = page
      .getByRole("alert")
      .filter({ hasText: "Your signed-in account has changed" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("has stopped using information from that session");
    await expect(notice).toContainText("may already have completed");
    await expect(notice).toContainText("cannot confirm its outcome");
    await expect(notice).not.toContainText(/nothing was changed|was not cancelled|rolled back/i);
    await expect(panel(page)).toHaveCount(0);
    expect(seen.posts()).toHaveLength(0);
    const count = seen.all().length;
    await page.waitForTimeout(500);
    expect(seen.all()).toHaveLength(count);
    expect(await leadsFor(PANEL_CONTACTS.noMutation)).toHaveLength(0);
    await tab2.close();
  });
});

test.describe("Inbox lead panel: keyboard and small screens", () => {
  test("390px: the panel is reachable through Details, fits without sideways scrolling; Enter creates once, repeated keys send nothing more", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const seen = recordLeadRequests(page);
    await loginViaUi(
      page,
      PANEL_USERS.staff.email,
      undefined,
      `/inbox?c=${await conversationIdFor(PANEL_CONTACTS.mobile)}`,
    );
    await page.getByRole("button", { name: "Details" }).click();
    await expect(panel(page)).toBeVisible();
    await expect(createButton(page)).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);

    const hold = gate();
    await page.route(CREATE_URL, async (route) => {
      await hold.opened;
      await route.continue();
    });
    await createButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(createButton(page)).toHaveText("Creating lead…");
    await expect(createButton(page)).toBeFocused(); // aria-disabled, not disabled: focus stays
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    hold.release();
    const done = panel(page).getByRole("status").filter({ hasText: "A new lead was created" });
    await expect(done).toBeVisible();
    await expect(done).toBeFocused();
    await page.waitForTimeout(400);
    expect(seen.posts()).toHaveLength(1);
    expect(await leadsFor(PANEL_CONTACTS.mobile)).toHaveLength(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
  });
});
