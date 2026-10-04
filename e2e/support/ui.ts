import type { BrowserContext, Page } from "@playwright/test";
import { E2E_PASSWORD } from "./identities";
import { serverIdle } from "./settle";

/** page.goto after the server has finished the page's earlier requests (navigating away cancels in-flight ones). */
export async function navigate(page: Page, url: string) {
  await serverIdle();
  return page.goto(url);
}

/** Closes a page or context only after the server has finished every request it received. */
export async function closeWhenIdle(target: { close(): Promise<void> }) {
  await serverIdle();
  await target.close();
}

/** Signs in through the REAL login form. Does not wait for any particular destination. */
export async function submitLogin(page: Page, email: string, password: string = E2E_PASSWORD) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function loginViaUi(
  page: Page,
  email: string,
  password: string = E2E_PASSWORD,
  next?: string,
) {
  await navigate(page, next === undefined ? "/login" : `/login?next=${encodeURIComponent(next)}`);
  await submitLogin(page, email, password);
}

/** The Better Auth session cookie as stored by the browser (name is whatever Better Auth chose). */
export async function sessionCookie(context: BrowserContext) {
  return (await context.cookies()).find((c) => c.name.includes("session_token"));
}

export type ApiResult = { status: number; text: string; json: unknown };

/**
 * A same-origin fetch() from inside the page: the browser attaches its real cookies and sends its real Origin and
 * Sec-Fetch-Site headers, exactly as application code in the page would.
 */
export async function pageFetch(
  page: Page,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  return page.evaluate(
    async ({ method, path, body, headers }) => {
      const response = await fetch(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: response.status, text, json };
    },
    { method, path, body: options.body, headers: options.headers ?? {} },
  );
}

export const errorCode = (result: ApiResult) =>
  (result.json as { error?: { code?: string } } | null)?.error?.code;
