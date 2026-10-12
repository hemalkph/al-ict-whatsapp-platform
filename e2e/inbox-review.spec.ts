import type { BrowserContext, Page, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { INBOX_USERS, REVIEW_CONTACTS, REVIEW_USERS } from "./support/identities";
import {
  addInboundMessage,
  conversationIdFor,
  conversationState,
  forceOutboundState,
  messageCount,
  outboundBodies,
  outboundMessageCount,
  outboundRequestsFor,
  actorIdsOf,
  requestsOwnedBy,
  seenCount,
} from "./support/db";
import { loginViaUi, navigate, pageFetch } from "./support/ui";

// Phase 06 independent-review corrections in a real browser, against the production build and the disposable database
// (organization C: these specs own their conversations). A reply can be QUEUED here; nothing can be sent (no worker, no
// Meta credential, live-send gate explicitly off).
//
// The central technique: a Playwright route lets the REAL request reach the server and COMMIT, and only then corrupts what the
// browser sees. The database is then asked what really happened.

const SEND = /\/api\/conversations\/[0-9a-f-]+\/messages$/;
const PREFIX = "al-ict.pending-send.v2:";
const LEGACY_PREFIX = "al-ict.pending-send.v1:";
/** The journal id of a record: user | organization | membership | conversation (each percent-encoded). */
const journalId = (
  a: { userId: string; organizationId: string; membershipId: string },
  conversationId: string,
) => [a.userId, a.organizationId, a.membershipId, conversationId].map(encodeURIComponent).join("|");
const COMPOSER = "Message to the customer";

const row = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(name) });
const openInbox = async (page: Page, email: string) => {
  await loginViaUi(page, email, undefined, "/inbox");
  await expect(page.getByRole("region", { name: "Conversations" })).toBeVisible();
};
const open = async (page: Page, name: string) => {
  await row(page, name).first().click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
};
const panel = (page: Page) =>
  page.getByRole("alert", { name: "Message with an unconfirmed result" });
const draft = (page: Page) => page.getByLabel(COMPOSER);
const send = async (page: Page, text: string) => {
  await draft(page).fill(text);
  await page.getByRole("button", { name: "Send reply" }).click();
};
/** Two animation frames and a task: queued renders, observers and promise callbacks have run (not a sleep). */
const flush = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))),
      ),
  );
const poll = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // runs the pollers now
/** Everything the journal holds in this tab, as one string. */
const storedText = (page: Page) =>
  page.evaluate(
    (prefix) =>
      Object.entries(sessionStorage)
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .join("\n"),
    PREFIX,
  );
const confirmDialog = (page: Page) => page.getByRole("dialog");
/** Stop tracking, through its confirmation. */
const stopTracking = async (page: Page) => {
  await panel(page)
    .getByRole("button", { name: /Stop tracking this message/ })
    .click();
  await confirmDialog(page).getByRole("button", { name: "Stop tracking anyway" }).click();
};
const storedKeys = (page: Page) =>
  page.evaluate(
    (prefix) => Object.keys(sessionStorage).filter((k) => k.startsWith(prefix)),
    PREFIX,
  );

type Fault = "truncated" | "schema" | "timeout" | "pass";
/**
 * Applies the faults to the next POSTs of a reply, in order, then lets requests through. Every fault lets the real request reach
 * the server first, so the request commits there; only the browser's view of the answer is damaged.
 */
async function inject(page: Page, faults: Fault[]) {
  await page.route(SEND, async (route: Route) => {
    const fault = faults.shift() ?? "pass";
    if (fault === "pass") return route.continue();
    await route.fetch(); // the server processes and commits it
    if (fault === "truncated")
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: '{"requestId":"4a1',
      });
    if (fault === "schema")
      return route.fulfill({ status: 201, contentType: "application/json", body: '{"ok":true}' });
    return route.abort("timedout");
  });
}
function recordSends(page: Page) {
  const sent: Array<{ idempotencyKey: string; message: { body: string } }> = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && SEND.test(r.url())) sent.push(JSON.parse(r.postData() ?? "{}"));
  });
  return sent;
}

