import type { Page, Request, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { membershipOf } from "./support/db";
import { LEADS_CONTACTS, LEADS_SEED, LEADS_USERS, USERS } from "./support/identities";
import { loginViaUi, navigate, pageFetch } from "./support/ui";

// The Leads page (Phase 07D-2) in a real browser against the production build and a disposable database. Organization D's leads
// are seeded through the real lead services and the real reconciler (scripts/e2e-seed.ts): 2 Meta ad leads, 1 reserved (Paid),
// 3 closed and 33 more, 39 in all; organization E has one lead that D must never see.

const TOTAL_D = LEADS_SEED.bulk + LEADS_SEED.closed + 3;
const rows = (page: Page) => page.locator("main tbody tr");
const names = async (page: Page) =>
  (await rows(page).locator("td:first-child > div:first-child").allTextContents()).map((t) =>
    t.trim(),
  );
const openLeads = async (page: Page, email: string, path = "/leads") => {
  await loginViaUi(page, email, undefined, path);
  await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
};
const status = (page: Page) => page.locator("main p[role=status]");

/** Every /api/leads request this page sends, with its query and the actor it asserts. */
function recordLeadRequests(page: Page) {
  const seen: { url: URL; actor: string | undefined }[] = [];
  page.on("request", (r: Request) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/leads"))
      seen.push({ url, actor: r.headers()["x-expected-actor"] });
  });
  return seen;
}
const ALLOWED = new Set(["state", "status", "attribution", "q", "cursor", "limit"]);
function expectOnlySupported(seen: { url: URL }[]) {
  for (const { url } of seen) {
    for (const key of url.searchParams.keys()) expect(ALLOWED.has(key), `${url}`).toBe(true);
    expect(
      url.searchParams.getAll("state").every((v) => v === "open" || v === "closed"),
      `${url}`,
    ).toBe(true);
    expect(
      url.searchParams.getAll("attribution").every((v) => v === "ad" || v === "none"),
      `${url}`,
    ).toBe(true);
    const q = url.searchParams.get("q");
    if (q !== null) expect(q.length >= 2 && q.length <= 64, `${url}`).toBe(true);
    for (const key of ALLOWED)
      expect(url.searchParams.getAll(key).length <= 1, `${url}`).toBe(true);
  }
}

/** Holds the matching /api/leads requests until released; `stale` ones come back with a marker row so a leak would show. */
async function holdLeadRequests(page: Page, match: (url: URL) => boolean) {
  const held: { route: Route; release: (marker?: string) => Promise<void> }[] = [];
  await page.route(/\/api\/leads(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (!match(url)) return route.continue();
    await new Promise<void>((resolveHeld) => {
      held.push({
        route,
        release: async (marker) => {
          try {
            const response = await route.fetch();
            const json = (await response.json()) as {
              items: { contact: { label: { displayName: string } } }[];
            };
            if (marker) for (const item of json.items) item.contact.label.displayName = marker;
            await route.fulfill({ response, json });
          } catch {
            // the page aborted it (the expected outcome for a superseded request)
          }
          resolveHeld();
        },
      });
    });
  });
  return held;
}

