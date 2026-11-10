import { PLATFORM_ROLES } from "@/db/schema/enums";

// PLATFORM roles and permissions (Phase 08G-7B C1A, plan section 4). A separate type and matrix from the tenant ones in
// @/modules/access: a tenant ADMIN holds none of these, and none of these creates a tenant AccessContext or reveals tenant
// content. Only operations that exist today; C1B adds its permissions when its routes exist.

export { PLATFORM_ROLES };
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_PERMISSIONS = [
  "platform.operator.read",
  "platform.operator.grant",
  "platform.operator.revoke",
  "platform.audit.read_own",
  "platform.audit.read_all",
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export const PLATFORM_PERMISSION_MATRIX: Readonly<
  Record<PlatformRole, ReadonlySet<PlatformPermission>>
> = {
  PLATFORM_OPERATOR: new Set(["platform.audit.read_own"]),
  PLATFORM_SECURITY_ADMIN: new Set(PLATFORM_PERMISSIONS),
};

/** Does any of the roles hold the permission? Unknown roles hold nothing (fail closed). */
export function platformCan(roles: readonly string[], permission: PlatformPermission): boolean {
  return roles.some((r) => PLATFORM_PERMISSION_MATRIX[r as PlatformRole]?.has(permission) ?? false);
}
