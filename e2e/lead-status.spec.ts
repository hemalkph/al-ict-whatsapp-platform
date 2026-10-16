import type { Page, Request } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { leadState, leadsFor } from "./support/db";
import {
  DETAIL_CONTACTS,
  DETAIL_USERS,
  LEADS_CONTACTS,
  LEADS_USERS,
  STATUS_CONTACTS,
} from "./support/identities";
import { loginViaUi, navigate, pageFetch } from "./support/ui";

// Lead status management (Phase 07D-4) in a real browser against the production build and a disposable database. Every test that
// changes a lead owns its own (seeded by the real lead services, organization F). What a change did is checked in the DATABASE as
// well as on the screen: the screen alone could not tell "applied" from "shown as applied".

const leadId = async (contact: string, nth = 0) => (await leadsFor(contact))[nth]!.id;
const main = (page: Page) => page.locator("main");
const select = (page: Page) => page.getByRole("combobox", { name: "Change status" });
const updateButton = (page: Page) => page.getByRole("button", { name: "Update status" });
const dialog = (page: Page) => page.getByRole("alertdialog");
const alertIn = (page: Page, text: string) =>
  main(page).getByRole("alert").filter({ hasText: text });
const statusIn = (page: Page, text: string) =>
  main(page).getByRole("status").filter({ hasText: text });
const historyItems = (page: Page) =>
  page.getByRole("list", { name: "Lead history, newest first" }).getByRole("listitem");
