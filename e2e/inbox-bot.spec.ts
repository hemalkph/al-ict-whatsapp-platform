import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import {
  BOT_CONVERSATIONS,
  BULK_ATTENTION,
  CANARY,
  HOLD_WORDING,
  attentionKeys,
  closeBotDb,
  createBotWorld,
  sendProblems,
  sendSnapshot,
  type BotWorld,
  type ConversationPlan,
  type SendSnapshot,
} from "./support/bot-fixtures";
import { BOT_USERS } from "./support/identities";
import { isBotsOnly } from "./support/mode";
import { serverIdle } from "./support/settle";
import { loginViaUi, navigate, pageFetch } from "./support/ui";

// Phase 08F browser acceptance for the Inbox bot indicator (V3.2 O.1 layer 6; ADR 0021). It runs on the SECOND E2E application
// server (project chromium-bots, see playwright.config.ts) where outbound queueing, live sending and the bot runtime are all off,
// against bot history written by plain SQL (e2e/support/bot-fixtures.ts). Nothing here can send: no worker runs, no credential or
// Graph version exists. Every assertion about the screen compares it with the hand-written expectations in the fixture plan.

const OFF_CONTROL_PORT = String(Number(process.env.E2E_PORT) + 3);
const idle = () => serverIdle(10_000, OFF_CONTROL_PORT);
const go = async (page: Page, url: string) => {
  await idle();
  await navigate(page, url);
};

const plan = (key: string): ConversationPlan => BOT_CONVERSATIONS.find((c) => c.key === key)!;
const listRegion = (page: Page) => page.getByRole("region", { name: "Conversations" });
const rowOf = (page: Page, name: string) =>
  listRegion(page).getByRole("button", { name: new RegExp(name) });
const detailsOf = (page: Page) =>
  page.getByRole("complementary", { name: "Contact and conversation details" });

type Gates = {
  enabledFlags: Record<string, string>;
  graphApiVersionSet: boolean;
  nonEmptyBotsNames: string[];
  nonEmptyTokenNames: string[];
};
const readGates = async () =>
  (await (await fetch(`http://127.0.0.1:${OFF_CONTROL_PORT}/gates`)).json()) as Gates;
const MANDATORY_GATES = [
  "BOTS_RUNTIME_ENABLED",
  "WHATSAPP_OUTBOUND_ENABLED",
  "WHATSAPP_LIVE_SEND_ENABLED",
];
/** The three gates are present and exactly "false"; so is every other reported *_ENABLED flag (a worker flag included); no credential or Graph setting is active. */
function expectGatesOff(gates: Gates) {
  for (const name of MANDATORY_GATES) expect(gates.enabledFlags[name], name).toBe("false");
  for (const [name, value] of Object.entries(gates.enabledFlags)) expect(value, name).toBe("false");
  expect(gates.graphApiVersionSet).toBe(false);
  expect(gates.nonEmptyTokenNames).toEqual([]);
  expect(gates.nonEmptyBotsNames).toEqual(["BOTS_RUNTIME_ENABLED"]); // no other BOTS_ setting
}
let gatesBefore: Awaited<ReturnType<typeof readGates>>;
let world: BotWorld;
let baseline: SendSnapshot;
const id = (key: string) => world.conversations[key]!;
const orgs = () => [world.orgIds.A, world.orgIds.B];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  world = await createBotWorld();
  // BEFORE any browsing: the requests that exist now (QUEUED and SENDING notice fixtures among them) are the only ones allowed later.
  baseline = await sendSnapshot(orgs());
});
test.afterEach(idle);
test.afterAll(closeBotDb);

async function openInbox(page: Page, email: string, query = "") {
  await loginViaUi(page, email, undefined, `/inbox${query}`);
  await expect(listRegion(page)).toBeVisible();
}

/** Every page of the conversation list API for a view, following the cursor; returns the pages' ids. */
async function allPages(page: Page, view: string, limit: number) {
  const pages: string[][] = [];
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ view, limit: String(limit), ...(cursor ? { cursor } : {}) });
    const res = await pageFetch(page, "GET", `/api/inbox/conversations?${qs}`);
    expect(res.status).toBe(200);
    const body = res.json as { items: { id: string }[]; nextCursor: string | null };
    pages.push(body.items.map((i) => i.id));
    cursor = body.nextCursor;
  } while (cursor);
  return pages;
}