test.describe("H1/H2: an unresolved send keeps its identity", () => {
  test("a success whose body is truncated after the server committed: the same key and text are kept across navigation and reload, and exactly one request exists", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.alpha);
    const requestsBefore = (await outboundRequestsFor(id)).length;
    const messagesBefore = await messageCount(id);
    const sent = recordSends(page);
    await inject(page, ["truncated"]);
    await openInbox(page, REVIEW_USERS.staff.email);
    await open(page, REVIEW_CONTACTS.alpha);

    await send(page, "Class starts at 8 am සිංහල");
    await expect(panel(page)).toContainText("may have been queued");
    await expect(panel(page)).toContainText("Its result could not be confirmed");
    await expect(panel(page).getByText("Class starts at 8 am සිංහල")).toBeVisible();
    await expect(draft(page)).toHaveValue(""); // the draft is not the operation
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();

    // the server did commit it: one request, one message
    expect((await outboundRequestsFor(id)).length).toBe(requestsBefore + 1);
    expect(await messageCount(id)).toBe(messagesBefore + 1);
    expect(sent).toHaveLength(1);

    // typing something new does not touch the unresolved operation, and cannot be sent over it
    await draft(page).fill("something else");
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
    await draft(page).fill("");

    // navigating to another conversation and back: still there, nothing was re-sent
    await open(page, REVIEW_CONTACTS.beta);
    await expect(panel(page)).toHaveCount(0);
    await open(page, REVIEW_CONTACTS.alpha);
    await expect(panel(page)).toContainText("Class starts at 8 am සිංහල");

    // a full reload: still there, still nothing re-sent by loading
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 1, name: REVIEW_CONTACTS.alpha }),
    ).toBeVisible();
    await expect(panel(page)).toContainText("Class starts at 8 am සිංහල");
    expect(sent).toHaveLength(1);
    expect((await outboundRequestsFor(id)).length).toBe(requestsBefore + 1);

    // the explicit action re-submits the SAME operation: same key, same text; the server returns the existing request
    await panel(page).getByRole("button", { name: "Check again" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Existing request found: that message is queued" }),
    ).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(sent[1]!.message.body).toBe("Class starts at 8 am සිංහල");
    expect((await outboundRequestsFor(id)).length).toBe(requestsBefore + 1); // exactly ONE logical request
    expect(await messageCount(id)).toBe(messagesBefore + 1); // exactly ONE logical message
    expect(await storedKeys(page)).toEqual([]);

    // a genuinely new message is a new action with a new key
    await send(page, "A different message");
    await expect(page.getByRole("status").filter({ hasText: "Queued." })).toBeVisible();
    expect(sent[2]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    expect((await outboundRequestsFor(id)).length).toBe(requestsBefore + 2);
  });

  for (const fault of ["schema", "timeout"] as const) {
    test(`${fault === "schema" ? "a success that does not match the contract" : "a network timeout after the server committed"}: unresolved, same key on retry, one request`, async ({
      page,
    }) => {
      const id = await conversationIdFor(REVIEW_CONTACTS.beta);
      const before = (await outboundRequestsFor(id)).length;
      const sent = recordSends(page);
      await inject(page, [fault]);
      await openInbox(page, REVIEW_USERS.staff.email);
      await open(page, REVIEW_CONTACTS.beta);
      const text = `Variant ${fault}`;
      await send(page, text);
      await expect(panel(page)).toContainText(text);
      expect((await outboundRequestsFor(id)).length).toBe(before + 1);
      await panel(page).getByRole("button", { name: "Check again" }).click();
      await expect(panel(page)).toHaveCount(0);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
      expect((await outboundRequestsFor(id)).length).toBe(before + 1);
    });
  }

  test("a response body that fails while being read (connection dropped mid-body) is unresolved too", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.beta);
    const before = (await outboundRequestsFor(id)).length;
    // The real fetch completes (the server committed); the page then receives a body stream that errors.
    await page.addInitScript(() => {
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await real(input, init);
        if (
          init?.method === "POST" &&
          /\/api\/conversations\/[0-9a-f-]+\/messages$/.test(String(input))
        )
          return new Response(
            new ReadableStream({ start: (c) => c.error(new TypeError("terminated")) }),
            { status: 201 },
          );
        return response;
      };
    });
    await openInbox(page, REVIEW_USERS.staff.email);
    await open(page, REVIEW_CONTACTS.beta);
    await send(page, "Body read failure");
    await expect(panel(page)).toContainText("Body read failure");
    expect((await outboundRequestsFor(id)).length).toBe(before + 1);
    // the stream keeps failing in this page, so the explicit retry stays unresolved: and still creates nothing new
    await panel(page).getByRole("button", { name: "Check again" }).click();
    await expect(panel(page)).toContainText("Body read failure");
    expect((await outboundRequestsFor(id)).length).toBe(before + 1);
    // the person can stop tracking it (they will check the conversation themselves)
    await stopTracking(page);
    await expect(panel(page)).toHaveCount(0);
    expect(await storedKeys(page)).toEqual([]);
  });

  test("another user on the same device never sees or replays a previous user's pending message", async ({
    page,
    context,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.alpha);
    await inject(page, ["truncated", "truncated"]);
    const sent = recordSends(page);
    await openInbox(page, REVIEW_USERS.staff.email);
    await open(page, REVIEW_CONTACTS.alpha);
    await send(page, "Private reply one");
    await expect(panel(page)).toBeVisible();
    expect(await storedKeys(page)).toHaveLength(1);

    // explicit sign-out clears the record
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(await storedKeys(page)).toEqual([]);
    await loginViaUi(page, REVIEW_USERS.staff2.email, undefined, `/inbox?c=${id}`);
    await expect(
      page.getByRole("heading", { level: 1, name: REVIEW_CONTACTS.alpha }),
    ).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled(); // empty draft: a normal composer

    // a session that ends WITHOUT sign-out (expiry, cookie cleared) and another membership logging in: the text is not shown
    // and does not stay on the device (only a text-free warning remains for its owner)
    await send(page, "Private reply two");
    await expect(panel(page)).toBeVisible();
    expect(await storedKeys(page)).toHaveLength(1);
    await context.clearCookies();
    await loginViaUi(page, REVIEW_USERS.staff.email, undefined, `/inbox?c=${id}`);
    await expect(
      page.getByRole("heading", { level: 1, name: REVIEW_CONTACTS.alpha }),
    ).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    const left = await page.evaluate(
      (prefix) => Object.entries(sessionStorage).filter(([k]) => k.startsWith(prefix)),
      PREFIX,
    );
    expect(left).toHaveLength(1);
    expect(left[0]![1]).not.toContain("Private reply two");
    expect(left[0]![1]).toContain('"kind":"expired"');
    expect(sent.map((s) => s.message.body)).toEqual(["Private reply one", "Private reply two"]); // nothing replayed by anyone
  });

  test("a corrupt stored record blocks its conversation (it is not forgotten); a key that names nobody is dropped; the person can acknowledge and carry on", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.beta);
    const actor = await actorIdsOf(REVIEW_USERS.staff2.email);
    const sent = recordSends(page);
    await openInbox(page, REVIEW_USERS.staff2.email);
    await open(page, REVIEW_CONTACTS.beta);
    await page.evaluate(
      ({ prefix, key, garbage }) => {
        sessionStorage.setItem(key, "{not json");
        sessionStorage.setItem(prefix + garbage, "{}");
      },
      { prefix: PREFIX, key: PREFIX + journalId(actor, id), garbage: "no-actor-here" },
    );
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: REVIEW_CONTACTS.beta })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect(expiredPanel(page)).toContainText(
      "could not be read, but the original request may still exist",
    );
    await draft(page).fill("typed anyway");
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
    expect(await storedKeys(page)).toEqual([PREFIX + journalId(actor, id)]);
    expect(await storedText(page)).not.toContain("not json");

    await expiredPanel(page)
      .getByRole("button", { name: /I have checked the conversation/ })
      .click();
    await confirmDialog(page).getByRole("button", { name: "Allow a new message" }).click();
    await draft(page).fill("Works after corruption");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Queued." })).toBeVisible();
    expect(sent).toHaveLength(1);
  });

  test("without usable sessionStorage the operation is kept in memory and the person is told it cannot survive a reload", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", {
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      });
    });
    await inject(page, ["truncated"]);
    await openInbox(page, REVIEW_USERS.staff.email);
    await open(page, REVIEW_CONTACTS.gamma);
    await send(page, "No storage here");
    await expect(panel(page)).toContainText("No storage here");
    await expect(panel(page)).toContainText("could not keep a record of this message");
    // still protected inside this page: the person cannot silently send a look-alike
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
    await stopTracking(page);
  });
});

