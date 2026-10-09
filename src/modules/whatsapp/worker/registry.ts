import { handleInboundMessage } from "../inbound/handler";
import type { WebhookHandlerRegistry } from "../queue/process";
import { handleMessageStatus } from "../status/handler";

/**
 * The handlers the worker runs. EXACTLY these two, listed by name. There is no no-op handler and no entry for IDENTITY or
 * OTHER: an event of a type without a handler is never claimed, so it stays where ingest put it instead of being marked
 * PROCESSED without domain logic. Frozen so nothing can add a handler at runtime.
 */
export const webhookWorkerHandlers: WebhookHandlerRegistry = Object.freeze({
  MESSAGE: handleInboundMessage,
  STATUS: handleMessageStatus,
});
