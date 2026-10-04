import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMBERSHIP_ROLES } from "@/db/schema/enums";
import { ForbiddenError } from "@/shared/errors/http-errors";
import {
  PERMISSIONS,
  PERMISSION_MATRIX,
  ROLES,
  assertCan,
  can,
  type Permission,
  type Role,
} from "./permissions";

afterEach(() => vi.restoreAllMocks());

// Hand-written expectation: every role x every permission. Deliberately NOT derived from the implementation.
const EXPECTED: Record<Permission, Record<Role, boolean>> = {
  "organization.manage": { ADMIN: true, STAFF: false, VIEWER: false },
  "staff.read": { ADMIN: true, STAFF: true, VIEWER: false },
  "staff.manage": { ADMIN: true, STAFF: false, VIEWER: false },
  "whatsapp_account.read": { ADMIN: true, STAFF: true, VIEWER: true },
  "whatsapp_account.manage": { ADMIN: true, STAFF: false, VIEWER: false },
  "contact.read": { ADMIN: true, STAFF: true, VIEWER: true },
  "contact.edit": { ADMIN: true, STAFF: true, VIEWER: false },
  "consent.record": { ADMIN: true, STAFF: true, VIEWER: false },
  "lead.read": { ADMIN: true, STAFF: true, VIEWER: true },
  "lead.edit": { ADMIN: true, STAFF: true, VIEWER: false },
  "conversation.read": { ADMIN: true, STAFF: true, VIEWER: true },
  "conversation.reply": { ADMIN: true, STAFF: true, VIEWER: false },
  "conversation.manage": { ADMIN: true, STAFF: true, VIEWER: false },
  "tag.manage": { ADMIN: true, STAFF: true, VIEWER: false },
  "webhook.manage": { ADMIN: true, STAFF: false, VIEWER: false },
};

describe("permission model", () => {
  it("defines exactly the approved roles, matching the database CHECK list", () => {
    expect([...ROLES]).toEqual(["ADMIN", "STAFF", "VIEWER"]);
    expect([...ROLES]).toEqual([...MEMBERSHIP_ROLES]);
  });

  it("defines exactly the approved 15 permissions", () => {
    expect(PERMISSIONS).toHaveLength(15);
    expect(new Set(PERMISSIONS).size).toBe(15);
    expect(Object.keys(EXPECTED).sort()).toEqual([...PERMISSIONS].sort()); // every permission has an explicit row
  });

  for (const permission of PERMISSIONS) {
    for (const role of ROLES) {
      it(`${role} ${EXPECTED[permission][role] ? "CAN" : "CANNOT"} ${permission}`, () => {
        expect(can(role, permission)).toBe(EXPECTED[permission][role]);
        expect(can({ role }, permission)).toBe(EXPECTED[permission][role]);
        expect(PERMISSION_MATRIX[role].has(permission)).toBe(EXPECTED[permission][role]);
      });
    }
  }

  it("ADMIN holds every permission", () => {
    for (const p of PERMISSIONS) expect(can("ADMIN", p)).toBe(true);
  });

  it("VIEWER is read-only: only *.read permissions, never edit/manage/reply/record", () => {
    const held = PERMISSIONS.filter((p) => can("VIEWER", p));
    expect(held.length).toBeGreaterThan(0);
    for (const p of held) expect(p).toMatch(/\.read$/);
    for (const p of PERMISSIONS) {
      if (/\.(edit|manage|reply|record)$/.test(p)) expect(can("VIEWER", p), p).toBe(false);
    }
  });

  it("STAFF cannot manage the organization, staff, WhatsApp accounts or webhooks", () => {
    for (const p of [
      "organization.manage",
      "staff.manage",
      "whatsapp_account.manage",
      "webhook.manage",
    ] as const) {
      expect(can("STAFF", p), p).toBe(false);
    }
  });

  it("fails closed for an unknown role", () => {
    expect(can("OWNER" as Role, "contact.read")).toBe(false);
    expect(can({ role: "" as Role }, "contact.read")).toBe(false);
  });
});

describe("assertCan", () => {
  it("returns silently when permitted", () => {
    expect(() => assertCan({ role: "STAFF" }, "conversation.reply")).not.toThrow();
    expect(() => assertCan("ADMIN", "staff.manage")).not.toThrow();
  });

  it("throws a 403 ForbiddenError when not permitted, with a generic message", () => {
    let caught: unknown;
    try {
      assertCan({ role: "VIEWER", userId: "u1", organizationId: "o1" }, "contact.edit");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect((caught as ForbiddenError).httpStatus).toBe(403);
    expect((caught as ForbiddenError).message).not.toMatch(/contact|VIEWER|o1|u1/);
  });

  it("emits a security event on denial without secrets", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      assertCan({ role: "VIEWER", userId: "u1", organizationId: "o1" }, "staff.manage"),
    ).toThrow();
    const line = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      security_event: "access.permission_denied",
      permission: "staff.manage",
      user_id: "u1",
      organization_id: "o1",
    });
  });
});