test.describe("M5/M6: drafts and replayed states", () => {
  test("a newer draft survives the result of the earlier send: queued, refused, unresolved and replayed", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.gamma);
    const base = (await outboundRequestsFor(id)).length;
    await openInbox(page, REVIEW_USERS.staff.email);
    await open(page, REVIEW_CONTACTS.gamma);

    // 1. A is queued while B is typed. The answer is held until B exists.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const arrived = new Promise<void>((r) => (reached = r));
    await page.route(SEND, async (route) => {
      const real = await route.fetch();
      reached();
      await gate;
      await route.fulfill({ response: real });
    });
    await send(page, "A queued");
    await arrived;
    await expect(draft(page)).toHaveValue(""); // A is now the operation, not the draft
    await draft(page).fill("B typed meanwhile");
    release();
    await expect(page.getByRole("status").filter({ hasText: "Queued." })).toBeVisible();
    await expect(draft(page)).toHaveValue("B typed meanwhile");
    await page.unroute(SEND);

    // 2. A is refused while B is typed: B stays, and A's text is shown so it is not lost
    await page.route(SEND, async (route) => {
      await draft(page).fill("B typed during refusal");
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "OUTBOUND_REFUSED",
            message: "This message cannot be sent: window_closed",
          },
        }),
      });
    });
    await draft(page).fill("A refused");
    await page.getByRole("button", { name: "Send reply" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "24-hour reply window has closed" });
    await expect(alert).toContainText("A refused");
    await expect(draft(page)).toHaveValue("B typed during refusal");
    await page.unroute(SEND);
    expect((await outboundRequestsFor(id)).length).toBe(base + 1); // only the first was ever created

    // 3. A is unresolved (committed, answer lost) while B is typed; then replayed
    await inject(page, ["truncated"]);
    await draft(page).fill("A unresolved");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(panel(page)).toContainText("A unresolved");
    await draft(page).fill("B typed while unresolved");
    await panel(page).getByRole("button", { name: "Check again" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Existing request found" }),
    ).toBeVisible();
    await expect(draft(page)).toHaveValue("B typed while unresolved");
    expect((await outboundRequestsFor(id)).length).toBe(base + 2);
  });

  test("a replayed request is reported as what it really is, and an unknown outcome is never resent", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.beta);
    await openInbox(page, REVIEW_USERS.staff2.email);
    await open(page, REVIEW_CONTACTS.beta);
    const cases = [
      { state: "SENDING", says: /being sent to WhatsApp right now/ },
      { state: "ACCEPTED", says: /does not mean it was delivered/ },
      { state: "REJECTED", says: /rejected it, so it was not delivered/ },
      { state: "HELD", says: /not sent: it is on hold/ },
      { state: "UNKNOWN_OUTCOME", says: /may or may not have been sent to WhatsApp/ },
    ] as const;
    for (const { state, says } of cases) {
      const before = (await outboundRequestsFor(id)).length;
      await page.unroute(SEND).catch(() => undefined);
      await inject(page, ["truncated"]);
      await send(page, `State ${state}`);
      await expect(panel(page)).toContainText(`State ${state}`);
      expect((await outboundRequestsFor(id)).length).toBe(before + 1);
      await forceOutboundState(id, state);

      await panel(page).getByRole("button", { name: "Check again" }).click();
      const notice = page
        .getByRole("alert")
        .or(page.getByRole("status"))
        .filter({ hasText: "Existing request found" });
      await expect(notice).toContainText(says);
      if (state !== "SENDING") await expect(notice).not.toContainText(/is queued|has been queued/);
      if (state === "UNKNOWN_OUTCOME") await expect(notice).toContainText("Do not send it again");
      expect((await outboundRequestsFor(id)).length).toBe(before + 1); // the check created nothing
      const latest = (await outboundRequestsFor(id)).at(-1)!;
      expect(latest.state).toBe(state); // and changed nothing
      await expect(panel(page)).toHaveCount(0);
      // there is no resend control for any of them
      await expect(page.getByRole("button", { name: /resend|send again|try again/i })).toHaveCount(
        0,
      );
    }
    const bodies = await outboundBodies(id);
    expect(new Set(bodies.map((b) => b.idempotency_key)).size).toBe(bodies.length); // every action had its own key
  });
});

