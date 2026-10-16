import type { Page, Request } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { conversationIdFor, leadsFor } from "./support/db";
import {
  DETAIL_CONTACTS,
  DETAIL_HOSTILE,
  DETAIL_STATUS_CHANGES,
  DETAIL_USERS,
  LEADS_CONTACTS,
  LEADS_USERS,
} from "./support/identities";
import { loginViaUi, navigate, pageFetch } from "./support/ui";

// The lead page (Phase 07D-3) in a real browser against the production build and a disposable database. Organization F's leads
// are made through the real lead services and the real reconciler (scripts/e2e-seed.ts, seedLeadDetail); organization E (the
// Leads page specs) owns a lead that F must never see.

const EVENTS_RICH = DETAIL_STATUS_CHANGES + 2; // CREATED + TOUCH_LINKED + the status changes

const leadId = async (contact: string, nth = 0) => (await leadsFor(contact))[nth]!.id;
const openLead = async (page: Page, email: string, id: string, query = "") => {
  await loginViaUi(page, email, undefined, `/leads/${id}${query}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
};
const main = (page: Page) => page.locator("main");
const region = (page: Page, name: string) => page.getByRole("region", { name });
const historyItems = (page: Page) =>
  page.getByRole("list", { name: "Lead history, newest first" }).getByRole("listitem");
const historyStatus = (page: Page) => region(page, "Lead history").locator("p[role=status]");
const refresh = (page: Page) => page.getByRole("button", { name: "Refresh" });
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** Every /api/leads request this page sends, with the actor it asserts. */
function recordLeadRequests(page: Page) {
  const seen: { url: URL; actor: string | undefined }[] = [];
  page.on("request", (r: Request) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/leads"))
      seen.push({ url, actor: r.headers()["x-expected-actor"] });
  });
  return seen;
}

/**
 * Answers the matching request at once from the server, then holds the answer back until released: the page cannot tell it from a
 * slow network, and the answer can be made to arrive after the page has moved on. `mutate` plants a marker so a leak would show.
 */
async function holdAnswers(
  page: Page,
  match: RegExp,
  mutate?: (json: Record<string, unknown>) => void,
) {
  const held: { release: () => Promise<void> }[] = [];
  await page.route(match, async (route) => {
    let response;
    try {
      response = await route.fetch();
    } catch {
      return; // the page abandoned it
    }
    const json = (await response.json()) as Record<string, unknown>;
    mutate?.(json);
    await new Promise<void>((resolveHeld) => {
      held.push({
        release: async () => {
          try {
            await route.fulfill({ response, json });
          } catch {
            // the page aborted it (the expected outcome for an abandoned request)
          }
          resolveHeld();
        },
      });
    });
  });
  return held;
}

/** Holds the matching request itself (it reaches the server only when released, with the headers it was sent with). */
async function holdRequests(page: Page, match: RegExp) {
  const held: { release: () => Promise<void> }[] = [];
  await page.route(match, async (route) => {
    await new Promise<void>((resolveHeld) => {
      held.push({
        release: async () => {
          try {
            await route.continue();
          } catch {
            // aborted
          }
          resolveHeld();
        },
      });
    });
  });
  return held;
}

test.describe("Lead page: opening a lead", () => {
  test("from the list, by keyboard or mouse; the filters ride along so Back to leads returns to the same list", async ({
    page,
  }) => {
    await loginViaUi(page, DETAIL_USERS.staff.email, undefined, "/leads");
    await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
    await page.getByRole("group", { name: "State" }).getByRole("button", { name: "Open" }).click();
    await expect(page).toHaveURL(/\/leads\?state=open$/);

    // a real link on the contact name: reachable and operable from the keyboard
    const link = page.getByRole("link", { name: DETAIL_CONTACTS.plain });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}\?state=open$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.plain);
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Leads" }),
    ).toHaveAttribute("aria-current", "page");

    const back = page.getByRole("link", { name: "Back to leads" });
    await expect(back).toHaveAttribute("href", "/leads?state=open");
    await back.click();
    await expect(page).toHaveURL(/\/leads\?state=open$/);
    await expect(
      page.getByRole("group", { name: "State" }).getByRole("button", { name: "Open" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("the way back is built from validated filters only: junk or hostile query values never reach the link", async ({
    page,
  }) => {
    const id = await leadId(DETAIL_CONTACTS.plain);
    await openLead(
      page,
      DETAIL_USERS.staff.email,
      id,
      "?state=javascript:alert(1)&q=x&next=https://evil.example&status=NOPE",
    );
    await expect(page.getByRole("link", { name: "Back to leads" })).toHaveAttribute(
      "href",
      "/leads",
    );
    await navigate(page, `/leads/${id}?state=closed&q=Lead+Closed&junk=1`);
    await expect(page.getByRole("link", { name: "Back to leads" })).toHaveAttribute(
      "href",
      "/leads?state=closed&q=Lead+Closed",
    );
  });

  test("signed out: sent to sign in and, afterwards, to the lead", async ({ page }) => {
    const id = await leadId(DETAIL_CONTACTS.plain);
    await navigate(page, `/leads/${id}`);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fleads%2F${id}`));
    expect((await pageFetch(page, "GET", `/api/leads/${id}`)).status).toBe(401);
    expect((await pageFetch(page, "GET", `/api/leads/${id}/events`)).status).toBe(401);
  });
});