test("the server under test has every automation gate off, and the bot fixtures are in place", async ({
  page,
}) => {
  const gates = await readGates();
  gatesBefore = gates;
  expectGatesOff(gates);
  // Bots-only mode starts the outbound-off server alone, so the composer server must be absent. The ordinary mode starts both on purpose.
  if (isBotsOnly(process.env))
    await expect(
      fetch(`http://127.0.0.1:${process.env.E2E_CONTROL_PORT}/in-flight`),
    ).rejects.toThrow();
  const states = Object.values(baseline.requests).map((r) => r.state);
  expect(states.filter((s) => s === "SENDING")).toHaveLength(1); // the notice fixture: allowed, and not a send
  expect(states.filter((s) => s === "QUEUED")).toHaveLength(1);
  expect(baseline.statusEvents).toBe(0);

  // and the UI says so too, on the very conversations of this suite
  await openInbox(page, BOT_USERS.staff.email, `?c=${id("noticeQueued")}`);
  await expect(page.getByRole("note").filter({ hasText: "Sending is switched off" })).toBeVisible();
});

for (const who of ["staff", "admin"] as const) {
  test(`${who}: every conversation row shows the bot indicator the fixture plan expects`, async ({
    page,
  }) => {
    await openInbox(page, BOT_USERS[who].email);
    await expect(page.getByRole("button", { name: "Bot attention" })).toBeVisible();
    for (const c of BOT_CONVERSATIONS.filter((c) => c.org === "A" && !c.key.startsWith("bulk"))) {
      const row = rowOf(page, c.name);
      await expect(row, c.key).toHaveCount(1);
      if (c.expect.inList && c.expect.label) {
        await expect(row, c.key).toContainText(c.expect.label);
        if (c.expect.warning) await expect(row, c.key).toContainText("⚠");
        else await expect(row, c.key).not.toContainText("⚠");
      } else if (c.expect.label) {
        await expect(row, c.key).not.toContainText(c.expect.label); // a quiet finished session is not shown on the row
      }
    }
  });
}

test("a VIEWER sees no bot indicator, no Bot attention view and no bot key in any response", async ({
  page,
}) => {
  await openInbox(page, BOT_USERS.viewer.email);
  await expect(page.getByRole("button", { name: "Bot attention" })).toHaveCount(0);
  await expect(rowOf(page, plan("askedHuman").name)).toBeVisible();
  await expect(listRegion(page)).not.toContainText(
    /Bot (is handling|asked|handed|stopped|finished)/,
  );

  const list = await pageFetch(page, "GET", "/api/inbox/conversations?limit=50");
  expect(list.status).toBe(200);
  expect(list.text).not.toContain('"bot"');
  const attention = await pageFetch(page, "GET", "/api/inbox/conversations?view=botAttention");
  expect(attention.status).toBe(403);
  const detail = await pageFetch(page, "GET", `/api/inbox/conversations/${id("sendHeld")}`);
  expect(detail.status).toBe(200);
  expect(detail.text).not.toContain('"bot"');

  // the view in the URL is not a view for this role: nothing is filtered and no Bot section appears
  await go(page, `/inbox?view=botAttention&c=${id("sendHeld")}`);
  await expect(detailsOf(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Bot attention" })).toHaveCount(0);
  await expect(detailsOf(page)).not.toContainText("The student may not have received");
  await expect(detailsOf(page).getByRole("heading", { name: "Bot", exact: true })).toHaveCount(0);
});

test("another organization's bot sessions are invisible, and the other way round", async ({
  page,
  browser,
}) => {
  await openInbox(page, BOT_USERS.staff.email);
  await expect(page.getByText(plan("orgB").name)).toHaveCount(0);
  const theirs = id("orgB");
  const ids = (await allPages(page, "botAttention", 50)).flat();
  expect(ids).not.toContain(theirs);
  expect((await pageFetch(page, "GET", `/api/inbox/conversations/${theirs}`)).status).toBe(404);
  await go(page, `/inbox?c=${theirs}`);
  await expect(page.getByText("This conversation is not available")).toBeVisible();

  const other = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: test.info().project.use.baseURL,
    extraHTTPHeaders: { "x-forwarded-for": "10.77.1.2" }, // its own client IP for the login rate limiter, as fixtures.ts does per test
  });
  try {
    const b = await other.newPage();
    await openInbox(b, BOT_USERS.orgB.email);
    await expect(rowOf(b, plan("orgB").name)).toContainText("Bot asked for a human");
    await expect(b.getByText(plan("askedHuman").name)).toHaveCount(0);
    expect((await allPages(b, "botAttention", 50)).flat()).toEqual([theirs]);
    expect((await pageFetch(b, "GET", `/api/inbox/conversations/${id("askedHuman")}`)).status).toBe(
      404,
    );
    await idle();
  } finally {
    await other.close();
  }
});

