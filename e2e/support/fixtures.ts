import { createHash } from "node:crypto";
import { test as base, expect } from "@playwright/test";
import { closeDb } from "./db";

// Every test fails on an uncaught page exception or a browser console error. Failed network requests the tests
// provoke on purpose (401/403/429 responses) are logged by the browser as console errors and are not application errors.
const EXPECTED_NETWORK_NOISE = /Failed to load resource/i;

// The server's database rate limiter keys on the client IP, and every browser here connects from the same address.
// Without this, the suite's own logins would trip the limiter after five attempts. Each test therefore presents its
// own deterministic client IP, the same technique the integration tests use (uniqueIp). Application proxy-header
// trust is unchanged. The dedicated rate-limit test replaces it with a fixed IP on purpose.
const clientIpFor = (testId: string) => {
  const [a = 0, b = 0, c = 0] = createHash("sha1").update(testId).digest();
  return `10.${a}.${b}.${c}`;
};

export const test = base.extend<{ pageProblems: void }>({
  extraHTTPHeaders: async ({}, run, testInfo) => {
    await run({ "x-forwarded-for": clientIpFor(testInfo.testId) });
  },
  pageProblems: [
    async ({ page }, run) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error" && !EXPECTED_NETWORK_NOISE.test(message.text())) {
          problems.push(`console.error: ${message.text()}`);
        }
      });
      await run();
      expect(problems, "unexpected browser errors").toEqual([]);
    },
    { auto: true },
  ],
});

test.afterAll(async () => {
  await closeDb();
});

export { expect };
