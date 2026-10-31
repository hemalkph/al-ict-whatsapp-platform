import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { routingLockKey } from "./deployments";
import { activateSchema, parse } from "./schemas";

// Phase 08G-7A P2 regression (database-free): every spelling of one organization/account pair that the input schema accepts
// must reach the SAME routing advisory lock, and the three deployment mutations must all take it through the one helper.

const ORG = "0f1e2d3c-4b5a-4968-8776-655443322110";
const ACCOUNT = "aabbccdd-1122-4344-8556-778899aabbcc";
const ACCOUNT_UPPER = "AABBCCDD-1122-4344-8556-778899AABBCC";

describe("routing lock key (08G-7A)", () => {
  it("the activation schema accepts the upper-case spelling unchanged, which is why the key must canonicalize", () => {
    const input = parse(activateSchema, {
      botId: ORG,
      versionId: ORG,
      whatsappAccountId: ACCOUNT_UPPER,
      priority: 1,
    });
    expect(input.whatsappAccountId).toBe(ACCOUNT_UPPER);
    expect(routingLockKey(ORG, input.whatsappAccountId)).toBe(routingLockKey(ORG, ACCOUNT));
  });

  it("lower, upper and mixed case of both the organization and the account give one key", () => {
    const expected = `bot-routing:${ORG}:${ACCOUNT}`;
    for (const org of [ORG, ORG.toUpperCase(), "0F1e2D3c-4B5a-4968-8776-655443322110"])
      for (const account of [ACCOUNT, ACCOUNT_UPPER, "AaBbCcDd-1122-4344-8556-778899aAbBcC"])
        expect(routingLockKey(org, account)).toBe(expected);
  });

  it("different accounts, different organizations and swapped components keep distinct keys", () => {
    const other = "aabbccdd-1122-4344-8556-778899aabbcd";
    const keys = [
      routingLockKey(ORG, ACCOUNT),
      routingLockKey(ORG, other),
      routingLockKey(other, ACCOUNT),
      routingLockKey(ACCOUNT, ORG),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("Activate, Resume and Change Version all take the lock through the one helper, before the bot", () => {
    const src = readFileSync(new URL("./deployments.ts", import.meta.url), "utf8");
    const body = (name: string) => {
      const start = src.indexOf(`export async function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const end = src.indexOf("\nexport ", start + 1);
      return src.slice(start, end === -1 ? undefined : end);
    };
    expect(src.match(/hashtextextended\(/g)).toHaveLength(1); // one lock statement in the file
    expect(src).toMatch(/const key = routingLockKey\(organizationId, whatsappAccountId\);/);
    const activate = body("activateDeployment");
    const routingAt = activate.indexOf(
      "lockAccountRouting(tx, ctx.organizationId, input.whatsappAccountId)",
    );
    expect(routingAt).toBeGreaterThan(-1);
    expect(routingAt).toBeLessThan(activate.indexOf("lockBot("));
    for (const name of ["resumeDeployment", "changeDeploymentVersion"])
      expect(body(name)).toMatch(
        /lockForAdmin\(tx, ctx\.organizationId, input\.deploymentId, true\)/,
      );
    const admin = src.slice(src.indexOf("async function lockForAdmin("));
    expect(admin.indexOf("lockAccountRouting(")).toBeGreaterThan(-1);
    expect(admin.indexOf("lockAccountRouting(")).toBeLessThan(admin.indexOf("lockBot("));
    for (const name of ["activateDeployment", "resumeDeployment", "changeDeploymentVersion"])
      expect(body(name)).toMatch(/assertSupportedRouting\(/);
  });
});
