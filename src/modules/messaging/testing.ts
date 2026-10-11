import { randomBytes } from "node:crypto";
import { schema, type Database } from "@/db";
import type { AccessContext } from "@/modules/access";
import { can, type Role } from "@/modules/access";
import type { TestDb } from "@/db/__tests__/helpers";
import type { OutboundConfig } from "./config";
import type { OutboundTransport, SendRequest, SendResult } from "./transport";

// TEST-ONLY helpers (excluded from the boundary scans). Nothing here can reach Meta: the fake transport records what it was
// asked to send and answers from a script.

export const ON: OutboundConfig = {
  outboundEnabled: true,
  liveSendEnabled: true,
  bsuidRecipientEnabled: false,
  graphApiVersion: "v25.0",
};

export class FakeTransport implements OutboundTransport {
  readonly calls: SendRequest[] = [];
  private script: Array<
    SendResult | Error | ((r: SendRequest) => SendResult | Promise<SendResult>)
  > = [];
  /** Used when the script is empty. */
  fallback: SendResult | ((r: SendRequest) => SendResult | Promise<SendResult>) = {
    kind: "accepted",
    wamid: "wamid.FAKE000",
    providerStatus: "accepted",
    httpStatus: 200,
  };
  private n = 0;
  next(
    ...results: Array<SendResult | Error | ((r: SendRequest) => SendResult | Promise<SendResult>)>
  ) {
    this.script.push(...results);
    return this;
  }
  /** Every call is accepted with a fresh, unique wamid. */
  acceptAll(prefix = "wamid.FAKE") {
    this.fallback = () => ({
      kind: "accepted",
      wamid: `${prefix}${++this.n}-${randomBytes(3).toString("hex")}`,
      providerStatus: "accepted",
      httpStatus: 200,
    });
    return this;
  }
  async send(request: SendRequest): Promise<SendResult> {
    this.calls.push(request);
    const step = this.script.shift() ?? this.fallback;
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(request) : step;
  }
}

let n = 0;
const uniq = () => `${(n++).toString(36)}${randomBytes(2).toString("hex")}`;
const digits = (len: number) => {
  let s = "";
  while (s.length < len) s += Math.floor(Math.random() * 10);
  return `1${s.slice(1)}`;
};

export const minutesAgo = (m: number, from = new Date()) => new Date(from.getTime() - m * 60_000);

export type Actor = { ctx: AccessContext; userId: string; membershipId: string; role: Role };

export async function addActor(
  db: TestDb["db"] | Database,
  organizationId: string,
  role: Role = "STAFF",
): Promise<Actor> {
  const [user] = await db
    .insert(schema.users)
    .values({ name: "Staff", email: `s-${uniq()}@example.com` })
    .returning();
  const [membership] = await db
    .insert(schema.organizationMemberships)
    .values({ organizationId, userId: user!.id, role })
    .returning();
  return {
    userId: user!.id,
    membershipId: membership!.id,
    role,
    ctx: {
      userId: user!.id,
      membershipId: membership!.id,
      organizationId,
      role,
      can: (p) => can(role, p),
    },
  };
}

export type WorldOptions = {
  lastInboundAt?: Date | null;
  waId?: string | null;
  bsuids?: Array<{ bsuid: string; retired?: boolean }>;
  consent?: "UNKNOWN" | "GRANTED" | "WITHDRAWN";
  accountStatus?: "PENDING" | "ACTIVE" | "DISABLED";
  credentialRef?: string | null;
  role?: Role;
};

/** An organization with an ACTIVE account, one contact, one conversation and a staff actor. */
export async function world(db: TestDb["db"], o: WorldOptions = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", slug: `org-${uniq()}` })
    .returning();
  const [account] = await db
    .insert(schema.whatsappAccounts)
    .values({
      organizationId: org!.id,
      wabaId: digits(15),
      phoneNumberId: digits(15),
      displayPhoneNumber: "+94 77 000 0000",
      status: o.accountStatus ?? "ACTIVE",
      credentialRef: o.credentialRef === undefined ? "WA_TOKEN_TEST" : o.credentialRef,
    })
    .returning();
  const seen = new Date("2026-01-01T00:00:00Z");
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: org!.id,
      waId: o.waId === undefined ? digits(11) : o.waId,
      firstSeenAt: seen,
      lastSeenAt: seen,
      marketingConsentStatus: o.consent ?? "UNKNOWN",
    })
    .returning();
  for (const a of o.bsuids ?? [])
    await db.insert(schema.contactBsuids).values({
      organizationId: org!.id,
      contactId: contact!.id,
      bsuid: a.bsuid,
      firstSeenAt: seen,
      lastSeenAt: seen,
      retiredAt: a.retired ? seen : null,
    });
  const lastInbound = o.lastInboundAt === undefined ? minutesAgo(30) : o.lastInboundAt;
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: org!.id,
      whatsappAccountId: account!.id,
      contactId: contact!.id,
      lastMessageAt: lastInbound ?? seen,
      lastInboundAt: lastInbound,
    })
    .returning();
  const actor = await addActor(db, org!.id, o.role ?? "STAFF");
  return { org: org!, account: account!, contact: contact!, conversation: conversation!, actor };
}

export async function addTemplate(
  db: TestDb["db"],
  w: { org: { id: string }; account: { id: string } },
  o: {
    name?: string;
    category?: "UTILITY" | "MARKETING" | "AUTHENTICATION";
    status?: "PENDING_ATTESTATION" | "APPROVED" | "DISABLED";
    params?: number;
    language?: string;
  } = {},
) {
  const status = o.status ?? "APPROVED";
  const [row] = await db
    .insert(schema.whatsappTemplates)
    .values({
      organizationId: w.org.id,
      whatsappAccountId: w.account.id,
      name: o.name ?? `tpl_${uniq().replace(/[^a-z0-9]/g, "")}`,
      languageCode: o.language ?? "en_US",
      category: o.category ?? "UTILITY",
      status,
      bodyParameterCount: o.params ?? 0,
      attestedAt: status === "APPROVED" ? new Date() : null,
    })
    .returning();
  return row!;
}

export const textInput = (
  conversationId: string,
  body = "Hello",
  key = `key-${uniq()}-abcdef`,
) => ({
  idempotencyKey: key,
  conversationId,
  message: { type: "text" as const, body },
});
