import { sql } from "drizzle-orm";
import type { DbExecutor } from "./executor";

export type BotTriggerInput = {
  organizationId: string;
  whatsappAccountId: string;
  conversationId: string;
  messageId: string;
  messageType: string;
  /** The inbound handler's effective activity time, not the raw provider timestamp. */
  inputOccurredAt: Date;
};

export type BotTriggerAdmission = {
  inserted: boolean;
  /** inserted means admitted; inserted=false with that reason is a duplicate no-op. */
  reason: "inserted" | "type" | "no_deployment" | "pending_cap";
};

/**
 * Admission only, never trigger matching. The caller must hold the conversation row lock acquired by the inbound activity
 * update (or its own newly inserted row), in the same transaction. This serializes the pending count before this snapshot.
 */
export async function insertBotTriggerIfAdmitted(
  tx: DbExecutor,
  input: BotTriggerInput,
): Promise<BotTriggerAdmission> {
  if (!["TEXT", "INTERACTIVE", "BUTTON"].includes(input.messageType))
    return { inserted: false, reason: "type" };

  const result = await tx.execute<BotTriggerAdmission>(sql`
    WITH admission AS MATERIALIZED (
      SELECT c.control_seq,
        CASE WHEN NOT (
          EXISTS (
            SELECT 1 FROM bot_deployments d
            WHERE d.organization_id = c.organization_id AND d.whatsapp_account_id = c.whatsapp_account_id
              AND d.status = 'ACTIVE'
          ) OR EXISTS (
            SELECT 1 FROM bot_sessions s
            JOIN bot_deployments d ON d.organization_id = s.organization_id AND d.id = s.deployment_id
              AND d.whatsapp_account_id = s.whatsapp_account_id AND d.bot_id = s.bot_id
            WHERE s.organization_id = c.organization_id AND s.whatsapp_account_id = c.whatsapp_account_id
              AND s.conversation_id = c.id AND s.contact_id = c.contact_id
              AND s.state IN ('ACTIVE', 'WAITING_FOR_SEND', 'WAITING_FOR_INPUT')
              AND d.status IN ('ACTIVE', 'PAUSED')
          )
        ) THEN 'no_deployment'
        WHEN (SELECT count(*) FROM bot_triggers t
          WHERE t.organization_id = c.organization_id AND t.whatsapp_account_id = c.whatsapp_account_id
            AND t.conversation_id = c.id AND t.status = 'PENDING') >= 20 THEN 'pending_cap'
        ELSE 'inserted' END AS reason
      FROM conversations c
      JOIN messages m ON m.organization_id = c.organization_id AND m.conversation_id = c.id
        AND m.whatsapp_account_id = c.whatsapp_account_id
      WHERE c.organization_id = ${input.organizationId} AND c.whatsapp_account_id = ${input.whatsappAccountId}
        AND c.id = ${input.conversationId} AND m.id = ${input.messageId}
        AND m.direction = 'INBOUND' AND m.type = ${input.messageType}
        AND m.type IN ('TEXT', 'INTERACTIVE', 'BUTTON')
    ), inserted AS (
      INSERT INTO bot_triggers (organization_id, whatsapp_account_id, conversation_id, message_id,
        input_occurred_at, enqueued_at, observed_control_seq)
      SELECT ${input.organizationId}, ${input.whatsappAccountId}, ${input.conversationId}, ${input.messageId},
        ${input.inputOccurredAt.toISOString()}::timestamptz, clock_timestamp(), control_seq
      FROM admission WHERE reason = 'inserted'
      ON CONFLICT (organization_id, message_id) DO NOTHING
      RETURNING id
    )
    SELECT EXISTS (SELECT 1 FROM inserted) AS inserted,
      COALESCE((SELECT reason FROM admission), 'no_deployment') AS reason
  `);
  return result.rows[0]!;
}
