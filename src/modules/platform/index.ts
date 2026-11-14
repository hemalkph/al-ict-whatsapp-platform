// PUBLIC API of the platform module (Phase 08G-7B C1A). The one-time bootstrap (./bootstrap.ts) is deliberately NOT exported:
// only the platform:bootstrap-operator CLI reaches it.
export {
  PLATFORM_PERMISSIONS,
  PLATFORM_PERMISSION_MATRIX,
  PLATFORM_ROLES,
  platformCan,
  type PlatformPermission,
  type PlatformRole,
} from "./permissions";
export {
  REAUTHENTICATION_WINDOW_MINUTES,
  assertPlatformCan,
  hasActivePlatformRole,
  withPlatformActor,
  type PlatformActor,
  type PlatformDeps,
} from "./access";
export { listOperators, grantPlatformRole, revokePlatformRole } from "./operators";
export { listAuditEvents } from "./audit";
