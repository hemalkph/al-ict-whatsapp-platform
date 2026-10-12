import { describe, expect, it } from "vitest";
import { ActorChangedError, ValidationError } from "@/shared/errors/http-errors";
import { assertExpectedActor, parseExpectedActor } from "./expected-actor";
import type { AccessContext } from "./access";

const ctx = {
  userId: "u-1",
  organizationId: "o-1",
  membershipId: "m-1",
  role: "STAFF",
  can: () => true,
} as unknown as AccessContext;
const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));
const same = { userId: "u-1", organizationId: "o-1", membershipId: "m-1" };

describe("expected-actor header", () => {
  it("accepts exactly the authenticated actor", () => {
    expect(() => assertExpectedActor(ctx, enc(same))).not.toThrow();
  });
  it("refuses when any one identifier differs", () => {
    for (const key of Object.keys(same))
      expect(() => assertExpectedActor(ctx, enc({ ...same, [key]: "other" }))).toThrow(
        ActorChangedError,
      );
  });
  it("fails closed on anything that is not exactly the three strings", () => {
    for (const bad of [
      "",
      "nope",
      enc({}),
      enc({ userId: "u-1" }),
      enc({ ...same, extra: 1 }),
      enc({ ...same, userId: 5 }),
      enc({ ...same, userId: "x".repeat(129) }),
      enc([same]),
      enc(null),
      "%ZZ",
      "a".repeat(1025),
    ])
      expect(() => parseExpectedActor(bad), bad.slice(0, 30)).toThrow(ValidationError);
  });
  it("the refusal reveals nothing about either identity", () => {
    try {
      assertExpectedActor(ctx, enc({ ...same, userId: "someone-else" }));
    } catch (e) {
      const error = e as ActorChangedError;
      expect(error.httpStatus).toBe(409);
      expect(error.code).toBe("ACTOR_CHANGED");
      expect(`${error.message}`).not.toMatch(/u-1|someone-else|o-1|m-1/);
    }
  });
});