test.describe("Lead page: tenant isolation", () => {
  test("another organization's lead, a missing lead and a malformed id look exactly the same, and say nothing about either", async ({
    page,
  }) => {
    const foreign = await leadId(LEADS_CONTACTS.otherOrg); // organization E
    const rich = await leadId(DETAIL_CONTACTS.rich); // organization F
    await loginViaUi(page, DETAIL_USERS.staff.email, undefined, "/leads");

    const texts: string[] = [];
    const statuses: number[] = [];
    for (const id of [foreign, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      statuses.push((await navigate(page, `/leads/${id}`))!.status());
      await expect(
        page.getByRole("heading", { level: 1, name: "Lead not available" }),
      ).toBeVisible();
      await expect(main(page).getByRole("alert")).toHaveText(
        "This lead or contact is not available.",
      );
      texts.push(await main(page).innerText());
      expect(await page.content()).not.toContain(LEADS_CONTACTS.otherOrg);
      expect(await page.content()).not.toContain(DETAIL_CONTACTS.rich);
    }
    expect(new Set(texts).size).toBe(1);
    // the response status is the same too (a streamed not-found page is a 200 in Next; the API's answer is the 404 checked below)
    expect(new Set(statuses).size).toBe(1);

    // the API gives the same answer for the same three, for the detail and for the history
    for (const id of [foreign, "00000000-0000-4000-8000-000000000000", "not-a-uuid"])
      for (const path of [`/api/leads/${id}`, `/api/leads/${id}/events`]) {
        const r = await pageFetch(page, "GET", path);
        expect(r.status, path).toBe(404);
        expect(r.text, path).not.toContain(LEADS_CONTACTS.otherOrg);
      }

    // and the other way round: organization E cannot open organization F's lead
    await page.getByRole("button", { name: "Sign out" }).click();
    await loginViaUi(page, LEADS_USERS.otherOrg.email, undefined, `/leads/${rich}`);
    await expect(page.getByRole("heading", { level: 1, name: "Lead not available" })).toBeVisible();
    expect(await main(page).innerText()).toBe(texts[0]);
    expect(await page.content()).not.toContain(DETAIL_CONTACTS.rich);
    expect((await pageFetch(page, "GET", `/api/leads/${rich}`)).status).toBe(404);
    expect((await pageFetch(page, "GET", `/api/leads/${rich}/events`)).status).toBe(404);
  });
});

test.describe("Lead page: contents", () => {
  test("a staff-created lead: summary, contact, conversation, evidence and history read correctly", async ({
    page,
  }) => {
    const id = await leadId(DETAIL_CONTACTS.rich);
    await openLead(page, DETAIL_USERS.staff.email, id);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.rich);
    await expect(
      page.getByText("The name comes from the customer's WhatsApp profile and is not verified."),
    ).toBeVisible();

    const summary = region(page, "Lead summary");
    await expect(summary).toContainText("Qualified"); // 43 changes, the last one NEW -> QUALIFIED
    await expect(summary).toContainText("Open");
    await expect(summary).toContainText("Created by staff");
    await expect(summary).toContainText("Meta ad referral recorded");
    await expect(summary).toContainText(
      "not a confirmed registration, payment or marketing consent",
    );
    for (const label of ["Created", "Current cycle started", "Last status change"])
      await expect(summary.getByText(label, { exact: true })).toBeVisible();
    await expect(summary.getByText("Closed", { exact: true })).toHaveCount(0); // an open lead has no closing time
    await expect(summary.locator("time")).toHaveCount(3);

    const contact = region(page, "Contact");
    await expect(contact).toContainText("WhatsApp profile name");
    await expect(contact).toContainText(DETAIL_CONTACTS.rich);
    await expect(contact).toContainText("Last observed number");
    await expect(contact).toContainText("not verified as a student's identity");
    await expect(contact).not.toContainText("Archived");

    // a heading outline a screen reader can follow
    const headings = await page
      .locator("main h1, main h2, main h3")
      .evaluateAll((hs) => hs.map((h) => `${h.tagName} ${h.textContent?.trim()}`));
    expect(headings).toEqual([
      `H1 ${DETAIL_CONTACTS.rich}`,
      "H2 Lead summary",
      "H2 Contact",
      "H2 Related conversations",
      "H2 Referral evidence",
      "H3 Evidence linked to this lead",
      "H3 Other evidence for this contact — not linked to this lead",
      "H2 Lead history",
    ]);
  });

  test("a closed automatic lead: closing time, the touch that started it, history of the system and of the staff member", async ({
    page,
  }) => {
    const id = await leadId(DETAIL_CONTACTS.reopened, 0);
    await openLead(page, DETAIL_USERS.staff.email, id);
    const summary = region(page, "Lead summary");
    await expect(summary).toContainText("Not interested");
    await expect(summary).toContainText("Closed");
    await expect(summary.locator("dt", { hasText: /^Closed$/ })).toBeVisible();
    await expect(summary).toContainText("Created automatically from a Meta ad referral");

    const linked = region(page, "Referral evidence").getByRole("list", {
      name: "Evidence linked to this lead",
    });
    await expect(linked.getByRole("listitem")).toHaveCount(1);
    await expect(linked).toContainText("Started this lead");
    await expect(linked).toContainText("Reopened ad");

    const items = historyItems(page);
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText(
      "Detail Staff changed the status from New to Not interested",
    );
    const rest = (await items.allTextContents()).slice(1).join(" | ");
    expect(rest).toContain("Lead created automatically from a Meta ad referral");
    expect(rest).toContain("Referral evidence linked (Meta ad)");
    expect(rest).not.toContain("Detail Staff"); // the system acted: no staff member is named for it
    await expect(historyStatus(page)).toHaveText(
      "3 events shown. This is the start of the recorded history.",
    );
    await expect(page.getByRole("button", { name: "Load older events" })).toHaveCount(0);
  });

  test("the reopened contact's second lead: the first lead's evidence is shown as belonging to ANOTHER lead, never as its own", async ({
    page,
  }) => {
    const id = await leadId(DETAIL_CONTACTS.reopened, 1);
    await openLead(page, DETAIL_USERS.staff.email, id);
    const summary = region(page, "Lead summary");
    await expect(summary).toContainText("Created by staff");
    await expect(summary).toContainText("No referral recorded");
    await expect(summary).toContainText("does not mean the customer found the class without an ad");

    const evidence = region(page, "Referral evidence");
    await expect(evidence).toContainText("No referral evidence is linked to this lead.");
    await expect(evidence.getByRole("list", { name: "Evidence linked to this lead" })).toHaveCount(
      0,
    );
    const others = evidence.getByRole("list", { name: "Other evidence for this contact" });
    await expect(others.getByRole("listitem")).toHaveCount(1);
    await expect(others).toContainText("Linked to another lead of this contact");
    await expect(others).toContainText("Reopened ad");
    await expect(others).not.toContainText("Started this lead");
    await expect(evidence).toContainText("This is not evidence for this lead.");
  });

  test("an automatic lead that is still open, and a lead with no evidence and no conversation", async ({
    page,
  }) => {
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.auto));
    await expect(region(page, "Lead summary")).toContainText("Meta ad referral recorded");
    await expect(region(page, "Referral evidence")).toContainText("Auto ad");
    await expect(region(page, "Referral evidence")).toContainText("Started this lead");
    await expect(region(page, "Related conversations").getByRole("link")).toHaveCount(1);

    await navigate(page, `/leads/${await leadId(DETAIL_CONTACTS.plain)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.plain);
    await expect(region(page, "Related conversations")).toContainText(
      "No WhatsApp conversation is recorded for this contact.",
    );
    await expect(region(page, "Related conversations").getByRole("link")).toHaveCount(0);
    await expect(region(page, "Referral evidence")).toContainText(
      "No referral evidence is linked to this lead.",
    );
    await expect(region(page, "Referral evidence")).toContainText(
      "No other referral evidence is recorded for this contact.",
    );
    await expect(historyItems(page)).toHaveCount(1); // CREATED
  });
});

test.describe("Lead page: referral evidence", () => {
  test("linked evidence, evidence that is not linked, and provider text that stays plain text", async ({
    page,
  }) => {
    const external: string[] = [];
    page.on("request", (r) => {
      const host = new URL(r.url()).hostname;
      if (!["127.0.0.1", "localhost"].includes(host)) external.push(r.url());
    });
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.rich));

    const evidence = region(page, "Referral evidence");
    const linked = evidence.getByRole("list", { name: "Evidence linked to this lead" });
    await expect(evidence).toContainText("1 referral record is linked to this lead.");
    await expect(linked.getByRole("listitem")).toHaveCount(1);
    await expect(linked).toContainText("Meta ad");
    await expect(linked).toContainText("Ad text as provided by Meta (not verified)");
    // the hostile headline and body appear as the characters they are
    await expect(linked).toContainText(DETAIL_HOSTILE.headline);
    await expect(linked).toContainText('<img src=x onerror="window.__xss=1">');
    await expect(linked).toContainText('<a href="https://evil.example/pay">here</a>');
    await expect(linked).toContainText("javascript:alert(1)");
    await expect(linked).toContainText("http://evil.example/steal");
    await expect(linked.locator("a, img, script, b, iframe, object, embed, form")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    // recorded facts: origin and path only, the end of the click id only, no query string, no fragment
    await expect(linked).toContainText("Source ID");
    await expect(linked).toContainText("120000000000001");
    await expect(linked).toContainText("https://fb.me/abc");
    await expect(linked).not.toContainText("utm=secret");
    await expect(linked).not.toContainText("#frag");
    await expect(linked).toContainText("https://cdn.example.test/ad.jpg");
    await expect(linked).not.toContainText("sig=x");
    await expect(linked).toContainText("Click ID ends with");
    await expect(linked).toContainText("…stuv");
    await expect(linked).not.toContainText("ARAkLkA8rmlFeiCktEJQ");
    await expect(linked).not.toContainText("Started this lead"); // staff made this lead; the touch was linked later
    // none of the evidence is something the page can navigate to
    await expect(evidence.getByRole("link")).toHaveCount(0);

    // evidence for the CONTACT that is not for this lead: separate, labelled, newest first
    await expect(
      evidence.getByRole("heading", {
        level: 3,
        name: "Other evidence for this contact — not linked to this lead",
      }),
    ).toBeVisible();
    const others = evidence.getByRole("list", { name: "Other evidence for this contact" });
    await expect(others.getByRole("listitem")).toHaveCount(2);
    await expect(others.getByRole("listitem").nth(0)).toContainText(
      "A later ad, not yet considered",
    );
    await expect(others.getByRole("listitem").nth(0)).toContainText("Not linked to any lead yet");
    await expect(others.getByRole("listitem").nth(1)).toContainText(
      "Old campaign, before this lead",
    );
    await expect(others.getByRole("listitem").nth(1)).toContainText(
      "Not linked: evidence belongs to an earlier lead cycle",
    );
    await expect(others).not.toContainText("received before");
    await expect(linked).not.toContainText("Old campaign");
    await expect(linked).not.toContainText("A later ad");
    await expect(evidence).toContainText("2 other records for this contact.");

    // nothing from the provider text was requested or followed
    expect(external).toEqual([]);
  });
});

test.describe("Lead page: history", () => {
  test("newest first, 20 at a time with real cursors, no duplicates, honest about where it ends", async ({
    page,
  }) => {
    const seen = recordLeadRequests(page);
    const id = await leadId(DETAIL_CONTACTS.rich);
    await openLead(page, DETAIL_USERS.staff.email, id);

    const items = historyItems(page);
    await expect(items).toHaveCount(20);
    await expect(historyStatus(page)).toHaveText("20 events shown. Older events can be loaded.");
    // the newest change is first: 43 changes alternate NEW -> QUALIFIED, QUALIFIED -> NEW ...; the 43rd is NEW -> QUALIFIED
    await expect(items.nth(0)).toContainText(
      "Detail Staff changed the status from New to Qualified",
    );
    await expect(items.nth(1)).toContainText(
      "Detail Staff changed the status from Qualified to New",
    );
    await expect(items.nth(0).locator("time")).toHaveCount(1);
    await expect(items.nth(0)).toContainText("Status change");
    expect(seen).toHaveLength(0); // the first page came with the lead

    const older = page.getByRole("button", { name: "Load older events" });
    await older.click();
    await expect(items).toHaveCount(40);
    await expect(historyStatus(page)).toHaveText("40 events shown. Older events can be loaded.");
    await older.click();
    await expect(items).toHaveCount(EVENTS_RICH);
    await expect(older).toHaveCount(0);
    await expect(historyStatus(page)).toHaveText(
      `${EVENTS_RICH} events shown. This is the start of the recorded history.`,
    );

    // the order is the server's: statuses first, then (in either order: they happened in one transaction) the two oldest
    const texts = await items.allTextContents();
    expect(
      texts.slice(0, DETAIL_STATUS_CHANGES).every((t) => t.includes("changed the status")),
    ).toBe(true);
    const oldest = texts.slice(DETAIL_STATUS_CHANGES).join(" | ");
    expect(oldest).toContain("Detail Staff created the lead");
    expect(oldest).toContain("Referral evidence linked (Meta ad)");
    // no event twice: the statuses alternate strictly, so any repeated or skipped row would break the pattern
    texts
      .slice(0, DETAIL_STATUS_CHANGES)
      .forEach((t, i) =>
        expect(t).toContain(i % 2 === 0 ? "from New to Qualified" : "from Qualified to New"),
      );

    // two page requests: each continues from the previous cursor, with the page size the screen asked for
    expect(seen).toHaveLength(2);
    const [first, second] = seen.map((s) => s.url);
    expect(first!.pathname).toBe(`/api/leads/${id}/events`);
    expect(first!.searchParams.get("limit")).toBe("20");
    expect(first!.searchParams.get("cursor")).toBeTruthy();
    expect(second!.searchParams.get("cursor")).toBeTruthy();
    expect(second!.searchParams.get("cursor")).not.toBe(first!.searchParams.get("cursor"));
    for (const s of seen) expect(s.actor).toBeTruthy();
  });

  test("a failed page can be retried, and what was loaded stays", async ({ page }) => {
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.rich));
    let calls = 0;
    await page.route(/\/api\/leads\/[^/]+\/events/, async (route) => {
      if (++calls > 1) return route.continue();
      await route.fulfill({
        status: 500,
        json: { error: { code: "INTERNAL_ERROR", message: "x" } },
      });
    });
    await page.getByRole("button", { name: "Load older events" }).click();
    await expect(page.getByText("Older events could not be loaded", { exact: true })).toBeVisible();
    await expect(historyItems(page)).toHaveCount(20); // nothing was lost
    await expect(region(page, "Lead summary")).toBeVisible(); // and the rest of the page is untouched
    await expect(page.getByText("Referral evidence").first()).toBeVisible();
    expect(await historyStatus(page).innerText()).toBe(""); // no claim about the history while it is in doubt
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(historyItems(page)).toHaveCount(40);
    await expect(page.getByText("Older events could not be loaded")).toHaveCount(0);
  });

  test("a page with a malformed event ({events:[null]}) is refused whole: loading ends, the 20 stay, Retry asks for the same cursor and adds the real page once", async ({
    page,
  }) => {
    const seen = recordLeadRequests(page);
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.rich));
    let calls = 0;
    await page.route(/\/api\/leads\/[^/]+\/events/, async (route) => {
      if (++calls > 1) return route.continue();
      await route.fulfill({ status: 200, json: { events: [null], nextCursor: null } });
    });
    const older = page.getByRole("button", { name: "Load older events" });
    await older.click();
    const alert = page.getByRole("alert").filter({ hasText: "Older events could not be loaded" });
    await expect(alert).toBeVisible();
    await expect(historyItems(page)).toHaveCount(20);
    await expect(older).toHaveText("Load older events"); // not "Loading…" for good
    await expect(older).toHaveAttribute("aria-disabled", "false");
    await expect(refresh(page)).toBeEnabled();
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(historyItems(page)).toHaveCount(40);
    await expect(alert).toHaveCount(0);
    const texts = await historyItems(page).allTextContents();
    expect(new Set(texts.map((t, i) => `${i}:${t}`)).size).toBe(40);
    // no row twice: the statuses alternate strictly
    texts.forEach((t, i) =>
      expect(t).toContain(i % 2 === 0 ? "from New to Qualified" : "from Qualified to New"),
    );
    const cursors = seen
      .filter((s) => s.url.pathname.endsWith("/events"))
      .map((s) => s.url.searchParams.get("cursor"));
    expect(cursors).toHaveLength(2);
    expect(cursors[1]).toBe(cursors[0]); // Retry repeated the same page
  });

  test("a lead from before lead history has an honest, empty history", async ({ page }) => {
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.paid));
    await expect(historyStatus(page)).toHaveText("No history is recorded for this lead.");
    await expect(historyItems(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Load older events" })).toHaveCount(0);
    await expect(region(page, "Lead summary")).toContainText(
      "Not recorded (this lead predates lead history)",
    );
  });
});

test.describe("Lead page: read-only", () => {
  test("a reserved status is explained, not an error, and nothing offers to change it (staff)", async ({
    page,
  }) => {
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.paid));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.paid);
    const summary = region(page, "Lead summary");
    await expect(summary).toContainText("Paid");
    await expect(summary).toContainText("Read-only");
    await expect(summary).toContainText("registration and payment workflow");
    await expect(main(page).getByRole("alert")).toHaveCount(0);
    // the only button on the page is Refresh
    await expect(main(page).getByRole("button")).toHaveText(["Refresh"]);
    await expect(main(page).getByRole("combobox")).toHaveCount(0);
    await expect(main(page).locator("form, input, select, textarea")).toHaveCount(0);
  });

  test("a viewer can read the lead, is told their role cannot change it, and has no way to try", async ({
    page,
  }) => {
    const seen = recordLeadRequests(page);
    await openLead(page, DETAIL_USERS.viewer.email, await leadId(DETAIL_CONTACTS.rich));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.rich);
    await expect(region(page, "Lead summary")).toContainText(
      "Your role can view this lead but cannot change it.",
    );
    await expect(region(page, "Referral evidence")).toContainText("Meta ad");
    await expect(historyItems(page)).toHaveCount(20);
    await expect(main(page).getByRole("button")).toHaveText(["Refresh", "Load older events"]);
    await page.getByRole("button", { name: "Load older events" }).click();
    await expect(historyItems(page)).toHaveCount(40);
    // reads only
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.url.pathname).toMatch(/^\/api\/leads\/[^/]+\/events$/);
  });
});

test.describe("Lead page: conversations", () => {
  test("the link uses the Inbox's own deep link (?c=) and opens that conversation", async ({
    page,
  }) => {
    const conversationId = await conversationIdFor(DETAIL_CONTACTS.rich);
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.rich));
    const conversations = region(page, "Related conversations");
    await expect(conversations.getByRole("listitem")).toHaveCount(1);
    await expect(conversations).toContainText("Business number +94 77 000 0000");
    const link = conversations.getByRole("link", { name: /Open in Inbox/ });
    await expect(link).toHaveAttribute("href", `/inbox?c=${conversationId}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/inbox\\?c=${conversationId}$`));
    await expect(page.getByRole("heading", { name: DETAIL_CONTACTS.rich }).first()).toBeVisible();
    await expect(page.getByText("hello").first()).toBeVisible();
  });
});

test.describe("Lead page: states and the request lifecycle", () => {
  test("refreshing: announced, the old data stays until the answer, and a newer state replaces it", async ({
    page,
  }) => {
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.plain));
    const held = await holdAnswers(page, /\/api\/leads\/[^/?]+$/, (json) => {
      (json.lead as { contact: { label: { displayName: string } } }).contact.label.displayName =
        "Renamed On Refresh";
    });
    await refresh(page).click();
    await expect(page.locator("main p[role=status]").first()).toHaveText("Refreshing lead…");
    await expect(refresh(page)).toBeDisabled();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.plain);
    await expect.poll(() => held.length).toBe(1);
    await held[0]!.release();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Renamed On Refresh");
    await expect(refresh(page)).toBeEnabled();
  });

  test("a failed refresh keeps the loaded lead, says it may be out of date and can be retried", async ({
    page,
  }) => {
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.plain));
    let calls = 0;
    await page.route(/\/api\/leads\/[^/?]+$/, async (route) => {
      if (++calls > 1) return route.continue();
      await route.fulfill({
        status: 500,
        json: { error: { code: "INTERNAL_ERROR", message: "boom" } },
      });
    });
    await refresh(page).click();
    const alert = page.getByRole("alert").filter({ hasText: "The lead could not be refreshed" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("may be out of date");
    await expect(alert).not.toContainText("boom"); // the server's message is never shown
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.plain);
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("The lead could not be refreshed")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.plain);
  });

  test("a refresh whose answer has contact.label null is a failed refresh, not the error screen: the lead stays, Retry recovers", async ({
    page,
  }) => {
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.plain));
    let calls = 0;
    await page.route(/\/api\/leads\/[^/?]+$/, async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { contact: { label: unknown } };
      if (++calls === 1) json.contact.label = null; // otherwise the real, valid answer
      await route.fulfill({ response, json });
    });
    await refresh(page).click();
    const alert = page.getByRole("alert").filter({ hasText: "The lead could not be refreshed" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("may be out of date");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.plain);
    await expect(region(page, "Contact")).toContainText(DETAIL_CONTACTS.plain);
    await expect(region(page, "Lead summary")).toBeVisible();
    await expect(refresh(page)).toBeEnabled();
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => calls).toBe(2);
    await expect(refresh(page)).toBeEnabled(); // the retried read finished
    await expect(alert).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.plain);
    await expect(region(page, "Contact")).toContainText(DETAIL_CONTACTS.plain);
    // (an uncaught page error, which is what the error screen would come from, fails the test: see support/fixtures.ts)
  });

  test("a lead that is gone, and a session that ended, are told apart from a failure", async ({
    page,
  }) => {
    const id = await leadId(DETAIL_CONTACTS.plain);
    await openLead(page, DETAIL_USERS.staff.email, id);
    await page.route(/\/api\/leads\/[^/?]+$/, (route) =>
      route.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "x" } } }),
    );
    await refresh(page).click();
    const alert = page.getByRole("alert").filter({ hasText: "Your session has ended" });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(`/leads/${id}`)}`,
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.plain);

    await page.unrouteAll({ behavior: "wait" });
    await page.route(/\/api\/leads\/[^/?]+$/, (route) =>
      route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "x" } } }),
    );
    await refresh(page).click();
    await expect(page.getByRole("heading", { level: 1, name: "Lead not available" })).toBeVisible();
    await expect(main(page).getByText(DETAIL_CONTACTS.plain)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to leads" })).toBeVisible();
  });

  test("an answer that arrives after the person has moved on to another lead is never shown there", async ({
    page,
  }) => {
    const seen = recordLeadRequests(page);
    const richId = await leadId(DETAIL_CONTACTS.rich);
    await openLead(page, DETAIL_USERS.staff.email, richId);

    // a refresh and a Load older of the FIRST lead are answered by the server but held back
    const refreshes = await holdAnswers(page, /\/api\/leads\/[^/?]+$/, (json) => {
      (json.lead as { contact: { label: { displayName: string } } }).contact.label.displayName =
        "STALE LEAD NAME";
    });
    await refresh(page).click();
    await expect.poll(() => refreshes.length).toBe(1);

    // move on (the Back link works while a request runs), open another lead
    await page.getByRole("link", { name: "Back to leads" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
    await page.getByRole("link", { name: DETAIL_CONTACTS.plain }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.plain);

    await refreshes[0]!.release();
    await page.waitForTimeout(500);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.plain);
    await expect(main(page).getByText("STALE LEAD NAME")).toHaveCount(0);
    await expect(main(page).getByText(DETAIL_CONTACTS.rich)).toHaveCount(0);
    expect(seen.every((s) => s.actor)).toBe(true);

    // the same for the history: Load older held, then the person leaves
    await page.getByRole("link", { name: "Back to leads" }).click();
    await page.getByRole("link", { name: DETAIL_CONTACTS.rich }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.rich);
    await page.unrouteAll({ behavior: "wait" });
    const olders = await holdAnswers(page, /\/api\/leads\/[^/]+\/events/, (json) => {
      (json.events as { actorName: string | null }[])[0]!.actorName = "STALE EVENT ACTOR";
    });
    await page.getByRole("button", { name: "Load older events" }).click();
    await expect.poll(() => olders.length).toBe(1);
    await page.getByRole("link", { name: "Back to leads" }).click();
    await page.getByRole("link", { name: DETAIL_CONTACTS.plain }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(DETAIL_CONTACTS.plain);
    await olders[0]!.release();
    await page.waitForTimeout(500);
    await expect(main(page).getByText("STALE EVENT ACTOR")).toHaveCount(0);
    await expect(historyItems(page)).toHaveCount(1);
  });
});

