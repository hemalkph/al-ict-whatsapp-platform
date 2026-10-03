import { eq, sql } from "drizzle-orm";
import { conversations } from "../schema/messaging";
import type { DbExecutor } from "./executor";

/**
 * Creates the conversation together with its first message, or advances activity timestamps.
 * Timestamps come from the message's actual occurred_at and only ever move forward (GREATEST ignores
 * NULL), so out-of-order processing cannot move activity backwards. Run in the message's transaction.
 */
export async function upsertConversationActivity(
  tx: DbExecutor,
  input: {
    organizationId: string;
    whatsappAccountId: string;
    contactId: string;
    direction: "INBOUND" | "OUTBOUND";
    occurredAt: Date;
  },
): Promise<string> {
  const inbound = input.direction === "INBOUND";
  const [row] = await tx
    .insert(conversations)
    .values({
      organizationId: input.organizationId,
      whatsappAccountId: input.whatsappAccountId,
      contactId: input.contactId,
      lastMessageAt: input.occurredAt,
      lastInboundAt: inbound ? input.occurredAt : null,
      lastOutboundAt: inbound ? null : input.occurredAt,
    })
    .onConflictDoUpdate({
      target: [
        conversations.organizationId,
        conversations.whatsappAccountId,
        conversations.contactId,
      ],
      set: {
        lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, excluded.last_message_at)`,
        lastInboundAt: sql`GREATEST(${conversations.lastInboundAt}, excluded.last_inbound_at)`,
        lastOutboundAt: sql`GREATEST(${conversations.lastOutboundAt}, excluded.last_outbound_at)`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: conversations.id });
  if (!row) throw new Error("conversation upsert returned no row");
  return row.id;
}

export async function getConversation(tx: DbExecutor, id: string) {
  const [row] = await tx.select().from(conversations).where(eq(conversations.id, id));
  return row;
}
