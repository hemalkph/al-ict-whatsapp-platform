// PUBLIC API of the bot-control module (Phase 08C, ADR 0019): database services for bot drafts, immutable published
// versions and the deployment lifecycle, behind the approved authorization sequence. The operator CLI (scripts/bots-admin.ts)
// uses all of it; the HTTP API (DEV-1, src/app/api/bots) uses only list, create, read, draft save and draft validation.
// It never sends, never calls Meta and never runs the engine (no runtime before 08E).
export type { BotControlDeps, WriteOptions, Written } from "./common";
export { BotControlError, type BotControlErrorCode } from "./errors";
export { createBot, getBot, listBots, updateDraft, validateDraft, type BotSummary } from "./drafts";
export {
  canonicalWithHash,
  getVersion,
  listVersions,
  publishVersion,
  type VersionSummary,
} from "./publish";
export {
  activateDeployment,
  changeDeploymentVersion,
  emergencyStop,
  listDeployments,
  liveSessionCount,
  pauseDeployment,
  resumeDeployment,
  retireDeployment,
  stopActiveSessions,
  type DeploymentSummary,
  type EmergencyStopResult,
  type StopResult,
} from "./deployments";
export {
  LISTING_LIMIT_DEFAULT,
  LISTING_LIMIT_MAX,
  listBotSessions,
  listBotsPage,
  listDeadTriggers,
  listDeploymentsPage,
  type BotListItem,
  type DeadTriggerItem,
  type DeploymentListItem,
  type Page,
  type SessionListItem,
} from "./listings";
export { EMERGENCY_STOP_PHRASE } from "./schemas";
// Phase 08E-5/08E-6: the session-scoped hold, for the bot runtime (step takeover, terminalization, reconciliation) only.
export {
  OUTPUT_SUPPRESSED_HOLD_CODE,
  SEND_DEADLINE_HOLD_CODE,
  suppressSessionQueuedRequests,
  type SuppressionExecutor,
} from "./suppression";