test.describe("M2: a stale refresh never overwrites newer state", () => {
  test("an old poll that is still in flight when a status change completes cannot bring the old status back", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.gamma);
    await openInbox(page, REVIEW_USERS.staff2.email);
    await open(page, REVIEW_CONTACTS.gamma);
    const header = page.getByRole("main", { name: "Conversation" });
    await expect(header.getByText(/^(Open|Pending|Resolved) ·/)).toBeVisible();
    const startStatus = (await conversationState(id)).status;
    const target = startStatus === "PENDING" ? "Open" : "Pending";

    // hold the next detail refresh (a poll) after the server has answered it with the CURRENT (old) state
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const heldReached = new Promise<void>((r) => (held = r));
    let delivered!: () => void;
    const staleDelivered = new Promise<void>((r) => (delivered = r));
    let first = true;
    await page.route(new RegExp(`/api/inbox/conversations/${id}$`), async (route) => {
      if (!first) return route.continue();
      first = false;
      const real = await route.fetch();
      held();
      await gate;
      await route.fulfill({ response: real }).catch(() => undefined); // already superseded: the browser may have dropped it
      delivered();
    });
    await poll(page);
    await heldReached;

    // the status changes while that poll is still outstanding; the refresh after the change shows the new status
    const details = page.getByRole("complementary", { name: "Contact and conversation details" });
    await details.getByRole("button", { name: target, exact: true }).click();
    await expect(header.getByText(new RegExp(`^${target} ·`))).toBeVisible();
    expect((await conversationState(id)).status).toBe(target.toUpperCase());

    // now the old answer is released
    release();
    await staleDelivered;
    await flush(page);
    // checked once, immediately: a later poll would hide the problem by correcting it
    const shown = await header.getByText(/^(Open|Pending|Resolved) ·/).innerText();
    expect(shown.startsWith(target)).toBe(true);
    await expect(header.getByText(new RegExp(`^${target} ·`))).toBeVisible();
    await expect(details.getByRole("button", { name: target, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test.describe("L1: Try again really retries", () => {
  test("after a failed list load the button loads again even though the query is unchanged", async ({
    page,
  }) => {
    await openInbox(page, REVIEW_USERS.staff.email);
    const list = page.getByRole("region", { name: "Conversations" });
    let failed = false;
    const requests: string[] = [];
    await page.route(/\/api\/inbox\/conversations\?/, async (route) => {
      const url = route.request().url();
      if (url.includes("view=OPEN")) requests.push(url);
      if (url.includes("view=OPEN") && !failed) {
        failed = true;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }),
        });
      }
      return route.continue();
    });
    await list.getByRole("button", { name: "Open", exact: true }).click();
    await expect(list.getByText("The conversation list could not be loaded.")).toBeVisible();
    expect(requests).toHaveLength(1);
    await list.getByRole("button", { name: "Try again" }).click();
    await expect(list.getByText("The conversation list could not be loaded.")).toHaveCount(0);
    await expect(
      list.getByRole("button", { name: new RegExp(REVIEW_CONTACTS.alpha) }),
    ).toBeVisible();
    expect(requests).toHaveLength(2); // a new request was made for the unchanged query
  });
});

test.describe("M4: only messages that are actually on screen are marked seen", () => {
  test("on a phone: not while Details covers the chat, not for loaded-but-offscreen messages; marked when viewed", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.delta);
    const email = REVIEW_USERS.staff.email;
    await page.setViewportSize({ width: 390, height: 800 });
    await openInbox(page, email);
    await open(page, REVIEW_CONTACTS.delta);
    const log = page.getByRole("log", { name: "Messages" });
    await expect(log.getByText("Hello from Review Delta")).toBeVisible();

    // 31 messages are loaded, only the ones in view are marked
    await expect.poll(() => seenCount(id, email)).toBeGreaterThan(0);
    await flush(page);
    expect(await seenCount(id, email)).toBeLessThan(31);

    // scrolling up shows (and so marks) the rest; back at the bottom everything has been seen
    // (the observer reports what was rendered on screen: move in steps, a frame apiece)
    await log.evaluate(async (el) => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const step = el.clientHeight * 0.4;
      for (let top = el.scrollTop; top > 0; top -= step) {
        el.scrollTop = top;
        await frame();
      }
      el.scrollTop = 0;
      await frame();
      for (let top = 0; top < el.scrollHeight; top += step) {
        el.scrollTop = top;
        await frame();
      }
      el.scrollTop = el.scrollHeight;
      await frame();
    });
    await expect.poll(() => seenCount(id, email)).toBe(31);

    // Details covers the chat; a customer message arrives and a poll fetches it
    await page.getByRole("button", { name: "Details" }).click();
    await expect(
      page.getByRole("complementary", { name: "Contact and conversation details" }),
    ).toBeVisible();
    await addInboundMessage(id, "Arrived while Details was open");
    await poll(page);
    await expect(log.getByText("Arrived while Details was open")).toHaveCount(1);
    await flush(page);
    expect(await seenCount(id, email)).toBe(31);
    const unreadOf = async () => {
      const result = await pageFetch(page, "GET", "/api/inbox/conversations?limit=30");
      const items = (result.json as { items: Array<{ id: string; unreadCount: number }> }).items;
      return items.find((i) => i.id === id)!.unreadCount;
    };
    expect(await unreadOf()).toBe(1);

    // back to the chat: the newest message is on screen, and now it is recorded
    await page
      .getByRole("complementary", { name: "Contact and conversation details" })
      .getByRole("button", { name: "Close" })
      .click();
    await expect.poll(() => seenCount(id, email)).toBe(32);
    expect(await unreadOf()).toBe(0);
  });

  test("not while the tab is hidden", async ({ page }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.gamma);
    const email = REVIEW_USERS.staff.email;
    await openInbox(page, email);
    await open(page, REVIEW_CONTACTS.gamma);
    await expect.poll(() => seenCount(id, email)).toBeGreaterThan(0);
    const before = await seenCount(id, email);

    // the tab goes to the background; a message arrives; something refreshes the conversation meanwhile
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await addInboundMessage(id, "Arrived in a background tab");
    const details = page.getByRole("complementary", { name: "Contact and conversation details" });
    await details.getByRole("button", { name: "Assign to me" }).click(); // a change refreshes the open conversation at once
    await expect(
      page.getByRole("log", { name: "Messages" }).getByText("Arrived in a background tab"),
    ).toHaveCount(1);
    await flush(page);
    expect(await seenCount(id, email)).toBe(before);

    // the tab returns: now it is seen
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => seenCount(id, email)).toBe(before + 1);
  });
});

// ------------------------------------------------------------------------------------------------ H2: the account changes

/** The ids the server holds for a staff member, as the page was rendered with them. */
const membershipFor = async (email: string) => (await import("./support/db")).membershipOf(email);

