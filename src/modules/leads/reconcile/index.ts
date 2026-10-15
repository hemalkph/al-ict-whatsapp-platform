// The automatic lead reconciler (Phase 07C). Entry point for the CLI and the tests ONLY: it is deliberately not exported from
// `@/modules/leads`, so nothing that imports the leads module (routes, pages) can start it. Nothing in here runs on import.
export {
  DEFAULT_OPTIONS,
  readReconcileConfig,
  type ReconcileConfig,
  type ReconcileOptions,
} from "./config";
export { EXIT_FATAL, EXIT_OK, EXIT_REFUSED, runReconcileCli, type CliOptions } from "./cli";
export { runReconciliation, type ReconcileReport } from "./run";
export { BACKOFF_SECONDS, MAX_ATTEMPTS, decide, stepAfterFailure } from "./policy";
