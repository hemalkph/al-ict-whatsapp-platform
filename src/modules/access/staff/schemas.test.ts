import { describe, expect, it } from "vitest";
import { ValidationError, toErrorResponse } from "@/shared/errors/http-errors";
import {
  changeMemberRoleSchema,
  createStaffSchema,
  parseInput,
  reactivateMemberSchema,
  resetStaffPasswordSchema,
  suspendMemberSchema,
} from "./schemas";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const validCreate = {
  email: "New.Person@Example.com",
  name: "New Person",
  role: "STAFF",
  initialPassword: "correct-horse-battery",
};

describe("staff input schemas", () => {
  it("createStaff normalizes email (trim + lowercase) and name", () => {
    const parsed = parseInput(createStaffSchema, {
      ...validCreate,
      email: "  New.Person@Example.COM  ",
      name: "  New Person  ",
    });
    expect(parsed.email).toBe("new.person@example.com");
    expect(parsed.name).toBe("New Person");
  });

  it.each([
    ["organizationId", { organizationId: UUID }],
    ["userId", { userId: UUID }],
    ["membershipId", { membershipId: UUID }],
    ["status", { status: "ACTIVE" }],
    ["passwordChangeRequired", { passwordChangeRequired: false }],
    ["isAdmin", { isAdmin: true }],
  ])("createStaff REJECTS an extra %s field (no mass assignment)", (key, extra) => {
    let err: unknown;
    try {
      parseInput(createStaffSchema, { ...validCreate, ...extra });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fields).toContain(key);
  });

  it.each([
    ["invalid role", { role: "OWNER" }, "role"],
    ["lowercase role", { role: "admin" }, "role"],
    ["bad email", { email: "not-an-email" }, "email"],
    ["blank name", { name: "   " }, "name"],
    ["11-char password", { initialPassword: "a".repeat(11) }, "initialPassword"],
    ["129-char password", { initialPassword: "a".repeat(129) }, "initialPassword"],
    ["non-string password", { initialPassword: 12345678901234 }, "initialPassword"],
  ])("createStaff rejects %s", (_n, patch, field) => {
    expect(() => parseInput(createStaffSchema, { ...validCreate, ...patch })).toThrow(
      ValidationError,
    );
    try {
      parseInput(createStaffSchema, { ...validCreate, ...patch });
    } catch (e) {
      expect((e as ValidationError).fields).toContain(field);
    }
  });

  it("accepts 12 and 128 character passwords", () => {
    expect(() =>
      parseInput(createStaffSchema, { ...validCreate, initialPassword: "a".repeat(12) }),
    ).not.toThrow();
    expect(() =>
      parseInput(createStaffSchema, { ...validCreate, initialPassword: "a".repeat(128) }),
    ).not.toThrow();
  });

  it("rejects missing fields and non-object input", () => {
    for (const bad of [{}, null, undefined, "x", [], 42])
      expect(() => parseInput(createStaffSchema, bad)).toThrow(ValidationError);
  });

  it("changeMemberRole accepts only {membershipId, role}", () => {
    expect(parseInput(changeMemberRoleSchema, { membershipId: UUID, role: "VIEWER" })).toEqual({
      membershipId: UUID,
      role: "VIEWER",
    });
    for (const extra of [
      { organizationId: UUID },
      { userId: UUID },
      { status: "ACTIVE" },
      { passwordChangeRequired: true },
    ]) {
      expect(() =>
        parseInput(changeMemberRoleSchema, { membershipId: UUID, role: "STAFF", ...extra }),
      ).toThrow(ValidationError);
    }
    expect(() =>
      parseInput(changeMemberRoleSchema, { membershipId: "not-a-uuid", role: "STAFF" }),
    ).toThrow(ValidationError);
    expect(() =>
      parseInput(changeMemberRoleSchema, { membershipId: UUID, role: "SUPERUSER" }),
    ).toThrow(ValidationError);
  });

  it.each([
    ["suspendMember", suspendMemberSchema],
    ["reactivateMember", reactivateMemberSchema],
  ])("%s accepts only {membershipId}; role/status/org/user fields are rejected", (_n, schema) => {
    expect(parseInput(schema, { membershipId: UUID })).toEqual({ membershipId: UUID });
    for (const extra of [
      { role: "ADMIN" },
      { status: "ACTIVE" },
      { organizationId: UUID },
      { userId: UUID },
    ]) {
      expect(() => parseInput(schema, { membershipId: UUID, ...extra })).toThrow(ValidationError);
    }
  });

  it("resetStaffPassword accepts only {membershipId, newPassword} within 12..128", () => {
    expect(
      parseInput(resetStaffPasswordSchema, {
        membershipId: UUID,
        newPassword: "a-very-long-password",
      }).newPassword,
    ).toBe("a-very-long-password");
    expect(() =>
      parseInput(resetStaffPasswordSchema, { membershipId: UUID, newPassword: "short" }),
    ).toThrow(ValidationError);
    for (const extra of [
      { role: "ADMIN" },
      { passwordChangeRequired: false },
      { organizationId: UUID },
      { email: "x@y.com" },
    ]) {
      expect(() =>
        parseInput(resetStaffPasswordSchema, {
          membershipId: UUID,
          newPassword: "a-very-long-password",
          ...extra,
        }),
      ).toThrow(ValidationError);
    }
  });

  it("validation errors carry field names only, never submitted values, and map to a 400", async () => {
    let err: unknown;
    try {
      parseInput(createStaffSchema, {
        ...validCreate,
        initialPassword: "tiny-secret",
        extra: "leak-me",
      });
    } catch (e) {
      err = e;
    }
    const res = toErrorResponse(err);
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("initialPassword");
    expect(text).not.toMatch(/tiny-secret|leak-me|example\.com/);
  });
});