test.describe("H2: an old tab cannot replay a pending send under another account", () => {
  /** A sends M; the server commits; the answer is lost. Then, in a second tab of the same browser, A is signed out and B in. */
  async function setup(
    page: Page,
    context: BrowserContext,
    a: string,
    b: string,
    conversation: string,
  ) {
    const id = await conversationIdFor(conversation);
    const sent = recordSends(page);
    const headers: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && SEND.test(r.url()))
        headers.push(r.headers()["x-expected-actor"] ?? "");
    });
    await inject(page, ["truncated"]);
    await openInbox(page, a);
    await open(page, conversation);
    await send(page, "Message M for the race");
    await expect(panel(page)).toContainText("Message M for the race");
    // keep tab 1 from noticing by itself: the explicit click is what is being tested
    await page.route(/\/api\/inbox\//, (route) => route.abort());
    const original = await outboundRequestsFor(id);
    const originalMessages = await outboundMessageCount(id);

    const tab2 = await context.newPage();
    await navigate(tab2, "/inbox");
    await tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(tab2).toHaveURL(/\/login/);
    await loginViaUi(tab2, b, undefined, "/inbox");
    await expect(tab2.getByRole("region", { name: "Conversations" })).toBeVisible();
    return { id, sent, headers, tab2, original, originalMessages };
  }

  test("same organization: Check again in the old tab is refused by the SERVER; nothing is created; the operation survives; the original actor can finish it", async ({
    page,
    context,
  }) => {
    const ownedByB = await requestsOwnedBy(REVIEW_USERS.staff2.email);
    const s = await setup(
      page,
      context,
      REVIEW_USERS.staff.email,
      REVIEW_USERS.staff2.email,
      REVIEW_CONTACTS.alpha,
    );
    expect(s.sent).toHaveLength(1);
    const a = await membershipFor(REVIEW_USERS.staff.email);

    // tab 1 is still mounted with A's page and A's pending operation; the cookie is now B's
    await panel(page).getByRole("button", { name: "Check again" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Your signed-in account has changed" }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "No new message was submitted" }),
    ).toBeVisible();

    // the request really reached the server, carrying A's frozen identity and the ORIGINAL key and text
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.idempotencyKey).toBe(s.sent[0]!.idempotencyKey);
    expect(s.sent[1]!.message.body).toBe("Message M for the race");
    expect(JSON.parse(decodeURIComponent(s.headers[1]!)).membershipId).toBe(a.id);

    // the database still holds exactly the original logical request and message, none owned by B
    expect(await outboundRequestsFor(s.id)).toEqual(s.original);
    expect(await outboundMessageCount(s.id)).toBe(s.originalMessages);
    expect(await requestsOwnedBy(REVIEW_USERS.staff2.email)).toBe(ownedByB);

    // the stale interface stopped: no conversation, no composer, nothing to act with
    await expect(page.getByLabel(COMPOSER)).toHaveCount(0);
    await expect(page.getByRole("log", { name: "Messages" })).toHaveCount(0);
    expect(await storedKeys(page)).toHaveLength(1); // A's operation is untouched on record

    // A signs back in (tab 2) and reloads tab 1: the operation is there and Check again returns the EXISTING request
    await s.tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(s.tab2).toHaveURL(/\/login/);
    await loginViaUi(s.tab2, REVIEW_USERS.staff.email, undefined, "/inbox");
    await expect(s.tab2.getByRole("region", { name: "Conversations" })).toBeVisible();
    await page.unroute(/\/api\/inbox\//);
    await page.reload();
    await expect(panel(page)).toContainText("Message M for the race");
    await panel(page).getByRole("button", { name: "Check again" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Existing request found" }),
    ).toBeVisible();
    expect(await outboundRequestsFor(s.id)).toEqual(s.original);
    expect(await requestsOwnedBy(REVIEW_USERS.staff2.email)).toBe(ownedByB);
    await s.tab2.close();
  });

  test("different organizations: refused, nothing created in either", async ({ page, context }) => {
    const ownedByB = await requestsOwnedBy(INBOX_USERS.staff.email);
    const s = await setup(
      page,
      context,
      REVIEW_USERS.staff.email,
      INBOX_USERS.staff.email,
      REVIEW_CONTACTS.beta,
    );
    await panel(page).getByRole("button", { name: "Check again" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Your signed-in account has changed" }),
    ).toBeVisible();
    expect(await outboundRequestsFor(s.id)).toEqual(s.original);
    expect(await requestsOwnedBy(INBOX_USERS.staff.email)).toBe(ownedByB);
    await s.tab2.close();
  });

  test("after the change, a reload as the new account hides the old text and leaves only a text-free warning for its owner", async ({
    page,
    context,
  }) => {
    const s = await setup(
      page,
      context,
      REVIEW_USERS.staff.email,
      REVIEW_USERS.staff2.email,
      REVIEW_CONTACTS.gamma,
    );
    await page.unroute(/\/api\/inbox\//);
    await page.reload(); // the server now renders the page for B
    await expect(
      page.getByRole("heading", { level: 1, name: REVIEW_CONTACTS.gamma }),
    ).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    const records = await page.evaluate(
      (prefix) =>
        Object.entries(sessionStorage)
          .filter(([k]) => k.startsWith(prefix))
          .map(([, v]) => v),
      PREFIX,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).not.toContain("Message M for the race");
    expect(records[0]).toContain('"kind":"expired"');
    expect((await outboundRequestsFor(s.id)).length).toBe(s.original.length);

    // A comes back: the conversation shows the warning, not a free composer
    await s.tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(s.tab2).toHaveURL(/\/login/);
    await loginViaUi(s.tab2, REVIEW_USERS.staff.email, undefined, "/inbox");
    await expect(s.tab2.getByRole("region", { name: "Conversations" })).toBeVisible();
    await page.reload();
    await expect(expiredPanel(page)).toBeVisible();
    await draft(page).fill("typed after the warning");
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
    await s.tab2.close();
  });

  test("a fresh Send from the old tab is refused too, and a poll in the old tab notices the change by itself", async ({
    page,
    context,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.delta);
    const before = await requestsOwnedBy(REVIEW_USERS.staff2.email);
    const sent = recordSends(page);
    await openInbox(page, REVIEW_USERS.staff.email);
    await open(page, REVIEW_CONTACTS.delta);
    const tab2 = await context.newPage();
    await navigate(tab2, "/inbox");
    await tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(tab2).toHaveURL(/\/login/);
    await loginViaUi(tab2, REVIEW_USERS.staff2.email, undefined, "/inbox");
    await expect(tab2.getByRole("region", { name: "Conversations" })).toBeVisible();

    await send(page, "A brand new message from a stale tab");
    await expect(
      page.getByRole("alert").filter({ hasText: "Your signed-in account has changed" }),
    ).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(await requestsOwnedBy(REVIEW_USERS.staff2.email)).toBe(before);
    expect((await outboundBodies(id)).map((b) => b.body)).not.toContain(
      "A brand new message from a stale tab",
    );

    // a different stale page learns it from an ordinary refresh, with no click at all
    const page2 = await context.newPage();
    await tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(tab2).toHaveURL(/\/login/);
    await loginViaUi(tab2, REVIEW_USERS.staff.email, undefined, `/inbox?c=${id}`);
    await navigate(page2, `/inbox?c=${id}`);
    await expect(
      page2.getByRole("heading", { level: 1, name: REVIEW_CONTACTS.delta }),
    ).toBeVisible();
    await tab2.getByRole("button", { name: "Sign out" }).click();
    await expect(tab2).toHaveURL(/\/login/);
    await loginViaUi(tab2, REVIEW_USERS.staff2.email, undefined, "/inbox");
    await expect(tab2.getByRole("region", { name: "Conversations" })).toBeVisible();
    await poll(page2);
    await expect(
      page2.getByRole("alert").filter({ hasText: "Your signed-in account has changed" }),
    ).toBeVisible();
    await expect(page2.getByRole("log", { name: "Messages" })).toHaveCount(0);
    await tab2.close();
    await page2.close();
  });
});

// ------------------------------------------------------------------------------------------------ S1: stop tracking

test.describe("S1: stopping to track a message needs an informed confirmation", () => {
  test("dismissing or cancelling keeps the operation and its key; confirming removes it; nothing is requested; the next send is a new operation", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.beta);
    const before = (await outboundRequestsFor(id)).length;
    const sent = recordSends(page);
    await inject(page, ["truncated"]);
    await openInbox(page, REVIEW_USERS.staff2.email);
    await open(page, REVIEW_CONTACTS.beta);
    await send(page, "Keep me tracked");
    await expect(panel(page)).toContainText("Keep me tracked");
    const key = sent[0]!.idempotencyKey;
    const keyOnRecord = async () =>
      (await storedText(page)).includes("Keep me tracked") ? await storedText(page) : "";

    await panel(page)
      .getByRole("button", { name: /Stop tracking this message/ })
      .click();
    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("does not cancel the message");
    await expect(dialog).toContainText("may already have been queued or sent");
    await expect(dialog).toContainText(
      "forgets the reference that stops a repeat from creating a second copy",
    );
    await expect(dialog).toContainText("may create a duplicate message");
    // the safe choice has focus; Escape means keep
    await expect(dialog.getByRole("button", { name: "Keep tracking this message" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await keyOnRecord()).toContain(key);
    await expect(panel(page)).toContainText("Keep me tracked");

    // the explicit "keep" button
    await panel(page)
      .getByRole("button", { name: /Stop tracking this message/ })
      .click();
    await dialog.getByRole("button", { name: "Keep tracking this message" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await keyOnRecord()).toContain(key);

    // confirming
    await panel(page)
      .getByRole("button", { name: /Stop tracking this message/ })
      .click();
    await dialog.getByRole("button", { name: "Stop tracking anyway" }).click();
    await expect(panel(page)).toHaveCount(0);
    expect(await storedKeys(page)).toEqual([]);

    // nothing was requested by any of it, and the server request was not cancelled
    expect(sent).toHaveLength(1);
    expect((await outboundRequestsFor(id)).length).toBe(before + 1);

    // what follows is a NEW operation with a new key
    await send(page, "Keep me tracked");
    await expect(page.getByRole("status").filter({ hasText: "Queued." })).toBeVisible();
    expect(sent[1]!.idempotencyKey).not.toBe(key);
    expect((await outboundRequestsFor(id)).length).toBe(before + 2); // the duplicate the dialog warned about
  });

  test("on a phone the confirmation fits the screen and works by touch", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await inject(page, ["truncated"]);
    await openInbox(page, REVIEW_USERS.staff2.email);
    await open(page, REVIEW_CONTACTS.gamma);
    await send(page, "Phone confirmation");
    await panel(page)
      .getByRole("button", { name: /Stop tracking this message/ })
      .click();
    const box = await confirmDialog(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await confirmDialog(page).getByRole("button", { name: "Keep tracking this message" }).click();
    await expect(panel(page)).toBeVisible();
    await stopTracking(page);
    await expect(panel(page)).toHaveCount(0);
  });
});

// ------------------------------------------------------------------------------------------------ S2: expiry

const expiredPanel = (page: Page) =>
  page.getByRole("alert", { name: "Earlier message submission that could not be confirmed" });

test.describe("S2: an expired payload leaves a warning, not an empty composer", () => {
  /** Makes Date.now() skewable from the test (a sleeping or very long-lived tab). */
  const skewable = (page: Page) =>
    page.addInitScript(() => {
      const real = Date.now.bind(Date);
      (window as unknown as { __skew: number }).__skew = 0;
      Date.now = () => real() + (window as unknown as { __skew: number }).__skew;
    });
  const skew = (page: Page, ms: number) =>
    page.evaluate((v) => ((window as unknown as { __skew: number }).__skew = v), ms);
  const DAY = 24 * 3600 * 1000;

  test("restored after a reload past 24 hours: the text is gone from the page and from storage, the warning blocks a fresh send until acknowledged", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.beta);
    const before = (await outboundRequestsFor(id)).length;
    const sent = recordSends(page);
    await inject(page, ["truncated"]);
    await openInbox(page, REVIEW_USERS.staff2.email);
    await open(page, REVIEW_CONTACTS.beta);
    await send(page, "Expires in storage");
    await expect(panel(page)).toContainText("Expires in storage");
    // age the record by 25 hours (what the clock would have done)
    await page.evaluate(
      ([prefix, day]) => {
        for (const [k, v] of Object.entries(sessionStorage))
          if (k.startsWith(prefix as string)) {
            const o = JSON.parse(v);
            o.createdAt -= (day as number) + 3600_000;
            sessionStorage.setItem(k, JSON.stringify(o));
          }
      },
      [PREFIX, DAY],
    );
    await page.reload();
    await expect(expiredPanel(page)).toBeVisible();
    await expect(expiredPanel(page)).toContainText(
      "Its local details have expired, but the original request may still exist",
    );
    await expect(expiredPanel(page)).not.toContainText("Expires in storage");
    expect((await storedKeys(page)).length).toBe(1);
    expect(await storedText(page)).not.toContain("Expires in storage");

    // a fresh send is blocked
    await draft(page).fill("typed anyway");
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();

    // acknowledging is explicit and can be cancelled
    await expiredPanel(page)
      .getByRole("button", { name: /I have checked the conversation/ })
      .click();
    const dialog = confirmDialog(page);
    await expect(dialog).toContainText("Expiry does not cancel the earlier request");
    await expect(dialog).toContainText("original text is no longer available");
    await expect(dialog.getByRole("button", { name: "Keep the warning" })).toBeFocused();
    await dialog.getByRole("button", { name: "Keep the warning" }).click();
    await expect(expiredPanel(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
    await expiredPanel(page)
      .getByRole("button", { name: /I have checked the conversation/ })
      .click();
    await dialog.getByRole("button", { name: "Allow a new message" }).click();
    await expect(expiredPanel(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send reply" })).toBeEnabled();

    // nothing was requested by any of it; the earlier request still exists on the server
    expect(sent).toHaveLength(1);
    expect((await outboundRequestsFor(id)).length).toBe(before + 1);
    expect(await storedKeys(page)).toEqual([]);
  });

  test("an operation that expires while the page stays open, and a tab that resumes after the expiry, are replaced by the warning", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.gamma);
    const before = (await outboundRequestsFor(id)).length;
    const sent = recordSends(page);
    await skewable(page);
    await inject(page, ["truncated"]);
    await openInbox(page, REVIEW_USERS.staff2.email);
    await open(page, REVIEW_CONTACTS.gamma);
    await send(page, "Expires while open");
    await expect(panel(page)).toContainText("Expires while open");

    // before the boundary nothing changes
    await skew(page, DAY - 120_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(panel(page)).toContainText("Expires while open");

    // the tab slept past the boundary and wakes: the focus/visibility events re-check at once
    await skew(page, DAY + 1000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(expiredPanel(page)).toBeVisible();
    await expect(expiredPanel(page)).not.toContainText("Expires while open");
    expect(await storedText(page)).not.toContain("Expires while open");
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
    expect(sent).toHaveLength(1);
    expect((await outboundRequestsFor(id)).length).toBe(before + 1);
  });
});

// ------------------------------------------------------------------------------------------------ J1 / J2

test.describe("J2: each actor has their own record for a conversation", () => {
  test("A's unresolved send, B signs in on the same tab and sends in the SAME conversation, A returns: A's warning is still there and B's operation is not A's", async ({
    page,
    context,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.alpha);
    const a = await actorIdsOf(REVIEW_USERS.staff.email);
    const b = await actorIdsOf(REVIEW_USERS.staff2.email);
    const ownedByA = await requestsOwnedBy(REVIEW_USERS.staff.email);
    const ownedByB = await requestsOwnedBy(REVIEW_USERS.staff2.email);
    const sent = recordSends(page);
    await inject(page, ["truncated", "truncated"]);

    // A: committed, answer lost
    await openInbox(page, REVIEW_USERS.staff.email);
    await open(page, REVIEW_CONTACTS.alpha);
    await send(page, "A's private message");
    await expect(panel(page)).toContainText("A's private message");

    // B signs in on the same tab (A's session ended without a sign-out) and opens the same conversation
    await context.clearCookies();
    await loginViaUi(page, REVIEW_USERS.staff2.email, undefined, `/inbox?c=${id}`);
    await expect(
      page.getByRole("heading", { level: 1, name: REVIEW_CONTACTS.alpha }),
    ).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    expect(await storedText(page)).not.toContain("A's private message"); // reduced to a text-free warning

    // B's own operation in the same conversation (also unresolved)
    await send(page, "B's message");
    await expect(panel(page)).toContainText("B's message");
    expect(await storedKeys(page)).toEqual(
      expect.arrayContaining([PREFIX + journalId(a, id), PREFIX + journalId(b, id)]),
    );
    expect(await storedKeys(page)).toHaveLength(2);
    expect(sent[0]!.idempotencyKey).not.toBe(sent[1]!.idempotencyKey);

    // A returns
    await context.clearCookies();
    await loginViaUi(page, REVIEW_USERS.staff.email, undefined, `/inbox?c=${id}`);
    await expect(
      page.getByRole("heading", { level: 1, name: REVIEW_CONTACTS.alpha }),
    ).toBeVisible();
    await expect(expiredPanel(page)).toBeVisible(); // A's original warning
    await expect(page.getByRole("log", { name: "Messages" }).getByText("B's message")).toHaveCount(
      1,
    ); // only in the timeline, where it really is
    await expect(expiredPanel(page)).not.toContainText("B's message");
    await draft(page).fill("silently over the warning?");
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();

    // acknowledging A's warning removes A's record only; B's record is still B's
    await expiredPanel(page)
      .getByRole("button", { name: /I have checked the conversation/ })
      .click();
    await confirmDialog(page).getByRole("button", { name: "Allow a new message" }).click();
    expect(await storedKeys(page)).toEqual([PREFIX + journalId(b, id)]);

    // nothing was ever replayed by anybody: two sends, two requests, each owned by its own sender
    expect(sent).toHaveLength(2);
    expect(await requestsOwnedBy(REVIEW_USERS.staff.email)).toBe(ownedByA + 1);
    expect(await requestsOwnedBy(REVIEW_USERS.staff2.email)).toBe(ownedByB + 1);
  });
});

test.describe("J1: the journal never silently drops a record to make room", () => {
  const seedForeign = (page: Page, count: number) =>
    page.evaluate(
      ({ prefix, count }) => {
        const now = Date.now();
        for (let i = 0; i < count; i++) {
          const conversationId = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
          const id = ["seed-user", "seed-org", "seed-mem", conversationId]
            .map(encodeURIComponent)
            .join("|");
          sessionStorage.setItem(
            prefix + id,
            JSON.stringify({
              v: 1,
              kind: "expired",
              userId: "seed-user",
              organizationId: "seed-org",
              membershipId: "seed-mem",
              conversationId,
              createdAt: now - 1000,
              expiredAt: now - 500,
            }),
          );
        }
      },
      { prefix: PREFIX, count },
    );

  for (const [count, wording] of [
    [200, /already tracking 200 messages/],
    [201, /more unconfirmed messages than the 200/],
  ] as const) {
    test(`${count} records already in the journal: all are kept, a new message is refused before anything is sent, and the page says why`, async ({
      page,
    }) => {
      const sent = recordSends(page);
      await openInbox(page, REVIEW_USERS.staff2.email);
      await open(page, REVIEW_CONTACTS.gamma);
      await seedForeign(page, count);
      await page.reload();
      await expect(
        page.getByRole("heading", { level: 1, name: REVIEW_CONTACTS.gamma }),
      ).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: wording })).toBeVisible();
      await expect(
        page.getByRole("alert").filter({ hasText: /Nothing was sent and nothing was deleted/ }),
      ).toBeVisible();
      await draft(page).fill("cannot be sent from here");
      await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
      await page.keyboard.press("Control+Enter"); // the keyboard shortcut is blocked too
      expect((await storedKeys(page)).length).toBe(count); // nothing evicted
      expect(sent).toHaveLength(0);
    });
  }
});

test.describe("migration of the previous journal format", () => {
  test("a record written under the conversation-only key moves to the actor-scoped key, keeps its idempotency key, and is not sent by loading", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.delta);
    const actor = await actorIdsOf(REVIEW_USERS.staff.email);
    const before = (await outboundRequestsFor(id)).length;
    const sent = recordSends(page);
    await openInbox(page, REVIEW_USERS.staff.email);
    await open(page, REVIEW_CONTACTS.delta);
    await page.evaluate(({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)), {
      key: LEGACY_PREFIX + id,
      record: {
        v: 1,
        ...actor,
        conversationId: id,
        key: "legacy-key-from-v1",
        body: "Written by the previous version",
        replyTo: null,
        createdAt: Date.now() - 60_000,
      },
    });
    await page.reload();
    await expect(panel(page)).toContainText("Written by the previous version");
    expect(await storedKeys(page)).toEqual([PREFIX + journalId(actor, id)]);
    expect(
      await page.evaluate(
        (p) => Object.keys(sessionStorage).filter((k) => k.startsWith(p)),
        LEGACY_PREFIX,
      ),
    ).toEqual([]);
    expect(sent).toHaveLength(0);

    await panel(page).getByRole("button", { name: "Check again" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /Queued\.|Existing request found/ }),
    ).toBeVisible();
    expect(sent[0]!.idempotencyKey).toBe("legacy-key-from-v1");
    expect((await outboundRequestsFor(id)).length).toBe(before + 1);
  });

  const record = (
    actor: { userId: string; organizationId: string; membershipId: string },
    conversationId: string,
    over: Record<string, unknown>,
  ) => ({
    v: 1,
    ...actor,
    conversationId,
    key: "journal-key-0001",
    body: "journal text",
    replyTo: null,
    createdAt: Date.now() - 60_000,
    ...over,
  });
  const put = (page: Page, entries: Array<[string, unknown]>) =>
    page.evaluate(
      (list) => list.forEach(([k, v]) => sessionStorage.setItem(k, JSON.stringify(v))),
      entries,
    );

  test("two different submissions with the SAME timestamp are not merged: a conflict warning blocks sending, says so, and survives reloads", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.gamma);
    const actor = await actorIdsOf(REVIEW_USERS.staff.email);
    const sent = recordSends(page);
    await openInbox(page, REVIEW_USERS.staff.email);
    await open(page, REVIEW_CONTACTS.gamma);
    const at = Date.now() - 120_000;
    await put(page, [
      [
        LEGACY_PREFIX + id,
        record(actor, id, { createdAt: at, key: "legacy-key-K1", body: "message A" }),
      ],
      [
        PREFIX + journalId(actor, id),
        record(actor, id, { createdAt: at, key: "current-key-K2", body: "message B" }),
      ],
    ]);
    for (let load = 0; load < 2; load++) {
      await page.reload();
      await expect(expiredPanel(page)).toContainText(
        "Conflicting local records were found for an earlier message submission",
      );
      await expect(expiredPanel(page)).toContainText(
        "cannot be safely reconciled from this browser record",
      );
      await expect(expiredPanel(page)).toContainText("may already have been queued or sent");
      await expect(expiredPanel(page)).toContainText(
        "supervisor or operator may need to investigate",
      );
      await expect(expiredPanel(page)).not.toContainText(/message A|message B|K1|K2/);
      await draft(page).fill("typed anyway");
      await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
    }
    const stored = await storedText(page);
    expect(stored).not.toMatch(/message A|message B|K1|K2/);
    expect(stored).toContain('"conflict":true');
    expect(await storedKeys(page)).toEqual([PREFIX + journalId(actor, id)]);
    expect(sent).toHaveLength(0);

    // acknowledging goes through the same confirmation
    await expiredPanel(page)
      .getByRole("button", { name: /I have checked the conversation/ })
      .click();
    await expect(confirmDialog(page)).toContainText("does not cancel the earlier request");
    await expect(confirmDialog(page)).toContainText("Conflicting local records were found");
    await confirmDialog(page).getByRole("button", { name: "Keep the warning" }).click();
    await expect(expiredPanel(page)).toBeVisible();
    await expiredPanel(page)
      .getByRole("button", { name: /I have checked the conversation/ })
      .click();
    await confirmDialog(page).getByRole("button", { name: "Allow a new message" }).click();
    await expect(expiredPanel(page)).toHaveCount(0);
    expect(await storedKeys(page)).toEqual([]);
  });

  test("an old legacy record does not shorten the protection of a fresh operation: the fresh operation is still there after every reload", async ({
    page,
  }) => {
    const id = await conversationIdFor(REVIEW_CONTACTS.gamma);
    const actor = await actorIdsOf(REVIEW_USERS.staff2.email);
    const sent = recordSends(page);
    await openInbox(page, REVIEW_USERS.staff2.email);
    await open(page, REVIEW_CONTACTS.gamma);
    await put(page, [
      [
        LEGACY_PREFIX + id,
        record(actor, id, {
          createdAt: Date.now() - 8 * 86_400_000,
          key: "ancient-legacy-1",
          body: "ancient",
        }),
      ],
      [
        PREFIX + journalId(actor, id),
        record(actor, id, { key: "fresh-v2-key-001", body: "fresh unresolved message" }),
      ],
    ]);
    for (let load = 0; load < 2; load++) {
      await page.reload();
      await expect(panel(page)).toContainText("fresh unresolved message");
      await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
    }
    expect(
      await page.evaluate(
        (p) => Object.keys(sessionStorage).filter((k) => k.startsWith(p)),
        LEGACY_PREFIX,
      ),
    ).toEqual([]);
    expect(sent).toHaveLength(0);
    await stopTracking(page);
  });
});
