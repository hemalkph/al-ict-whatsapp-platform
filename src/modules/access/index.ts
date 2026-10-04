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
export {
  changeMemberRole,
  createStaff,
  listStaff,
  reactivateMember,
  resetStaffPassword,
  suspendMember,
  type StaffDeps,
  type StaffMember,
} from "./staff";
export {
  getPageAccess,
  loginDestination,
  pageRedirectFor,
  type DeniedStatus,
  type PageAccess,
} from "./page-access";
export {
  changeOwnPassword,
  getPasswordChangeStatus,
  type ChangeOwnPasswordResult,
  type PasswordChangeStatus,
} from "./password-change";
export { getAccessSummary, type AccessSummary } from "./summary";
