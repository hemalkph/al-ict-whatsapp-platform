import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { INBOX_CONTACTS, INBOX_USERS } from "./support/identities";
import { loginViaUi, navigate } from "./support/ui";

// Two accessibility corrections to the application shell (Phase 07D-4, preliminary task), separate from lead status management:
//  A. on a phone the sidebar is a sheet: choosing a destination closes it, and it has a visible Close control;
//  B. exactly one exposed <main> landmark on every page, including the phone Inbox list (the old <main> was the hidden chat pane).

const dialog = (page: Page) => page.getByRole("dialog", { name: "Sidebar" });
const trigger = (page: Page) => page.locator("[data-sidebar=trigger]");
const signIn = async (page: Page, path: string) => {
  await loginViaUi(page, INBOX_USERS.mobile.email, undefined, path);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
};

test.describe("mobile sidebar (390px)", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("choosing a destination closes the sheet, whichever page it leads to, including the page you are already on", async ({
    page,
  }) => {
    await signIn(page, "/inbox");
    await expect(dialog(page)).toHaveCount(0);

    await trigger(page).click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole("link", { name: "Leads" }).click();
    await expect(page).toHaveURL(/\/leads$/);
    await expect(dialog(page)).toHaveCount(0); // closed by its own state, and the destination is visible
    await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeInViewport();

    await trigger(page).click();
    await dialog(page).getByRole("link", { name: "Inbox" }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Conversations" })).toBeVisible();

    // the page you are already on: the pathname does not change, and the sheet still closes
    await trigger(page).click();
    await dialog(page).getByRole("link", { name: "Inbox" }).click();
    await expect(dialog(page)).toHaveCount(0);

    // the product link at the top leads home and closes it too
    await trigger(page).click();
    await dialog(page)
      .getByRole("link", { name: /A\/L ICT WhatsApp/ })
      .click();
    await expect(page).toHaveURL(/\/$/);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("a visible, named Close control closes it; Escape closes it and focus returns to the control that opened it", async ({
    page,
  }) => {
    await signIn(page, "/inbox");
    await trigger(page).click();
    const close = dialog(page).getByRole("button", { name: "Close" });
    await expect(close).toBeVisible();
    const box = (await close.boundingBox())!;
    expect(box.width).toBeGreaterThan(20);
    expect(box.x + box.width).toBeLessThanOrEqual(390); // on screen, not clipped
    await close.click();
    await expect(dialog(page)).toHaveCount(0);

    await trigger(page).focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    // one Escape is enough straight away (a tooltip on the focused link must not swallow it)
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    // focus is trapped in the sheet: Tab cycles through its controls (the Close control among them) and never settles on the page
    // behind it (a focus guard at the edge hands focus back on the next frame, hence the polling)
    const seen = new Set<string>();
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press("Tab");
      await expect
        .poll(() => page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")))
        .toBe(true);
      seen.add(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent?.trim() ??
            "",
        ),
      );
    }
    expect([...seen].some((t) => /Close/.test(t))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();

    // a link chosen from the keyboard closes it as well
    await page.keyboard.press("Enter");
    await dialog(page).getByRole("link", { name: "Leads" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/leads$/);
    await expect(dialog(page)).toHaveCount(0);
  });
});

test.describe("desktop sidebar (1280px)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("stays a sidebar: navigating does not hide it, the trigger collapses and restores it, and no sheet exists", async ({
    page,
  }) => {
    await signIn(page, "/inbox");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();
    await nav.getByRole("link", { name: "Leads" }).click();
    await expect(page).toHaveURL(/\/leads$/);
    await expect(nav).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    const before = (await nav.boundingBox())!.width;
    await trigger(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(async () => (await nav.boundingBox())?.width ?? 0).toBeLessThan(before);
    await trigger(page).click();
    await expect
      .poll(async () => (await nav.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(before - 1);
  });
});

/**
 * Exactly one main landmark is exposed, none is nested, and the destination's own content is inside it. Every check RETRIES (it
 * is a web-first assertion, and the destination must be on screen first): while a page streams in, Next briefly holds its content
 * in a hidden container (`div#S:0`) that contains a second <main>, which a one-shot count of every <main> element in the DOM
 * catches. That element is not exposed to assistive technology, is not nested, and is gone (or hidden) once the page settles, so
 * the meaningful properties are the exposed landmark count and the VISIBLE <main> count, not the raw element count.
 */
async function expectOneMain(page: Page, inside: (main: Locator) => Locator) {
  await expect(inside(page.getByRole("main"))).toBeVisible(); // the destination has settled, inside the main landmark
  await expect(page.getByRole("main")).toHaveCount(1); // exposed to assistive technology
  await expect(page.locator("main:visible")).toHaveCount(1); // and on screen
  await expect(page.locator("main main")).toHaveCount(0); // never nested
  await expect(page.getByRole("main").getByRole("main")).toHaveCount(0);
}

for (const [label, viewport] of [
  ["390px", { width: 390, height: 800 }],
  ["1280px", { width: 1280, height: 900 }],
] as const)
  test.describe(`main landmark (${label})`, () => {
    test.use({ viewport });

    test("every page exposes exactly one main, none is nested, and the page's content is inside it", async ({
      page,
    }) => {
      await signIn(page, "/inbox");
      // the Inbox list (on a phone the chat pane is hidden: the old <main> was inside it)
      await expectOneMain(page, (main) => main.getByRole("region", { name: "Conversations" }));
      await expect(page.getByRole("main")).toHaveAccessibleName("Inbox");

      // an open conversation: still one main; the conversation is a named section inside it
      await page
        .getByRole("button", { name: new RegExp(INBOX_CONTACTS.nimal) })
        .first()
        .click();
      await expect(
        page.getByRole("heading", { level: 1, name: INBOX_CONTACTS.nimal }),
      ).toBeVisible();
      await expectOneMain(page, (main) =>
        main.locator(":scope > section[aria-label=Conversation]"),
      );
      await expect(page.getByRole("main")).toHaveAccessibleName("Inbox");

      // the other pages of the application, reached by a full navigation (the streamed case) and by the sidebar (client side)
      await navigate(page, "/leads");
      await expectOneMain(page, (main) => main.getByRole("heading", { level: 1, name: "Leads" }));
      await navigate(page, "/");
      await expectOneMain(page, (main) =>
        main.getByRole("heading", { level: 1, name: "Signed in" }),
      );
      const nav = page.getByRole("navigation", { name: "Main" });
      if (label === "1280px") {
        await nav.getByRole("link", { name: "Inbox" }).click();
        await expectOneMain(page, (main) => main.getByRole("region", { name: "Conversations" }));
        await nav.getByRole("link", { name: "Leads" }).click();
        await expectOneMain(page, (main) => main.getByRole("heading", { level: 1, name: "Leads" }));
      }
    });
  });