test("Bot attention lists exactly the unresolved handed-over or failed conversations, filtered before paging", async ({
  page,
}) => {
  const expected = attentionKeys("A").map(id);
  expect(expected.length).toBe(BULK_ATTENTION + 15);
  await openInbox(page, BOT_USERS.staff.email);

  // API: pages of 7 are FULL until the last (a filter applied after paging would leave short or empty pages), and the union is exact
  const pages = await allPages(page, "botAttention", 7);
  pages.slice(0, -1).forEach((p) => expect(p).toHaveLength(7));
  expect(pages.at(-1)!.length).toBeGreaterThan(0);
  expect(pages.flat().sort()).toEqual([...expected].sort());

  // UI: a full first page of 30, then the rest on request
  await page.getByRole("button", { name: "Bot attention" }).click();
  await expect(page.getByRole("button", { name: "Bot attention" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(listRegion(page).getByRole("listitem")).toHaveCount(30);
  await page.getByRole("button", { name: "Load more conversations" }).click();
  await expect(listRegion(page).getByRole("listitem")).toHaveCount(expected.length);
  await expect(page.getByRole("button", { name: "Load more conversations" })).toHaveCount(0);
  for (const key of [
    "handling",
    "finished",
    "resolvedHandover",
    "latestCompleted",
    "quiet1",
    "interactive",
  ])
    await expect(listRegion(page).getByText(plan(key).name), key).toHaveCount(0);
  for (const key of ["askedHuman", "failed", "latestHandover", "noticeHeld", "holds"])
    await expect(rowOf(page, plan(key).name), key).toHaveCount(1);
});

test("resolving a conversation removes it from Bot attention", async ({ page }) => {
  const target = id("toResolve");
  await openInbox(page, BOT_USERS.staff.email, "?view=botAttention");
  expect((await allPages(page, "botAttention", 50)).flat()).toContain(target);
  const resolved = await pageFetch(page, "POST", `/api/inbox/conversations/${target}/status`, {
    body: { to: "RESOLVED", expected: "OPEN" },
  });
  expect(resolved.status).toBe(200);
  expect((await allPages(page, "botAttention", 50)).flat()).not.toContain(target);
  await go(page, "/inbox?view=botAttention");
  await page.getByRole("button", { name: "Load more conversations" }).click();
  await expect(listRegion(page).getByRole("listitem")).toHaveCount(BULK_ATTENTION + 14);
  await expect(listRegion(page).getByText(plan("toResolve").name)).toHaveCount(0);
});

test("the session details show reason, notice outcome, redaction marker and nothing the bot captured", async ({
  page,
}) => {
  test.setTimeout(180_000); // one navigation per conversation of the plan
  await openInbox(page, BOT_USERS.staff.email);
  const secrets = [CANARY.variable, CANARY.awaiting, CANARY.tokenPrefix];
  for (const c of BOT_CONVERSATIONS.filter((c) => c.org === "A" && !/^(bulk|quiet)/.test(c.key))) {
    await go(page, `/inbox?c=${id(c.key)}`);
    const details = detailsOf(page);
    await expect(details, c.key).toBeVisible();
    const label = details.getByText(c.expect.label!).first();
    await expect(label, c.key).toBeVisible();
    if (c.expect.warning) await expect(label, c.key).toContainText("⚠");
    else await expect(label, c.key).not.toContainText("⚠");
    for (const text of c.expect.details)
      await expect(details, `${c.key}: ${text}`).toContainText(text);
    for (const text of c.expect.notDetails ?? [])
      await expect(details, `${c.key}: not ${text}`).not.toContainText(text);
    await expect(details.getByText("Started").first()).toBeVisible();
    for (const secret of secrets) await expect(page.locator("body")).not.toContainText(secret);
  }
  // pending notices never claim the message was sent or accepted
  for (const key of ["noticeQueued", "noticeSending"]) {
    await go(page, `/inbox?c=${id(key)}`);
    await expect(detailsOf(page)).not.toContainText(/was accepted|was sent/);
  }
  // the raw API responses carry the lifecycle only
  const list = await pageFetch(page, "GET", "/api/inbox/conversations?view=botAttention&limit=50");
  const detail = await pageFetch(page, "GET", `/api/inbox/conversations/${id("redacted")}`);
  for (const res of [list, detail]) {
    expect(res.status).toBe(200);
    for (const secret of secrets) expect(res.text).not.toContain(secret);
    expect(res.text).not.toMatch(
      /"(variables|awaiting|awaiting_token|last_consumed_token|current_node_id)"/,
    );
  }
});

test("interactive messages, replies and previews read as such, even when bodyless or malformed", async ({
  page,
}) => {
  await openInbox(page, BOT_USERS.staff.email);
  // list previews come from the stored direction
  await expect(rowOf(page, plan("previewBodyless").name)).toContainText("You: Interactive message");
  await expect(rowOf(page, plan("previewReply").name)).toContainText("Interactive reply");
  await expect(rowOf(page, plan("previewReply").name)).not.toContainText("You:");
  await expect(rowOf(page, plan("interactive").name)).toContainText("You: Unsupported message");

  await go(page, `/inbox?c=${id("interactive")}`);
  const timeline = page.getByRole("log", { name: "Messages" });
  await expect(timeline).toContainText("Pick one");
  const exact = (text: string) => timeline.getByText(text, { exact: true });
  await expect(
    timeline.getByText("Would you like to enrol in the A/L ICT class? · Yes enrol / Not now"),
  ).toBeVisible();
  await expect(timeline.getByText("Choose a class day · Saturday / Sunday")).toBeVisible();
  await expect(timeline.getByText("Pick one · Alpha")).toBeVisible(); // malformed rows are skipped, the good one survives
  await expect(exact("Interactive message")).toHaveCount(5); // four bot messages and the quoted bodyless one
  await expect(exact("Interactive reply")).toHaveCount(2); // the customer's two replies
  await expect(exact("Unsupported message")).toHaveCount(1);
  // reply previews (the quoted text is the parent's body alone, labelled with who wrote it)
  await expect(exact("Would you like to enrol in the A/L ICT class?")).toHaveCount(1);
  await expect(exact("Choose a class day")).toHaveCount(1);
  await expect(exact("Replied to an earlier message")).toHaveCount(1);
  // nothing raw
  const text = (await timeline.innerText()).toString();
  expect(text).not.toMatch(/undefined|\[object|[{}]|not-a-list|b1\.|AAAAAAAA|_/);

  await go(page, `/inbox?c=${id("holds")}`);
  const holds = page.getByRole("log", { name: "Messages" });
  for (const wording of Object.values(HOLD_WORDING)) await expect(holds).toContainText(wording);
  expect(await holds.innerText()).not.toMatch(/staff_took_over|bot_step_superseded|bot_stopped|_/);
});

test("terminal notice outcomes warn where they should, and their conversations show the matching timeline state", async ({
  page,
}) => {
  await openInbox(page, BOT_USERS.admin.email);
  const warned = ["noticeHeld", "noticeRejected", "noticeUnknown", "noticeCompletedRejected"];
  for (const key of warned) await expect(rowOf(page, plan(key).name), key).toContainText("⚠");
  for (const key of ["noticeQueued", "noticeSending", "noticeAccepted"])
    await expect(rowOf(page, plan(key).name), key).not.toContainText("⚠");
  // a COMPLETED session is quiet on the row unless it carries a warning
  await expect(rowOf(page, plan("noticeCompletedRejected").name)).toContainText("Bot finished");
  await expect(rowOf(page, plan("finished").name)).not.toContainText("Bot finished");
});

test("browsing sent nothing: no new outbound request, none touched, none newly SENDING, no worker or transport", async ({
  page,
}) => {
  // one more look at the screens whose composer sits next to the fixtures, then compare with the baseline taken before browsing
  await openInbox(page, BOT_USERS.staff.email, `?c=${id("noticeSending")}`);
  await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
  await idle();

  const after = await sendSnapshot(orgs());
  expect(sendProblems(baseline, after)).toEqual([]);
  expect(Object.keys(after.requests)).toEqual(Object.keys(baseline.requests));
  expect(Object.values(after.requests).filter((r) => r.state === "SENDING")).toHaveLength(1);

  const gates = await readGates();
  expectGatesOff(gates);
  expect(gates).toEqual(gatesBefore); // unchanged by browsing
});
