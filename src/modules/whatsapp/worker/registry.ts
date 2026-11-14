import { insertBotTriggerIfAdmitted } from "@/db/ops/bot-trigger";
import { emitBotRuntimeLog, triggerCaptureEnabled } from "@/modules/bot-runtime";
import { createInboundMessageHandler, handleInboundMessage } from "../inbound/handler";
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

/** Only the webhook worker's injected environment authorizes capture; unrelated send/worker flags cannot do so. */
export function buildWebhookWorkerHandlers(
  env: Record<string, string | undefined>,
): WebhookHandlerRegistry {
  if (!triggerCaptureEnabled(env)) return webhookWorkerHandlers;
  return Object.freeze({
    MESSAGE: createInboundMessageHandler({
      captureBotTrigger: async (sp, input) => {
        const result = await insertBotTriggerIfAdmitted(sp, input);
        if (result.reason === "pending_cap")
          emitBotRuntimeLog({
            event: "bots.trigger_capped",
            outcome: "denied",
            organizationId: input.organizationId,
            whatsappAccountId: input.whatsappAccountId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            reason: "pending_cap",
            count: 20,
          });
      },
    }),
    STATUS: handleMessageStatus,
  });
}