test.describe("Lead page: the signed-in account changes", () => {
  test("the page stops, shows nothing more of the old lead, requests nothing, and reloads as the new account", async ({
    page,
    context,
  }) => {
    const seen = recordLeadRequests(page);
    const id = await leadId(DETAIL_CONTACTS.rich);
    await openLead(page, DETAIL_USERS.actor.email, id);
    await expect(historyItems(page)).toHaveCount(20);

    const tab2 = await context.newPage();
    await navigate(tab2, "/leads");
    await tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(tab2).toHaveURL(/\/login/);
    await loginViaUi(tab2, LEADS_USERS.otherOrg.email, undefined, "/leads");
    await expect(tab2.getByRole("heading", { name: "Leads" })).toBeVisible();

    await refresh(page).click(); // asserts the OLD actor: refused by the server
    const notice = page
      .getByRole("alert")
      .filter({ hasText: "Your signed-in account has changed" });
    await expect(notice).toBeVisible();
    await expect(main(page).getByText(DETAIL_CONTACTS.rich)).toHaveCount(0);
    await expect(historyItems(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Load older events" })).toHaveCount(0);
    await expect(refresh(page)).toHaveCount(0);
    const count = seen.length;
    await page.waitForTimeout(500);
    expect(seen).toHaveLength(count); // nothing more is requested

    // the new account is organization E: it cannot see organization F's lead, and nothing of F appears
    await page.getByRole("button", { name: "Reload as the current account" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Lead not available" })).toBeVisible();
    expect(await page.content()).not.toContain(DETAIL_CONTACTS.rich);
    await tab2.close();
  });

  test("a request that was held while the account changed is refused when it finally goes out, and nothing of it is shown", async ({
    page,
    context,
  }) => {
    const id = await leadId(DETAIL_CONTACTS.rich);
    await openLead(page, DETAIL_USERS.actor2.email, id);
    const held = await holdRequests(page, /\/api\/leads\/[^/]+\/events/);
    await page.getByRole("button", { name: "Load older events" }).click();
    await expect.poll(() => held.length).toBe(1);
    await expect(page.getByRole("button", { name: "Loading…" })).toBeDisabled();

    const tab2 = await context.newPage();
    await navigate(tab2, "/leads");
    await tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(tab2).toHaveURL(/\/login/);
    await loginViaUi(tab2, LEADS_USERS.otherOrg.email, undefined, "/leads");
    await expect(tab2.getByRole("heading", { name: "Leads" })).toBeVisible();

    await held[0]!.release(); // goes out with the old actor: the server answers 409 ACTOR_CHANGED
    await expect(
      page.getByRole("alert").filter({ hasText: "Your signed-in account has changed" }),
    ).toBeVisible();
    await expect(main(page).getByText(DETAIL_CONTACTS.rich)).toHaveCount(0);
    await expect(historyItems(page)).toHaveCount(0);
    await tab2.close();
  });
});

test.describe("Lead page: small screens and keyboard", () => {
  test("390px wide: no sideways scrolling even with long provider text; the whole page works from the keyboard", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.rich));
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    for (const name of ["Lead summary", "Contact", "Referral evidence", "Lead history"]) {
      const box = await region(page, name).boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.x, name).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, name).toBeLessThanOrEqual(390);
    }
    // the sections follow one another in reading order on a phone
    const order = await page.locator("main h2").allTextContents();
    expect(order).toEqual([
      "Lead summary",
      "Contact",
      "Related conversations",
      "Referral evidence",
      "Lead history",
    ]);

    // keyboard: Back link first, then Refresh; Enter on Load older loads, focus stays on the control that was used
    await page.getByRole("link", { name: "Back to leads" }).focus();
    await page.keyboard.press("Tab");
    await expect(refresh(page)).toBeFocused();
    const older = page.getByRole("button", { name: "Load older events" });
    await older.focus();
    await page.keyboard.press("Enter");
    await expect(historyItems(page)).toHaveCount(40);
    await expect(older).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(historyItems(page)).toHaveCount(EVENTS_RICH);
    // the button went away with the last page: focus moves into the history instead of falling back to the top of the page
    await expect(page.getByRole("list", { name: "Lead history, newest first" })).toBeFocused();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await expect(page.getByText("Source link").first()).toBeVisible();

    // a conversation link is reachable by Tab
    const link = region(page, "Related conversations").getByRole("link");
    await link.focus();
    await expect(link).toBeFocused();
  });

  test("reflow (WCAG 1.4.10): the rich lead at 320px, a plain lead at 390px; nothing sideways, nothing clipped, the controls usable; two columns from 1024px", async ({
    page,
  }) => {
    // 320 CSS px is the reflow width (1280px at 400% zoom). The rich lead has the longest real content: hostile provider text,
    // long links, a source id, 45 history events, the status control.
    /** Every element of the page's main content whose box leaves the viewport, or whose content is cut by its own box. */
    const escapes = (width: number) =>
      page.evaluate((w) => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll("main *"))) {
          const r = el.getBoundingClientRect();
          // invisible helpers (the select's 1px native input, aria-hidden decoration) hold no content to reflow
          if (r.width <= 1 || r.height <= 1 || el.closest("[aria-hidden=true]")) continue;
          const label = `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}"`;
          if (r.left < -0.5 || r.right > w + 0.5)
            out.push(`outside ${Math.round(r.right)}: ${label}`);
          const s = getComputedStyle(el);
          if (
            ["hidden", "clip"].includes(s.overflowX) &&
            el.scrollWidth > el.clientWidth + 1 &&
            !el.matches(".sr-only, [data-slot=select-value] *, [data-slot=select-value]")
          )
            out.push(`clipped ${el.scrollWidth}>${el.clientWidth}: ${label}`);
        }
        return out;
      }, width);
    const settle = () => page.evaluate(() => document.fonts.ready.then(() => undefined));

    await page.setViewportSize({ width: 320, height: 800 });
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.rich));
    await expect(region(page, "Referral evidence")).toContainText(DETAIL_HOSTILE.headline);
    await expect(historyItems(page)).toHaveCount(20);
    await settle();
    expect(await overflow(page)).toBeLessThanOrEqual(0); // was 43px: the implicit grid column grew with the content
    expect(await escapes(320)).toEqual([]);
    for (const name of [
      "Lead summary",
      "Contact",
      "Related conversations",
      "Referral evidence",
      "Lead history",
    ]) {
      const box = (await region(page, name).boundingBox())!;
      expect(box.x, name).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, name).toBeLessThanOrEqual(320);
    }
    // the long provider values are shown whole (wrapped), not cut
    await expect(page.getByText("Source link").first()).toBeVisible();
    // the controls fit and work
    for (const control of [
      page.getByRole("combobox", { name: "Change status" }),
      page.getByRole("button", { name: "Update status" }),
      refresh(page),
      page.getByRole("button", { name: "Load older events" }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
    }
    await page.getByRole("combobox", { name: "Change status" }).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    const list = (await page.getByRole("listbox").boundingBox())!;
    expect(list.x).toBeGreaterThanOrEqual(0);
    expect(list.x + list.width).toBeLessThanOrEqual(320);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Load older events" }).click();
    await expect(historyItems(page)).toHaveCount(40);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await navigate(page, `/leads/${await leadId(DETAIL_CONTACTS.plain)}`);
    await expect(region(page, "Lead summary")).toBeVisible();
    await settle();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await escapes(390)).toEqual([]);

    // the desktop layout is untouched: contact beside the lead, both inside the viewport
    for (const width of [768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await navigate(page, `/leads/${await leadId(DETAIL_CONTACTS.rich)}`);
      await expect(region(page, "Lead summary")).toBeVisible();
      await settle();
      expect(await overflow(page), `${width}`).toBeLessThanOrEqual(0);
      const lead = (await region(page, "Lead summary").boundingBox())!;
      const contact = (await region(page, "Contact").boundingBox())!;
      if (width >= 1024) expect(contact.x, `${width}`).toBeGreaterThan(lead.x + lead.width - 1);
      else expect(contact.y, `${width}`).toBeGreaterThan(lead.y);
    }
  });

  test("the desktop layout puts the contact beside the lead and keeps the same reading order", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openLead(page, DETAIL_USERS.staff.email, await leadId(DETAIL_CONTACTS.rich));
    const summary = (await region(page, "Lead summary").boundingBox())!;
    const contact = (await region(page, "Contact").boundingBox())!;
    expect(contact.x).toBeGreaterThan(summary.x + summary.width - 1);
    expect(Math.abs(contact.y - summary.y)).toBeLessThan(2);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