const summary = (page: Page) => page.getByRole("region", { name: "Lead summary" });
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const openLead = async (page: Page, email: string, id: string) => {
  await loginViaUi(page, email, undefined, `/leads/${id}`);
  await expect(page).toHaveURL(new RegExp(`/leads/${id}`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
};
const choose = async (page: Page, label: string) => {
  await select(page).click();
  await page.getByRole("option", { name: label, exact: true }).click();
};

type Post = {
  path: string;
  body: { to: string; expectedRevision: number };
  actor: string | undefined;
};
/** Every status change this page SENDS (recorded when the browser issues it, so a held or dropped one still counts). */
function recordPosts(page: Page) {
  const posts: Post[] = [];
  page.on("request", (r: Request) => {
    const url = new URL(r.url());
    if (r.method() === "POST" && /^\/api\/leads\/[^/]+\/status$/.test(url.pathname))
      posts.push({
        path: url.pathname,
        body: r.postDataJSON(),
        actor: r.headers()["x-expected-actor"],
      });
  });
  return posts;
}
const STATUS_URL = /\/api\/leads\/[^/]+\/status$/;
const DETAIL_URL = /\/api\/leads\/[^/?]+$/;

test.describe("Lead status: changing it", () => {
  test("an ordinary move is sent at once with the revision the person saw, confirmed by the server, and the screen shows what was recorded", async ({
    page,
  }) => {
    const id = await leadId(STATUS_CONTACTS.move);
    const posts = recordPosts(page);
    await openLead(page, DETAIL_USERS.staff.email, id);
    await expect(select(page)).toContainText("New (current)");
    await expect(updateButton(page)).toHaveAttribute("aria-disabled", "true"); // nothing chosen yet

    await choose(page, "Qualified");
    await expect(page.getByText("The status changes to Qualified.")).toBeVisible();
    await expect(updateButton(page)).toHaveAttribute("aria-disabled", "false");
    expect(posts).toHaveLength(0); // choosing sends nothing
    await updateButton(page).click();

    await expect(statusIn(page, "Your change was saved")).toContainText(
      "no WhatsApp message was sent",
    );
    await expect(dialog(page)).toHaveCount(0); // an ordinary move needs no dialog
    await expect(summary(page)).toContainText("Qualified");
    await expect(select(page)).toContainText("Qualified (current)");
    await expect(select(page)).toBeFocused(); // back at the control, usable again
    await expect(historyItems(page).first()).toContainText(
      "Detail Staff changed the status from New to Qualified",
    );
    await expect(historyItems(page)).toHaveCount(2);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ to: "QUALIFIED", expectedRevision: 0 });
    expect(posts[0]!.path).toBe(`/api/leads/${id}/status`);
    expect(posts[0]!.actor).toBeTruthy();
    const db = await leadState(id);
    expect(db).toMatchObject({ status: "QUALIFIED", revision: 1, status_events: 1 });
  });

  test("closing needs confirmation (cancelling sends nothing), reopening needs it too, and the lifecycle is the backend's", async ({
    page,
  }) => {
    const id = await leadId(STATUS_CONTACTS.close);
    const posts = recordPosts(page);
    await openLead(page, DETAIL_USERS.staff.email, id);

    await choose(page, "Not interested");
    await updateButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(
      dialog(page).getByRole("heading", { name: "Close this lead as Not interested?" }),
    ).toBeVisible();
    await expect(dialog(page)).toContainText("The current lead cycle will end.");
    await expect(dialog(page)).toContainText("internal");
    await expect(dialog(page)).toContainText("No WhatsApp message will be sent.");
    expect(posts).toHaveLength(0);

    // cancel: no request, nothing recorded, focus back at the control, the choice is still there
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(posts).toHaveLength(0);
    expect(await leadState(id)).toMatchObject({ status: "NEW", revision: 0, status_events: 0 });
    await expect(select(page)).toBeFocused();
    await expect(select(page)).toContainText("Not interested");

    await updateButton(page).click();
    await dialog(page).getByRole("button", { name: "Close as Not interested" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(statusIn(page, "Your change was saved")).toContainText("Not interested");
    await expect(summary(page).locator("dt", { hasText: /^Closed$/ })).toBeVisible(); // the closing time, read from the server
    await expect(summary(page)).toContainText("Closed");
    await expect(historyItems(page).first()).toContainText(
      "changed the status from New to Not interested",
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ to: "NOT_INTERESTED", expectedRevision: 0 });
    const closed = await leadState(id);
    expect(closed).toMatchObject({ status: "NOT_INTERESTED", revision: 1, status_events: 1 });
    expect(closed.closed_at).not.toBeNull();

    // reopening: also confirmed, explained, and not promised
    await choose(page, "Interested");
    await updateButton(page).click();
    await expect(
      dialog(page).getByRole("heading", { name: "Reopen this lead as Interested?" }),
    ).toBeVisible();
    await expect(dialog(page)).toContainText("starts a new lead cycle");
    await expect(dialog(page)).toContainText(
      "refused if the contact already has another open lead",
    );
    await dialog(page).getByRole("button", { name: "Reopen as Interested" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(summary(page).locator("dt", { hasText: /^Closed$/ })).toHaveCount(0);
    await expect(historyItems(page).first()).toContainText("from Not interested to Interested");
    expect(posts[1]!.body).toEqual({ to: "INTERESTED", expectedRevision: 1 }); // the revision the server returned, not one made here
    const reopened = await leadState(id);
    expect(reopened).toMatchObject({
      status: "INTERESTED",
      revision: 2,
      status_events: 2,
      closed_at: null,
    });
    expect(reopened.cycle_started_at.getTime()).toBeGreaterThanOrEqual(closed.closed_at!.getTime()); // a new cycle began
  });
});

test.describe("Lead status: what stays read-only, and what the backend refuses on its own", () => {
  test("a viewer has no control, and a forced request is refused by the server", async ({
    page,
  }) => {
    const id = await leadId(DETAIL_CONTACTS.plain);
    await openLead(page, DETAIL_USERS.viewer.email, id);
    await expect(summary(page)).toContainText("Your role can view this lead but cannot change it.");
    await expect(select(page)).toHaveCount(0);
    await expect(updateButton(page)).toHaveCount(0);
    const before = await leadState(id);
    const forced = await pageFetch(page, "POST", `/api/leads/${id}/status`, {
      body: { to: "QUALIFIED", expectedRevision: before.revision },
    });
    expect(forced.status).toBe(403);
    expect(await leadState(id)).toEqual(before);
  });

  test("a reserved status shows a note and no control; the server refuses a change to it, and a reserved target", async ({
    page,
  }) => {
    const paid = await leadId(DETAIL_CONTACTS.paid);
    const plain = await leadId(DETAIL_CONTACTS.plain);
    await openLead(page, DETAIL_USERS.staff.email, paid);
    await expect(summary(page)).toContainText("registration and payment workflow");
    await expect(select(page)).toHaveCount(0);
    await expect(updateButton(page)).toHaveCount(0);
    await expect(main(page).getByRole("alert")).toHaveCount(0); // read-only is not an error

    const beforePaid = await leadState(paid);
    const onReserved = await pageFetch(page, "POST", `/api/leads/${paid}/status`, {
      body: { to: "QUALIFIED", expectedRevision: beforePaid.revision },
    });
    expect(onReserved.status).toBe(409);
    expect(JSON.stringify(onReserved.json)).toContain("RESERVED_STATUS");
    expect(await leadState(paid)).toEqual(beforePaid);

    const beforePlain = await leadState(plain);
    for (const to of ["PAID", "REGISTERED", "CONVERTED", "REGISTRATION_STARTED", "NOT_A_STATUS"]) {
      const r = await pageFetch(page, "POST", `/api/leads/${plain}/status`, {
        body: { to, expectedRevision: beforePlain.revision },
      });
      expect(r.status, to).toBe(400);
    }
    expect(await leadState(plain)).toEqual(beforePlain);
  });

  test("signed out, and from another organization, a forced request is refused and changes nothing", async ({
    page,
  }) => {
    const id = await leadId(DETAIL_CONTACTS.plain);
    const before = await leadState(id);
    await navigate(page, "/login");
    expect(
      (
        await pageFetch(page, "POST", `/api/leads/${id}/status`, {
          body: { to: "QUALIFIED", expectedRevision: before.revision },
        })
      ).status,
    ).toBe(401);
    await loginViaUi(page, LEADS_USERS.otherOrg.email, undefined, "/leads");
    await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
    expect(
      (
        await pageFetch(page, "POST", `/api/leads/${id}/status`, {
          body: { to: "QUALIFIED", expectedRevision: before.revision },
        })
      ).status,
    ).toBe(404);
    expect(await leadState(id)).toEqual(before);
    expect(LEADS_CONTACTS.otherOrg).toBeTruthy();
  });
});

test.describe("Lead status: two people, one lead", () => {
  test("a stale change is refused by the server, never retried, the current state is shown, and a fresh decision uses the new revision", async ({
    page,
    browser,
    baseURL,
    extraHTTPHeaders,
  }) => {
    const id = await leadId(STATUS_CONTACTS.stale);
    const postsB = recordPosts(page);
    await openLead(page, DETAIL_USERS.staff.email, id); // B opens the lead at revision 0

    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true, baseURL, extraHTTPHeaders });
    const a = await ctxA.newPage();
    await openLead(a, DETAIL_USERS.statusStaff2.email, id); // A opens it too, and changes it first
    await choose(a, "Qualified");
    await updateButton(a).click();
    await expect(statusIn(a, "Your change was saved")).toBeVisible();
    expect(await leadState(id)).toMatchObject({ status: "QUALIFIED", revision: 1 });

    // B still shows revision 0 and chooses another status
    await expect(select(page)).toContainText("New (current)");
    await choose(page, "Interested");
    await updateButton(page).click();
    const conflict = alertIn(page, "The lead changed while you were editing");
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText("your change was not saved");
    await expect(conflict).toBeFocused(); // the message is where focus goes

    // the authoritative state was read: A's change, in the status control and in the history
    await expect(select(page)).toContainText("Qualified (current)");
    await expect(select(page)).toBeEnabled();
    await expect(summary(page)).toContainText("Qualified");
    await expect(historyItems(page).first()).toContainText(
      "Status Second Staff changed the status from New to Qualified",
    );
    await expect(updateButton(page)).toHaveAttribute("aria-disabled", "true"); // B's old choice is gone
    await page.waitForTimeout(800);
    expect(postsB).toHaveLength(1); // never retried
    expect(postsB[0]!.body).toEqual({ to: "INTERESTED", expectedRevision: 0 });
    expect(await leadState(id)).toMatchObject({
      status: "QUALIFIED",
      revision: 1,
      status_events: 1,
    }); // A's work was not overwritten

    // a fresh decision on the new state is accepted, with the new revision
    await choose(page, "Interested");
    await updateButton(page).click();
    await expect(statusIn(page, "Your change was saved")).toBeVisible();
    expect(postsB[1]!.body).toEqual({ to: "INTERESTED", expectedRevision: 1 });
    expect(await leadState(id)).toMatchObject({
      status: "INTERESTED",
      revision: 2,
      status_events: 2,
    });
    await ctxA.close();
  });

  test("a refresh that brings a newer revision clears a pending choice instead of applying it", async ({
    page,
    browser,
    baseURL,
    extraHTTPHeaders,
  }) => {
    const id = await leadId(STATUS_CONTACTS.refresh);
    const posts = recordPosts(page);
    await openLead(page, DETAIL_USERS.staff.email, id);
    await choose(page, "Interested"); // chosen at revision 0, not sent

    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true, baseURL, extraHTTPHeaders });
    const b = await ctxB.newPage();
    await openLead(b, DETAIL_USERS.statusStaff2.email, id);
    await choose(b, "Qualified");
    await updateButton(b).click();
    await expect(statusIn(b, "Your change was saved")).toBeVisible();

    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(statusIn(page, "The lead changed while you were choosing")).toBeVisible();
    await expect(select(page)).toContainText("Qualified (current)"); // the choice is gone: the current status is shown
    await expect(updateButton(page)).toHaveAttribute("aria-disabled", "true");
    expect(posts).toHaveLength(0); // the obsolete decision was never sent, with either revision
    expect(await leadState(id)).toMatchObject({ status: "QUALIFIED", revision: 1 });
    await ctxB.close();
  });

  test("reopening while the contact has another open lead is refused: no false success, the lead stays closed, a link leads to the open one", async ({
    page,
  }) => {
    const closedId = await leadId(STATUS_CONTACTS.blocked, 0);
    const openId = await leadId(STATUS_CONTACTS.blocked, 1);
    const posts = recordPosts(page);
    await openLead(page, DETAIL_USERS.staff.email, closedId);
    await expect(summary(page)).toContainText("Not interested");
    await choose(page, "New");
    await updateButton(page).click();
    await dialog(page).getByRole("button", { name: "Reopen as New" }).click();

    const refused = alertIn(page, "The lead was not reopened");
    await expect(refused).toBeVisible();
    await expect(refused).toContainText("already has another open lead");
    await expect(refused).toContainText("Nothing was saved");
    await expect(dialog(page)).toHaveCount(0);
    await expect(statusIn(page, "Your change was saved")).toHaveCount(0);
    await expect(summary(page)).toContainText("Not interested");
    await expect(summary(page)).toContainText("Closed");
    expect(posts).toHaveLength(1);
    expect(await leadState(closedId)).toMatchObject({ status: "NOT_INTERESTED", revision: 1 });

    // the link is the open lead the API itself reported for the contact
    const link = refused.getByRole("link", { name: /current lead/ });
    await expect(link).toHaveAttribute("href", `/leads/${openId}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/leads/${openId}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: STATUS_CONTACTS.blocked }),
    ).toBeVisible();
    await expect(summary(page)).toContainText("Open");
  });
});

test.describe("Lead status: one request, and the unknown outcome", () => {
  test("pressing Confirm several ways sends one request; the dialog stays open and cannot be dismissed until the answer", async ({
    page,
  }) => {
    const id = await leadId(STATUS_CONTACTS.duplicate);
    const posts = recordPosts(page);
    await openLead(page, DETAIL_USERS.staff.email, id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(STATUS_URL, async (route) => {
      await gate;
      await route.continue();
    });
    await choose(page, "No response");
    await updateButton(page).click();
    const confirm = dialog(page).locator("[data-slot=alert-dialog-action]"); // its name becomes "Saving…" once pressed
    await confirm.dblclick();
    await confirm.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expect(dialog(page).getByRole("button", { name: "Saving…" })).toBeVisible();
    await page.keyboard.press("Escape"); // cannot take back a request that is on its way
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.waitForTimeout(500);
    expect(posts).toHaveLength(1);
    expect(await leadState(id)).toMatchObject({ status: "NEW", revision: 0 }); // it has not even reached the server

    release();
    await expect(dialog(page)).toHaveCount(0);
    await expect(statusIn(page, "Your change was saved")).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(await leadState(id)).toMatchObject({
      status: "NO_RESPONSE",
      revision: 1,
      status_events: 1,
    });
  });

  test("a response lost AFTER the server applied the change: said to be unknown, never repeated, and the read shows what really happened", async ({
    page,
  }) => {
    const id = await leadId(STATUS_CONTACTS.lostApplied);
    const posts = recordPosts(page);
    await openLead(page, DETAIL_USERS.staff.email, id);
    await page.route(STATUS_URL, async (route) => {
      await route.fetch(); // the server commits...
      await route.abort("connectionreset"); // ...and the answer never reaches the browser
    });
    await choose(page, "Qualified");
    await updateButton(page).click();

    const unknown = alertIn(page, "We could not confirm whether the change was saved");
    await expect(unknown).toBeVisible();
    await expect(unknown).toContainText("not repeated");
    await expect(unknown).toBeFocused();
    await expect(statusIn(page, "Your change was saved")).toHaveCount(0); // never shown as a success it could not confirm
    // the follow-up read found the committed change, and says the lead has moved on rather than claiming either result
    await expect(unknown).toContainText("has changed since you opened it");
    await expect(select(page)).toContainText("Qualified (current)");
    await expect(select(page)).toBeEnabled();
    await expect(historyItems(page).first()).toContainText(
      "changed the status from New to Qualified",
    );
    await page.waitForTimeout(1000);
    expect(posts).toHaveLength(1); // no automatic repeat, no blind retry offered
    await expect(main(page).getByRole("button", { name: /retry|try again/i })).toHaveCount(0);
    expect(await leadState(id)).toMatchObject({
      status: "QUALIFIED",
      revision: 1,
      status_events: 1,
    }); // applied exactly once
  });

  test("a request lost BEFORE the server saw it: the read shows the lead unchanged, still without claiming it failed, and a fresh decision works", async ({
    page,
  }) => {
    const id = await leadId(STATUS_CONTACTS.lostBefore);
    const posts = recordPosts(page);
    await openLead(page, DETAIL_USERS.staff.email, id);
    await page.route(STATUS_URL, (route) => route.abort("connectionreset"));
    await choose(page, "Qualified");
    await updateButton(page).click();
    const unknown = alertIn(page, "We could not confirm whether the change was saved");
    await expect(unknown).toContainText(
      "shows the lead unchanged, but a slow request could still complete",
    );
    await expect(unknown).not.toContainText(/failed|did not work/i);
    await expect(select(page)).toContainText("New (current)");
    expect(await leadState(id)).toMatchObject({ status: "NEW", revision: 0, status_events: 0 });

    await page.unrouteAll({ behavior: "wait" });
    await choose(page, "Qualified"); // a new, deliberate decision after the read
    await updateButton(page).click();
    await expect(statusIn(page, "Your change was saved")).toBeVisible();
    expect(posts).toHaveLength(2);
    expect(await leadState(id)).toMatchObject({
      status: "QUALIFIED",
      revision: 1,
      status_events: 1,
    });
  });

  test("when the check also fails the uncertainty stays: no new decision until a read succeeds, and only the READ can be repeated", async ({
    page,
  }) => {
    const id = await leadId(STATUS_CONTACTS.readFails);
    const posts = recordPosts(page);
    await openLead(page, DETAIL_USERS.staff.email, id);
    await page.route(STATUS_URL, async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    });
    let reads = 0;
    await page.route(DETAIL_URL, async (route) => {
      if (++reads === 1)
        return route.fulfill({
          status: 500,
          json: { error: { code: "INTERNAL_ERROR", message: "x" } },
        });
      return route.continue();
    });
    await choose(page, "Qualified");
    await updateButton(page).click();
    const unknown = alertIn(page, "We could not confirm whether the change was saved");
    await expect(unknown).toContainText("could not be loaded yet");
    await expect(unknown).toContainText("cannot be changed");
    await expect(select(page)).toBeDisabled(); // not on a state that was never read
    await expect(updateButton(page)).toHaveAttribute("aria-disabled", "true");
    expect(posts).toHaveLength(1);

    await unknown.getByRole("button", { name: "Check the current state" }).click();
    await expect(select(page)).toBeEnabled();
    await expect(select(page)).toContainText("Qualified (current)");
    expect(posts).toHaveLength(1); // the read was repeated; the change never was
    expect(reads).toBe(2);
    expect(await leadState(id)).toMatchObject({
      status: "QUALIFIED",
      revision: 1,
      status_events: 1,
    });
  });
});

test.describe("Lead status: an answer that cannot be believed", () => {
  for (const [key, label, body] of [
    ["malformed", "HTTP 200 with no lead", { changed: true }],
    ["malformedNull", "HTTP 200 with a null lead", { changed: true, lead: null }],
  ] as const)
    test(`${label}: the server committed, so it is an unknown outcome: one POST, a recovery read, the committed lead shown, nothing stuck`, async ({
      page,
    }) => {
      const id = await leadId(STATUS_CONTACTS[key]);
      const posts = recordPosts(page);
      const reads: string[] = [];
      page.on("request", (r) => {
        if (r.method() === "GET" && DETAIL_URL.test(new URL(r.url()).pathname)) reads.push(r.url());
      });
      await openLead(page, DETAIL_USERS.staff.email, id);
      await page.route(STATUS_URL, async (route) => {
        await route.fetch(); // the server really commits...
        await route.fulfill({ status: 200, json: body }); // ...and the browser is told something that is not the answer
      });
      await choose(page, "Qualified");
      await updateButton(page).click();

      const unknown = alertIn(page, "We could not confirm whether the change was saved");
      await expect(unknown).toBeVisible();
      await expect(unknown).toContainText("not repeated");
      await expect(unknown).toBeFocused();
      await expect(statusIn(page, "Your change was saved")).toHaveCount(0); // an answer that cannot be believed is not a success
      // the recovery read found the committed change, and the page says the lead moved on rather than claiming either result
      await expect(unknown).toContainText("has changed since you opened it");
      await expect(select(page)).toContainText("Qualified (current)");
      await expect(select(page)).toBeEnabled(); // not stuck
      await expect(updateButton(page)).toHaveAttribute("aria-disabled", "true"); // no choice carried over
      await expect(summary(page)).toContainText("Qualified");
      await expect(historyItems(page).first()).toContainText(
        "changed the status from New to Qualified",
      );
      await page.waitForTimeout(800);
      expect(posts).toHaveLength(1); // never repeated
      expect(reads).toHaveLength(1); // exactly the recovery read
      expect(await leadState(id)).toMatchObject({
        status: "QUALIFIED",
        revision: 1,
        status_events: 1,
      }); // committed once
      // (any uncaught page error or console error fails the test: see support/fixtures.ts)

      // a new decision is possible only now, and is the person's own
      await page.unrouteAll({ behavior: "wait" });
      await choose(page, "Interested");
      await updateButton(page).click();
      await expect(statusIn(page, "Your change was saved")).toContainText(
        "Your change to Interested was saved",
      );
      expect(posts[1]!.body).toEqual({ to: "INTERESTED", expectedRevision: 1 });
    });
});

test.describe("Lead status: an impossible revision in a believable answer", () => {
  test("the server commits revision 1, the browser is told 101: not believed, one POST, the recovery read's revision 1 is accepted and the control works again", async ({
    page,
  }) => {
    const id = await leadId(STATUS_CONTACTS.impossibleRevision);
    expect(await leadState(id)).toMatchObject({ revision: 0, status_events: 0 });
    const posts = recordPosts(page);
    const reads: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "GET" && DETAIL_URL.test(new URL(r.url()).pathname)) reads.push(r.url());
    });
    await openLead(page, DETAIL_USERS.staff.email, id);
    let real: { lead: { revision: number } } | undefined;
    await page.route(STATUS_URL, async (route) => {
      const response = await route.fetch(); // the server really commits...
      real = await response.json();
      // ...and the browser receives the real envelope with ONLY the revision replaced
      await route.fulfill({ response, json: { ...real, lead: { ...real!.lead, revision: 101 } } });
    });
    await choose(page, "Qualified");
    await updateButton(page).click();

    const unknown = alertIn(page, "We could not confirm whether the change was saved");
    await expect(unknown).toBeVisible();
    expect(real!.lead.revision).toBe(1); // the server's own answer
    await expect(statusIn(page, "Your change was saved")).toHaveCount(0);
    await expect(select(page)).toContainText("Qualified (current)");
    await expect(select(page)).toBeEnabled(); // not stranded behind revision 101
    await expect(summary(page)).toContainText("Qualified");
    await expect(historyItems(page).first()).toContainText(
      "changed the status from New to Qualified",
    );
    await page.waitForTimeout(800);
    expect(posts).toHaveLength(1);
    expect(reads).toHaveLength(1); // the recovery read
    expect(await leadState(id)).toMatchObject({
      status: "QUALIFIED",
      revision: 1,
      status_events: 1,
    });
    // (any uncaught page error or console error fails the test: see support/fixtures.ts)

    // the revision held is the true one: the next decision is sent with 1 and the server accepts it
    await page.unrouteAll({ behavior: "wait" });
    await choose(page, "Interested");
    await updateButton(page).click();
    await expect(statusIn(page, "Your change was saved")).toContainText(
      "Your change to Interested was saved",
    );
    expect(posts[1]!.body).toEqual({ to: "INTERESTED", expectedRevision: 1 });
    expect(await leadState(id)).toMatchObject({ revision: 2, status_events: 2 });
  });
});

test.describe("Lead status: the confirmation describes the request, not the lead's current state", () => {
  test("another person changes the lead again before the follow-up read: the status control shows the newer status, the notice still says what THIS change was", async ({
    page,
    browser,
    baseURL,
    extraHTTPHeaders,
  }) => {
    const id = await leadId(STATUS_CONTACTS.newer);
    await openLead(page, DETAIL_USERS.staff.email, id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(DETAIL_URL, async (route) => {
      await gate; // this person's follow-up read waits...
      await route.continue();
    });
    await choose(page, "Qualified");
    await updateButton(page).click();
    await expect(statusIn(page, "Your change was saved")).toContainText(
      "Your change to Qualified was saved",
    );
    await expect(main(page).getByText("Checking the current state…")).toBeVisible();
    expect(await leadState(id)).toMatchObject({ status: "QUALIFIED", revision: 1 });

    // ...while someone else makes it INTERESTED
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL, extraHTTPHeaders });
    const other = await ctx.newPage();
    await openLead(other, DETAIL_USERS.statusStaff2.email, id);
    await choose(other, "Interested");
    await updateButton(other).click();
    await expect(statusIn(other, "Your change was saved")).toBeVisible();
    expect(await leadState(id)).toMatchObject({ status: "INTERESTED", revision: 2 });

    release();
    await expect(select(page)).toContainText("Interested (current)");
    await expect(summary(page)).toContainText("Interested");
    await expect(statusIn(page, "Your change was saved")).toContainText(
      "Your change to Qualified was saved",
    );
    await expect(main(page).getByText(/the lead is now/i)).toHaveCount(0);
    await expect(historyItems(page).first()).toContainText(
      "changed the status from Qualified to Interested",
    );
    await ctx.close();
  });
});

test.describe("Lead status: the signed-in account changes", () => {
  test("while a change is on its way: it is refused by the server, nothing is saved, and the page stops with nothing of the lead", async ({
    page,
    context,
  }) => {
    const id = await leadId(STATUS_CONTACTS.actor);
    const seen: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/leads"))
        seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await openLead(page, DETAIL_USERS.statusActor.email, id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(STATUS_URL, async (route) => {
      await gate;
      await route.continue();
    });
    await choose(page, "Qualified");
    await updateButton(page).click();
    await expect.poll(() => seen.filter((s) => s.startsWith("POST")).length).toBe(1);

    const tab2 = await context.newPage();
    await navigate(tab2, "/leads");
    await tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(tab2).toHaveURL(/\/login/);
    await loginViaUi(tab2, LEADS_USERS.otherOrg.email, undefined, "/leads");
    await expect(tab2.getByRole("heading", { name: "Leads" })).toBeVisible();

    release(); // the change goes out with the OLD actor
    await expect(
      main(page).getByRole("alert").filter({ hasText: "Your signed-in account has changed" }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1); // the blocked state is the page's one main landmark
    await expect(main(page).getByText(STATUS_CONTACTS.actor)).toHaveCount(0);
    await expect(select(page)).toHaveCount(0);
    await expect(main(page).getByText("Your change was saved")).toHaveCount(0);
    const count = seen.length;
    await page.waitForTimeout(600);
    expect(seen).toHaveLength(count); // no read, no retry
    expect(await leadState(id)).toMatchObject({ status: "NEW", revision: 0, status_events: 0 }); // nothing was saved
    await tab2.close();
  });
  test("after the server COMMITTED it: the page blocks, never claims nothing was changed, requests nothing more, and reload shows the other organization nothing", async ({
    page,
    context,
  }) => {
    const id = await leadId(STATUS_CONTACTS.actorCommitted);
    const seen: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/leads"))
        seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await openLead(page, DETAIL_USERS.statusActor.email, id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(STATUS_URL, async (route) => {
      const response = await route.fetch(); // the server commits at once, under the actor the page was opened for...
      await gate; // ...and the answer is held back
      await route.fulfill({ response });
    });
    await choose(page, "Qualified");
    await updateButton(page).click();
    await expect.poll(() => seen.filter((s) => s.startsWith("POST")).length).toBe(1);
    await expect.poll(async () => (await leadState(id)).status).toBe("QUALIFIED"); // committed, answer not delivered

    const tab2 = await context.newPage();
    await navigate(tab2, "/leads");
    await tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(tab2).toHaveURL(/\/login/);
    await loginViaUi(tab2, LEADS_USERS.otherOrg.email, undefined, "/leads");
    await expect(tab2.getByRole("heading", { name: "Leads" })).toBeVisible();

    release(); // the answer arrives; the read that follows it asserts the OLD actor and is refused
    const notice = main(page)
      .getByRole("alert")
      .filter({ hasText: "Your signed-in account has changed" });
    await expect(notice).toBeVisible();
    await expect(notice).not.toContainText(/nothing was changed/i); // it WAS changed
    await expect(notice).toContainText("may already have been saved");
    await expect(notice).toContainText("Reload");
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(main(page).getByText(STATUS_CONTACTS.actorCommitted)).toHaveCount(0);
    await expect(select(page)).toHaveCount(0);
    const count = seen.length;
    await page.waitForTimeout(600);
    expect(seen).toHaveLength(count); // no further request, no second change
    expect(seen.filter((s) => s.startsWith("POST"))).toHaveLength(1);
    expect(await leadState(id)).toMatchObject({
      status: "QUALIFIED",
      revision: 1,
      status_events: 1,
    }); // the committed event is still there

    // reload as the other organization: nothing of organization F
    await page.getByRole("button", { name: "Reload as the current account" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Lead not available" })).toBeVisible();
    expect(await page.content()).not.toContain(STATUS_CONTACTS.actorCommitted);
    await tab2.close();
  });
});

test.describe("Lead status: keyboard, focus and small screens", () => {
  test("the whole flow works from the keyboard and focus is never lost", async ({ page }) => {
    const id = await leadId(STATUS_CONTACTS.keyboard);
    await openLead(page, DETAIL_USERS.staff.email, id);
    await select(page).focus();
    await page.keyboard.press("Enter"); // opens the list
    await expect(page.getByRole("listbox")).toBeVisible();
    // arrow down to "Not interested" (the highlighted option is the focused one)
    for (let i = 0; i < 6; i++) {
      const name = await page.evaluate(() => document.activeElement?.textContent ?? "");
      if (name === "Not interested") break;
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("Enter");
    await expect(select(page)).toContainText("Not interested");
    await expect(select(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(updateButton(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest("[role=alertdialog]")))
      .toBe(true); // focus moves into the dialog

    await page.keyboard.press("Escape"); // dismiss: back at the control
    await expect(dialog(page)).toHaveCount(0);
    await expect(select(page)).toBeFocused();
    expect(await leadState(id)).toMatchObject({ status: "NEW", revision: 0 });

    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole("button", { name: "Close as Not interested" }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toHaveCount(0);
    await expect(statusIn(page, "Your change was saved")).toBeVisible();
    await expect(select(page)).toBeFocused(); // returned to the updated control
    await expect(select(page)).toContainText("Not interested (current)");
    expect(await leadState(id)).toMatchObject({ status: "NOT_INTERESTED", revision: 1 });
  });

  test("390px wide: the control, the dialog and the messages fit, and the page does not scroll sideways", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const id = await leadId(STATUS_CONTACTS.mobile);
    await openLead(page, DETAIL_USERS.staff.email, id);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const box = (await select(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);

    await choose(page, "Not interested");
    await updateButton(page).click();
    await expect(dialog(page)).toBeVisible();
    const d = (await dialog(page).boundingBox())!;
    expect(d.x).toBeGreaterThanOrEqual(0);
    expect(d.x + d.width).toBeLessThanOrEqual(390);
    expect(d.y).toBeGreaterThanOrEqual(0);
    expect(d.y + d.height).toBeLessThanOrEqual(800);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await dialog(page).getByRole("button", { name: "Close as Not interested" }).click();
    await expect(statusIn(page, "Your change was saved")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await leadState(id)).toMatchObject({ status: "NOT_INTERESTED", revision: 1 });
  });
});
