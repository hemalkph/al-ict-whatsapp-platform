// Internal queue/worker core. NOT part of the module's public API (../index.ts): nothing in the application starts a
// worker until the domain-handler checkpoint supplies real handlers.
export { processClaimedEvent, processWebhookBatch } from "./process";
export type {
  BatchSummary,
  EventOutcome,
  ProcessBatchOptions,
  WebhookEventKind,
  WebhookHandler,
  WebhookHandlerContext,
  WebhookHandlerEvent,
  WebhookHandlerRegistry,
} from "./process";
export { PermanentWebhookError } from "./errors";
export {
  MAX_ATTEMPTS,
  LEASE_SECONDS,
  REQUEUE_MAX_AGE_MS,
  retryDelaySeconds,
  retryDelayMs,
} from "./policy";
export {
  AUTO_REQUEUE_REASONS,
  OPERATOR_ROUTED_REASONS,
  UNROUTED_REASONS,
  requeueOnAccountActivation,
  requeueRoutedHeldEvents,
  requeueUnroutedEvent,
} from "./requeue";
export type {
  RoutedRequeueReason,
  RoutedRequeueResult,
  UnroutedRequeueRefusal,
  UnroutedRequeueResult,
} from "./requeue";
export { readQueueStats } from "./stats";
export type { QueueStats } from "./stats";
