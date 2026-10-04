// PUBLIC API of the access module (authorization). Feature modules and routes use these; they must not compare
// roles themselves.
export {
  PERMISSIONS,
  PERMISSION_MATRIX,
  ROLES,
  assertCan,
  can,
  type Permission,
  type Role,
} from "./permissions";
export {
  requireAccess,
  requirePermission,
  requireUser,
  type AccessContext,
  type AccessOptions,
  type AuthenticatedUser,
} from "./access";
