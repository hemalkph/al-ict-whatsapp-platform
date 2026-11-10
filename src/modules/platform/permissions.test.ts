import { describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES } from "@/db/schema/enums";
import { PERMISSIONS, PERMISSION_MATRIX } from "@/modules/access";
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_PERMISSION_MATRIX,
  PLATFORM_ROLES,
  platformCan,
  type PlatformPermission,
  type PlatformRole,
} from "./permissions";

// C1A-T18 (and the unit halves of T3/T4). Hand-written expectation, deliberately NOT derived from the implementation.
const EXPECTED: Record<PlatformPermission, Record<PlatformRole, boolean>> = {
  "platform.operator.read": { PLATFORM_OPERATOR: false, PLATFORM_SECURITY_ADMIN: true },
  "platform.operator.grant": { PLATFORM_OPERATOR: false, PLATFORM_SECURITY_ADMIN: true },
  "platform.operator.revoke": { PLATFORM_OPERATOR: false, PLATFORM_SECURITY_ADMIN: true },
  "platform.audit.read_own": { PLATFORM_OPERATOR: true, PLATFORM_SECURITY_ADMIN: true },
  "platform.audit.read_all": { PLATFORM_OPERATOR: false, PLATFORM_SECURITY_ADMIN: true },
};

describe("platform permission matrix", () => {
  it("has exactly the two approved roles and the five C1A permissions", () => {
    expect([...PLATFORM_ROLES]).toEqual(["PLATFORM_OPERATOR", "PLATFORM_SECURITY_ADMIN"]);
    expect([...PLATFORM_PERMISSIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(PLATFORM_PERMISSIONS)("pins %s for every role", (p) => {
    for (const role of PLATFORM_ROLES) expect(platformCan([role], p), role).toBe(EXPECTED[p][role]);
  });

  it("holding both roles is the union, nothing more", () => {
    for (const p of PLATFORM_PERMISSIONS)
      expect(platformCan(["PLATFORM_OPERATOR", "PLATFORM_SECURITY_ADMIN"], p)).toBe(true);
    expect(PLATFORM_PERMISSION_MATRIX.PLATFORM_OPERATOR.size).toBe(1);
  });

  it("fails closed for no role, unknown roles and tenant roles (a tenant ADMIN holds no platform permission)", () => {
    for (const p of PLATFORM_PERMISSIONS) {
      expect(platformCan([], p)).toBe(false);
      expect(platformCan(["SUPER_ADMIN", "platform_security_admin"], p)).toBe(false);
      expect(platformCan([...MEMBERSHIP_ROLES], p)).toBe(false);
    }
  });

  it("tenant and platform permissions are disjoint; the tenant ADMIN set is unchanged (every tenant permission, no platform one)", () => {
    const tenant = new Set<string>(PERMISSIONS);
    for (const p of PLATFORM_PERMISSIONS) expect(tenant.has(p)).toBe(false);
    for (const p of PERMISSIONS) expect(p.startsWith("platform.")).toBe(false);
    expect([...PERMISSION_MATRIX.ADMIN].sort()).toEqual([...PERMISSIONS].sort());
    for (const role of PLATFORM_ROLES) expect(Object.keys(PERMISSION_MATRIX)).not.toContain(role);
  });
});
