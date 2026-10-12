import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { TestDb } from "@/db/__tests__/helpers";
import { ON, addActor, minutesAgo, world } from "@/modules/messaging/testing";

// TEST-ONLY helpers (excluded from the boundary scans). Fake students and fake messages only.

export { ON, addActor, minutesAgo, world };
type Db = TestDb["db"];
type W = {
  org: { id: string };
  account: { id: string };
  conversation: { id: string };
  contact?: { id: string };
};

let n = 0;
const uniq = () => `${(n++).toString(36)}${randomBytes(2).toString("hex")}`;

export async function addMessage(
  db: Db,
  w: { org: { id: string }; account: { id: string }; conversation: { id: string } },
  o: {
    direction?: "INBOUND" | "OUTBOUND";
    type?: string;
    body?: string | null;
    content?: unknown;
    occurredAt?: Date;
    createdAt?: Date;
    wamid?: string | null;
    latestStatus?: "SENT" | "DELIVERED" | "READ" | "FAILED" | null;
    replyToMessageId?: string | null;
    replyToWamid?: string | null;
    errorCode?: string | null;
  } = {},
) {
  const direction = o.direction ?? "INBOUND";
  const [row] = await db
    .insert(schema.messages)
    .values({
      organizationId: w.org.id,
      conversationId: w.conversation.id,
      whatsappAccountId: w.account.id,
      direction,
      type: o.type ?? "TEXT",
      body: o.body === undefined ? `hello ${uniq()}` : o.body,
      content: o.content ?? null,
      occurredAt: o.occurredAt ?? new Date(),
      wamid:
        o.wamid === undefined ? (direction === "INBOUND" ? `wamid.IN${uniq()}` : null) : o.wamid,
      latestStatus: o.latestStatus ?? null,
      latestStatusAt: o.latestStatus ? new Date() : null,
      errorCode: o.errorCode ?? null,
      replyToMessageId: o.replyToMessageId ?? null,
      replyToWamid: o.replyToWamid ?? null,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    })
    .returning();
  return row!;
}

/** Another contact + conversation in the same organization (same or another WhatsApp account). */
export async function addConversation(
  db: Db,
  w: { org: { id: string }; account: { id: string } },
  o: {
    profileName?: string | null;
    username?: string | null;
    waId?: string | null;
    bsuid?: string;
    lastMessageAt?: Date;
    lastInboundAt?: Date | null;
    status?: "OPEN" | "PENDING" | "RESOLVED";
    accountId?: string;
    assignedMembershipId?: string | null;
  } = {},
) {
  const seen = new Date("2026-01-01T00:00:00Z");
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: w.org.id,
      waId: o.waId === undefined ? `9477${Math.floor(1000000 + Math.random() * 8999999)}` : o.waId,
      profileName: o.profileName === undefined ? null : o.profileName,
      username: o.username ?? null,
      firstSeenAt: seen,
      lastSeenAt: seen,
    })
    .returning();
  if (o.bsuid)
    await db.insert(schema.contactBsuids).values({
      organizationId: w.org.id,
      contactId: contact!.id,
      bsuid: o.bsuid,
      firstSeenAt: seen,
      lastSeenAt: seen,
    });
  const last = o.lastMessageAt ?? new Date();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: w.org.id,
      whatsappAccountId: o.accountId ?? w.account.id,
      contactId: contact!.id,
      status: o.status ?? "OPEN",
      lastMessageAt: last,
      lastInboundAt: o.lastInboundAt === undefined ? last : o.lastInboundAt,
      resolvedAt: o.status === "RESOLVED" ? last : null,
      ...(o.assignedMembershipId
        ? { assignedMembershipId: o.assignedMembershipId, assignedAt: new Date() }
        : {}),
    })
    .returning();
  return { contact: contact!, conversation: conversation! };
}

export async function addAccount(db: Db, organizationId: string, label = "+94 77 111 2222") {
  const digits = (len: number) =>
    `1${Array.from({ length: len - 1 }, () => Math.floor(Math.random() * 10)).join("")}`;
  const [account] = await db
    .insert(schema.whatsappAccounts)
    .values({
      organizationId,
      wabaId: digits(15),
      phoneNumberId: digits(15),
      displayPhoneNumber: label,
      status: "ACTIVE",
      credentialRef: "WA_TOKEN_TEST",
    })
    .returning();
  return account!;
}

export async function setMembershipStatus(
  db: Db,
  membershipId: string,
  status: "ACTIVE" | "SUSPENDED",
) {
  await db
    .update(schema.organizationMemberships)
    .set({ status })
    .where(eq(schema.organizationMemberships.id, membershipId));
}

/** Walks an outbound request through the legal lifecycle to the given state (rows are created by the real submit path). */
export async function forceRequestState(
  pool: TestDb["pool"],
  requestId: string,
  state: "SENDING" | "ACCEPTED" | "REJECTED" | "HELD" | "UNKNOWN_OUTCOME",
  extra: { holdReason?: string; failureCode?: string } = {},
) {
  if (state === "HELD") {
    await pool.query(
      "update outbound_requests set state='HELD', hold_reason=$2, finished_at=now() where id=$1",
      [requestId, extra.holdReason ?? "window_closed"],
    );
    return;
  }
  await pool.query(
    "update outbound_requests set state='SENDING', claimed_by='test', claimed_at=now(), send_started_at=now() where id=$1",
    [requestId],
  );
  if (state === "SENDING") return;
  if (state === "ACCEPTED")
    await pool.query(
      "update outbound_requests set state='ACCEPTED', accepted_at=now(), finished_at=now() where id=$1",
      [requestId],
    );
  if (state === "REJECTED")
    await pool.query(
      "update outbound_requests set state='REJECTED', failure_code=$2, finished_at=now() where id=$1",
      [requestId, extra.failureCode ?? "invalid_request"],
    );
  if (state === "UNKNOWN_OUTCOME")
    await pool.query(
      "update outbound_requests set state='UNKNOWN_OUTCOME', failure_code='transport_timeout', finished_at=now() where id=$1",
      [requestId],
    );
}

export type { W };