test.describe("Leads page", () => {
  test("staff: the header leads to the first page; sources, reserved and closed leads read correctly; nothing is editable", async ({
    page,
  }) => {
    await loginViaUi(page, LEADS_USERS.staff.email, undefined, "/inbox");
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("link", { name: "Leads" }).click();
    await expect(page).toHaveURL(/\/leads$/);
    await expect(nav.getByRole("link", { name: "Leads" })).toHaveAttribute("aria-current", "page");
    await expect(rows(page)).toHaveCount(30);
    await expect(status(page)).toHaveText("30 leads shown, more can be loaded.");

    const row = (name: string) => rows(page).filter({ hasText: name });
    await expect(row(LEADS_CONTACTS.adAmaya)).toContainText("Meta ad referral recorded");
    await expect(row(LEADS_CONTACTS.adBimal)).toContainText("Meta ad referral recorded");
    await expect(row(`${LEADS_CONTACTS.bulkPrefix} 33`)).toContainText("No referral recorded");
    await expect(row(LEADS_CONTACTS.reserved)).toContainText("Paid");
    await expect(row(LEADS_CONTACTS.reserved)).toContainText("Read-only");
    await expect(row(`${LEADS_CONTACTS.closedPrefix} 1`)).toContainText("Not interested");
    // newest first: the two reconciler leads were created last
    expect((await names(page)).slice(0, 2).sort()).toEqual(
      [LEADS_CONTACTS.adAmaya, LEADS_CONTACTS.adBimal].sort(),
    );
    // the other organization's lead is not here, and nothing on the page changes a lead
    await expect(page.getByText(LEADS_CONTACTS.otherOrg)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /create|status|delete|edit/i })).toHaveCount(0);
    // each row has exactly one link, to its own lead page (a real link on the contact name)
    await expect(rows(page).first().getByRole("link")).toHaveCount(1);
    const hrefs = await rows(page)
      .getByRole("link")
      .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(hrefs).toHaveLength(30);
    expect(new Set(hrefs).size).toBe(30);
    for (const href of hrefs) expect(href).toMatch(/^\/leads\/[0-9a-f-]{36}$/);
  });

  test("viewer: can read the page (lead.read), sees the same leads and no edit control", async ({
    page,
  }) => {
    await openLeads(page, LEADS_USERS.viewer.email);
    await expect(rows(page)).toHaveCount(30);
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Leads" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /create|status|delete|edit/i })).toHaveCount(0);
  });

  test("server authorization: signed out is sent to sign in and the API refuses; each organization sees only its own leads", async ({
    page,
  }) => {
    await navigate(page, "/leads");
    await expect(page).toHaveURL(/\/login\?next=%2Fleads/);
    const anonymous = await pageFetch(page, "GET", "/api/leads");
    expect(anonymous.status).toBe(401);

    await openLeads(page, LEADS_USERS.otherOrg.email);
    await expect(rows(page)).toHaveCount(1);
    expect(await names(page)).toEqual([LEADS_CONTACTS.otherOrg]);
    // D's leads cannot be found from E, even by name
    const search = await pageFetch(
      page,
      "GET",
      `/api/leads?q=${encodeURIComponent(LEADS_CONTACTS.adAmaya)}`,
    );
    expect(search.status).toBe(200);
    expect((search.json as { items: unknown[] }).items).toEqual([]);
    // and the server itself refuses what the page never sends
    expect((await pageFetch(page, "GET", "/api/leads?state=all")).status).toBe(400);
    expect((await pageFetch(page, "GET", "/api/leads?attribution=any")).status).toBe(400);
  });

  test("search and filters: canonical URL, supported queries only, the actor on every request, Back/Forward restore filters", async ({
    page,
  }) => {
    const seen = recordLeadRequests(page);
    await openLeads(
      page,
      LEADS_USERS.staff.email,
      "/leads?state=all&attribution=bogus&status=NOPE&q=x&junk=1",
    );
    await expect(page).toHaveURL(/\/leads$/); // shown in its canonical form
    const toggle = (name: string) =>
      page.getByRole("group", { name: "State" }).getByRole("button", { name });

    // too short: visible as typed, not searched
    const box = page.getByLabel("Search");
    await box.fill("L");
    await expect(
      page.getByText("Type at least 2 characters to search. No search is applied yet."),
    ).toBeVisible();
    await page.waitForTimeout(700); // past the debounce: still no request
    expect(seen).toHaveLength(0);

    await box.fill("Lead Ad");
    await expect(page).toHaveURL(/\/leads\?q=Lead\+Ad$/);
    await expect(rows(page)).toHaveCount(2);
    expect((await names(page)).sort()).toEqual(
      [LEADS_CONTACTS.adAmaya, LEADS_CONTACTS.adBimal].sort(),
    );
    await expect(
      page.getByText("Searching names, usernames and numbers for “Lead Ad”."),
    ).toBeVisible();

    // the first client request asserts the actor the page was rendered for
    const me = await membershipOf(LEADS_USERS.staff.email);
    const actor = JSON.parse(decodeURIComponent(seen[0]!.actor!)) as Record<string, string>;
    expect(actor).toMatchObject({ organizationId: me.organization_id, membershipId: me.id });

    await box.fill("");
    await expect(page).toHaveURL(/\/leads$/);
    await toggle("Closed").click();
    await expect(page).toHaveURL(/\/leads\?state=closed$/);
    await expect(rows(page)).toHaveCount(LEADS_SEED.closed);

    // a status overrides the state, and the state control shows it
    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "Paid (read-only)", exact: true }).click();
    await expect(page).toHaveURL(/\/leads\?status=PAID$/);
    await expect(toggle("All")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Set by the status filter")).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    expect(await names(page)).toEqual([LEADS_CONTACTS.reserved]);

    // choosing Open clears the status
    await toggle("Open").click();
    await expect(page).toHaveURL(/\/leads\?state=open$/);
    await expect(page.getByRole("combobox", { name: "Status" })).toHaveText(/Any status/);

    await page.getByRole("combobox", { name: "Ad referral" }).click();
    await page.getByRole("option", { name: "Meta ad referral linked", exact: true }).click();
    await expect(page).toHaveURL(/\/leads\?state=open&attribution=ad$/);
    await expect(rows(page)).toHaveCount(2);

    // "no Meta ad referral linked": leads without a linked Meta ad touch (never described as "no referral" or "organic")
    await page.getByRole("combobox", { name: "Ad referral" }).click();
    await page.getByRole("option", { name: "No Meta ad referral linked", exact: true }).click();
    await expect(page).toHaveURL(/\/leads\?state=open&attribution=none$/);
    await expect(rows(page).filter({ hasText: LEADS_CONTACTS.adAmaya })).toHaveCount(0);
    await expect(rows(page).filter({ hasText: LEADS_CONTACTS.reserved })).toHaveCount(1);
    await expect(page.getByText("Other referrals may still be recorded")).toBeVisible();

    // Back/Forward walk the same history and restore the filters and the controls
    await page.goBack();
    await expect(page).toHaveURL(/\/leads\?state=open&attribution=ad$/);
    await expect(rows(page)).toHaveCount(2);
    await page.goBack();
    await expect(page).toHaveURL(/\/leads\?state=open$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/leads\?status=PAID$/);
    await expect(rows(page)).toHaveCount(1);
    expect(await names(page)).toEqual([LEADS_CONTACTS.reserved]);
    await expect(page.getByRole("combobox", { name: "Status" })).toHaveText(/Paid/);
    await page.goBack();
    await page.goBack();
    await page.goBack();
    await expect(page).toHaveURL(/\/leads\?q=Lead\+Ad$/);
    await expect(box).toHaveValue("Lead Ad");
    await expect(rows(page)).toHaveCount(2);
    await page.goForward();
    await expect(page).toHaveURL(/\/leads$/);
    await expect(box).toHaveValue("");

    expectOnlySupported(seen);
    for (const r of seen) expect(r.actor, `${r.url}`).toBeTruthy();
  });

  test("Load more appends the next page once, without duplicates, and ends", async ({ page }) => {
    const seen = recordLeadRequests(page);
    await openLeads(page, LEADS_USERS.staff.email);
    await expect(rows(page)).toHaveCount(30);
    const more = page.getByRole("button", { name: "Load more" });
    await more.click();
    await expect(rows(page)).toHaveCount(TOTAL_D);
    await expect(more).toHaveCount(0);
    await expect(status(page)).toHaveText(`${TOTAL_D} leads shown.`);
    const all = await names(page);
    expect(new Set(all).size).toBe(all.length);
    expect(all.at(-1)).toBe(`${LEADS_CONTACTS.bulkPrefix} 01`); // the oldest is last
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.searchParams.get("cursor")).toBeTruthy();
    expectOnlySupported(seen);
  });

  test("races: a late answer to an older request never replaces the current one (A -> B -> A, Load more then filter)", async ({
    page,
  }) => {
    await openLeads(page, LEADS_USERS.staff.email);
    const toggle = (name: string) =>
      page.getByRole("group", { name: "State" }).getByRole("button", { name });

    // A -> B -> A: the FIRST "closed" request is held; "open" and the second "closed" are answered at once
    let closedCalls = 0;
    const held = await holdLeadRequests(
      page,
      (url) => url.searchParams.get("state") === "closed" && ++closedCalls === 1,
    );
    await toggle("Closed").click();
    await expect.poll(() => held.length).toBe(1);
    await toggle("Open").click();
    await expect(rows(page).first()).toBeVisible();
    await toggle("Closed").click();
    await expect(rows(page)).toHaveCount(LEADS_SEED.closed);
    await held[0]!.release("STALE RESPONSE");
    await page.waitForTimeout(500);
    await expect(page.getByText("STALE RESPONSE")).toHaveCount(0);
    await expect(rows(page)).toHaveCount(LEADS_SEED.closed);
    await page.unrouteAll({ behavior: "wait" });

    // Load more is held, then the filter changes: the late next page must not be appended to the new list
    await toggle("All").click();
    await expect(rows(page)).toHaveCount(30);
    const heldMore = await holdLeadRequests(page, (url) => url.searchParams.has("cursor"));
    await page.getByRole("button", { name: "Load more" }).click();
    await expect.poll(() => heldMore.length).toBe(1);
    await toggle("Closed").click();
    await expect(rows(page)).toHaveCount(LEADS_SEED.closed);
    await heldMore[0]!.release("STALE NEXT PAGE");
    await page.waitForTimeout(500);
    await expect(page.getByText("STALE NEXT PAGE")).toHaveCount(0);
    await expect(rows(page)).toHaveCount(LEADS_SEED.closed);
  });

  test("account change: the page stops, shows nothing more of the old view, requests nothing, and reloads as the new account", async ({
    page,
    context,
  }) => {
    const seen = recordLeadRequests(page);
    await openLeads(page, LEADS_USERS.actor.email);
    await expect(rows(page)).toHaveCount(30);

    const tab2 = await context.newPage();
    await navigate(tab2, "/leads");
    await tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(tab2).toHaveURL(/\/login/);
    await loginViaUi(tab2, LEADS_USERS.otherOrg.email, undefined, "/leads");
    await expect(tab2.getByRole("heading", { name: "Leads" })).toBeVisible();

    await page.getByRole("button", { name: "Refresh" }).click(); // asserts the OLD actor: refused by the server
    const notice = page
      .getByRole("alert")
      .filter({ hasText: "Your signed-in account has changed" });
    await expect(notice).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByLabel("Search")).toHaveCount(0);
    const count = seen.length;
    await page.waitForTimeout(500);
    expect(seen).toHaveLength(count); // nothing more is requested
    await expect(page.getByText(LEADS_CONTACTS.otherOrg)).toHaveCount(0); // and nothing of the new account appears in the old page

    await page.getByRole("button", { name: "Reload as the current account" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    expect(await names(page)).toEqual([LEADS_CONTACTS.otherOrg]); // the current account's own leads, nothing of D
    await tab2.close();
  });

  test("states: loading is announced, a failed load can be retried, an empty result can be reset", async ({
    page,
  }) => {
    await openLeads(page, LEADS_USERS.staff.email);
    const toggle = (name: string) =>
      page.getByRole("group", { name: "State" }).getByRole("button", { name });

    // the first "closed" request is slow and then fails on the server: loading is announced, then a retryable error appears
    let calls = 0;
    await page.route(/\/api\/leads\?state=closed/, async (route) => {
      if (++calls > 1) return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.fulfill({
        status: 500,
        json: { error: { code: "INTERNAL_ERROR", message: "x" } },
      });
    });
    await toggle("Closed").click();
    await expect(status(page)).toHaveText("Loading leads…");
    await expect(page.locator("main [data-slot=skeleton]").first()).toBeVisible();
    await expect(page.getByText("Leads could not be loaded", { exact: true })).toBeVisible();
    await expect(page.getByText("No leads match these filters.")).toHaveCount(0); // a failure is not an empty result
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(rows(page)).toHaveCount(LEADS_SEED.closed);
    await expect(page.getByText("Leads could not be loaded", { exact: true })).toHaveCount(0);

    // an empty result, and Reset
    await page.getByLabel("Search").fill("zz-no-such-lead");
    await expect(page.getByText("No leads match these filters.")).toBeVisible();
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect(page).toHaveURL(/\/leads$/);
    await expect(rows(page)).toHaveCount(30);
    await expect(page.getByLabel("Search")).toHaveValue("");
  });

  test("an organization without leads says so (and is not shown as a failure)", async ({
    page,
  }) => {
    await openLeads(page, USERS.orgBStaff.email);
    await expect(page.getByText("No leads yet.")).toBeVisible();
    await expect(page.getByText("could not be loaded")).toHaveCount(0);
  });

  test("mobile and keyboard: no page overflow, the filters and Load more work from the keyboard", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLeads(page, LEADS_USERS.staff.email);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    await expect(rows(page)).toHaveCount(30);
    await expect(rows(page).first()).toContainText("Created"); // the date moves under the name on small screens

    const box = page.getByLabel("Search");
    await box.focus();
    await page.keyboard.type("Lead Closed");
    await expect(rows(page)).toHaveCount(LEADS_SEED.closed);
    await box.fill("");
    await expect(rows(page)).toHaveCount(30);
    // the state group: one tab stop, arrows move, Space chooses
    const all = page.getByRole("group", { name: "State" }).getByRole("button", { name: "All" });
    await all.focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("group", { name: "State" }).getByRole("button", { name: "Open" }),
    ).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(/\/leads\?state=closed$/);
    await expect(rows(page)).toHaveCount(LEADS_SEED.closed);
    await all.focus();
    await page.keyboard.press("Space");
    await expect(rows(page)).toHaveCount(30);
    const more = page.getByRole("button", { name: "Load more" });
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(rows(page)).toHaveCount(TOTAL_D);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
  });
});
