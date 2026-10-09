import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { process as processMessages, eventStatus } from "../inbound/testing";
import { insertEvent } from "../queue/testing";
import { PN, WABA, ingestBytes, tenant } from "./testing";

// Provider identifiers are validated BEFORE the lossy cleaning applied to stored payloads. The complete path is exercised:
// raw signed bytes -> ingest normalization -> routing -> queue worker -> MESSAGE handler -> identity resolution.
// The characters are built from code points so no invisible character sits in this source file.

const NUL = String.fromCharCode(0);
const LONE = String.fromCharCode(0xd800); // an unpaired high surrogate
const GRIN = String.fromCodePoint(0x1f600);
const REPLACEMENT = String.fromCharCode(0xfffd);

type Msg = {
  wamid: string;
  bsuid?: string | null;
  from?: string | null;
  name?: string;
  contact?: Record<string, unknown> | null;
  extra?: Record<string, unknown>;
  pn?: string;
  waba?: string;
};

function delivery(m: Msg): Buffer {
  const message: Record<string, unknown> = {
    id: m.wamid,
    timestamp: String(Math.floor(Date.now() / 1000) - 60),
    type: "text",
    text: { body: `hi ${m.wamid}` },
  };
  if (m.from) message.from = m.from;
  if (m.bsuid) message.from_user_id = m.bsuid;
  Object.assign(message, m.extra ?? {});
  const contact =
    m.contact === undefined
      ? {
          ...(m.from ? { wa_id: m.from } : {}),
          ...(m.bsuid ? { user_id: m.bsuid } : {}),
          profile: { name: m.name ?? "Student" },
        }
      : m.contact;
  return Buffer.from(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: m.waba ?? WABA,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550100001", phone_number_id: m.pn ?? PN },
                contacts: contact ? [contact] : [],
                messages: [message],
              },
            },
          ],
        },
      ],
    }),
  );
}

describe("identifier integrity: sanitization can never turn one identity into another", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations cascade",
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const rows = async (q: string, p: unknown[] = []) => (await t.pool.query(q, p)).rows;
  const ev = async (wamid: string) =>
    (await rows("select * from webhook_events where provider_object_id = $1", [wamid]))[0];

  /** Three existing contacts, each with a BSUID and a phone number. Returns a snapshot function of everything identity-related. */
  async function world() {
    await tenant(t.db);
    const people = [
      { wamid: "wamid.E1", bsuid: "LK.AB", from: "15550100001" },
      { wamid: "wamid.E2", bsuid: "LK.CD", from: "15550100002" },
      { wamid: "wamid.E3", bsuid: "LK.EF", from: "15550100003" },
    ];
    for (const p of people) await ingestBytes(t.db, delivery(p));
    expect(await processMessages(t.db)).toMatchObject({ processed: 3 });
    const snapshot = async () => ({
      contacts: await rows(
        "select id, wa_id, last_seen_at, updated_at, username, display_name from contacts order by id",
      ).catch(() => rows("select * from contacts order by id")),
      aliases: await rows("select * from contact_bsuids order by id"),
      conversations: await rows("select * from conversations order by id"),
      messages: (await rows("select count(*)::int n from messages"))[0].n,
    });
    return { snapshot };
  }

  async function expectRejected(
    bytes: Buffer,
    wamid: string,
    snapshot: () => Promise<unknown>,
    reason = "invalid_provider_identifier",
  ) {
    const before = await snapshot();
    const [stored] = await ingestBytes(t.db, bytes);
    expect(stored!.eventType).toBe("MESSAGE");
    expect(await ev(wamid)).toMatchObject({
      status: "PENDING",
      payload: expect.objectContaining({ identifierIntegrity: "altered" }),
    });
    expect(await processMessages(t.db)).toMatchObject({ claimed: 1, dead: 1, processed: 0 });
    expect(await eventStatus(t.db, stored!.id)).toMatchObject({
      status: "DEAD",
      lastError: reason,
      attempts: 1,
    });
    expect(await snapshot()).toEqual(before); // nothing was created, attached, touched or counted
  }

  // ---------------------------------------------------------------------------------------------- BSUID
  it("control: the exact BSUID resolves to its own contact", async () => {
    await world();
    await ingestBytes(t.db, delivery({ wamid: "wamid.OK", bsuid: "LK.AB", from: "15550100001" }));
    expect(await processMessages(t.db)).toMatchObject({ processed: 1 });
    const own = await rows(
      "select c.id, (select count(*)::int from messages m join conversations v on v.id = m.conversation_id where v.contact_id = c.id) n from contacts c join contact_bsuids b on b.contact_id = c.id where b.bsuid = 'LK.AB'",
    );
    expect(own).toHaveLength(1);
    expect(own[0].n).toBe(2);
  });

  it("a BSUID with an inserted NUL is rejected, not resolved to the existing contact whose BSUID is the cleaned text", async () => {
    const { snapshot } = await world();
    // sanitizing "LK.A<NUL>B" would give "LK.AB": a DIFFERENT, existing contact's identity
    await expectRejected(
      delivery({ wamid: "wamid.NUL1", bsuid: `LK.A${NUL}B`, from: "15550100009" }),
      "wamid.NUL1",
      snapshot,
    );
    expect((await ev("wamid.NUL1")).payload.message.from_user_id).toBe("LK.AB"); // the stored copy is cleaned: exactly why it must not be used
    expect(await rows("select 1 from contact_bsuids where bsuid = 'LK.AB'")).toHaveLength(1);
  });

  it("a BSUID with a lone surrogate is rejected and no replacement-character identity is created", async () => {
    const { snapshot } = await world();
    await expectRejected(
      delivery({ wamid: "wamid.LONE1", bsuid: `LK.A${LONE}B`, from: "15550100009" }),
      "wamid.LONE1",
      snapshot,
    );
    expect(
      await rows("select 1 from contact_bsuids where bsuid like $1", [`%${REPLACEMENT}%`]),
    ).toHaveLength(0);
    expect(
      await rows("select 1 from contacts where wa_id like $1", [`%${REPLACEMENT}%`]),
    ).toHaveLength(0);
  });

  // ------------------------------------------------------------------------------------------- phone id
  it("a phone-based id with an inserted NUL is rejected instead of attaching to the contact that owns the cleaned number", async () => {
    const { snapshot } = await world();
    await expectRejected(
      delivery({ wamid: "wamid.NUL2", from: `1555010${NUL}0001`, bsuid: null }),
      "wamid.NUL2",
      snapshot,
    );
  });

  it("a malformed phone id next to a valid BSUID rejects the whole message (no half-trusted identity)", async () => {
    const { snapshot } = await world();
    await expectRejected(
      delivery({ wamid: "wamid.NUL3", bsuid: "LK.CD", from: `1555010${NUL}0002` }),
      "wamid.NUL3",
      snapshot,
    );
  });

  it("identifiers repeated on the paired contact element are covered too", async () => {
    const { snapshot } = await world();
    const bad = `1555010${NUL}0003`;
    await expectRejected(
      delivery({
        wamid: "wamid.NUL4",
        from: bad,
        bsuid: null,
        contact: { wa_id: bad, profile: { name: "X" } },
      }),
      "wamid.NUL4",
      snapshot,
    );
  });

  it("a valid message whose contacts[] element carries a damaged identifier is processed without that element (no enrichment, no rejection)", async () => {
    await world();
    await ingestBytes(
      t.db,
      delivery({
        wamid: "wamid.PAIR",
        bsuid: "LK.NEW1",
        from: "15550100004",
        contact: {
          wa_id: `1555010${NUL}0004`,
          user_id: "LK.NEW1",
          profile: { name: "Dropped Name" },
        },
      }),
    );
    expect(await processMessages(t.db)).toMatchObject({ processed: 1, dead: 0 });
    const c = (
      await rows(
        "select * from contacts c join contact_bsuids b on b.contact_id = c.id where b.bsuid = 'LK.NEW1'",
      )
    )[0];
    expect(c.wa_id).toBe("15550100004");
    expect(JSON.stringify(c)).not.toContain("Dropped Name");
  });

  // -------------------------------------------------------------------------------- other key identifiers
  it.each([
    ["reply target", (v: string) => ({ context: { id: v } })],
    [
      "reaction target",
      (v: string) => ({
        type: "reaction",
        text: undefined,
        reaction: { message_id: v, emoji: GRIN },
      }),
    ],
    [
      "media id",
      (v: string) => ({
        type: "image",
        text: undefined,
        image: { id: v, mime_type: "image/jpeg" },
      }),
    ],
  ])(
    "a %s with a NUL is rejected rather than pointing at a different message or media",
    async (_n, make) => {
      const { snapshot } = await world();
      const wamid = `wamid.K${_n.length}`;
      await expectRejected(
        delivery({ wamid, bsuid: "LK.EF", from: "15550100003", extra: make(`wamid.E${NUL}1`) }),
        wamid,
        snapshot,
      );
      expect(await rows("select 1 from message_attachments")).toHaveLength(0);
    },
  );

  // ----------------------------------------------------------------------------- what must keep working
  it("valid identifiers are preserved exactly, including astral Unicode, and display text is still cleaned (not rejected)", async () => {
    await world();
    const bsuid = `LK.${GRIN}X9`;
    await ingestBytes(
      t.db,
      delivery({
        wamid: "wamid.UNI",
        bsuid,
        from: "15550100005",
        name: `Ama${NUL}ra සිංහල ${GRIN}`,
      }),
    );
    expect(await processMessages(t.db)).toMatchObject({ processed: 1, dead: 0 });
    expect(await rows("select 1 from contact_bsuids where bsuid = $1", [bsuid])).toHaveLength(1);
    const [c] = await rows(
      "select c.* from contacts c join contact_bsuids b on b.contact_id = c.id where b.bsuid = $1",
      [bsuid],
    );
    expect(JSON.stringify(c)).toContain("Amara");
    expect(JSON.stringify(c)).not.toContain("\\u0000");
  });

  it("message CONTENT is still cleaned: a NUL in the text does not reject the message", async () => {
    await world();
    await ingestBytes(
      t.db,
      delivery({
        wamid: "wamid.TXT",
        bsuid: "LK.AB",
        from: "15550100001",
        extra: { text: { body: `hello${NUL} wor${LONE}ld` } },
      }),
    );
    expect(await processMessages(t.db)).toMatchObject({ processed: 1, dead: 0 });
    expect((await rows("select body from messages where wamid = 'wamid.TXT'"))[0].body).toBe(
      `hello wor${REPLACEMENT}ld`,
    );
  });

  // ---------------------------------------------------------------------------- duplicates and concurrency
  it("a malformed delivery repeated, and processed by two workers at once, is one DEAD event and changes nothing", async () => {
    const { snapshot } = await world();
    const before = await snapshot();
    const bytes = delivery({ wamid: "wamid.DUP", bsuid: `LK.A${NUL}B`, from: "15550100009" });
    await ingestBytes(t.db, bytes);
    await ingestBytes(t.db, bytes);
    const e = await ev("wamid.DUP");
    expect(
      await rows("select 1 from webhook_events where provider_object_id = 'wamid.DUP'"),
    ).toHaveLength(1);
    // a copy that bypasses the ingest idempotency key, so both workers have something to claim
    await insertEvent(t.db, {
      organizationId: e.organization_id,
      whatsappAccountId: e.whatsapp_account_id,
      payload: e.payload,
      eventType: "MESSAGE",
    });
    const results = await Promise.all([processMessages(t.db), processMessages(t.db)]);
    expect(results.reduce((n, r) => n + r.dead, 0)).toBe(2);
    expect(results.reduce((n, r) => n + r.processed, 0)).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("different contacts' identities stay apart: damaged identifiers of three different contacts all fail, none cross over", async () => {
    const { snapshot } = await world();
    const before = await snapshot();
    const bad = [
      { wamid: "wamid.X1", bsuid: `LK.A${NUL}B`, from: "15550100001" },
      { wamid: "wamid.X2", bsuid: `LK.C${NUL}D`, from: "15550100002" },
      { wamid: "wamid.X3", bsuid: `LK.E${NUL}F`, from: "15550100003" },
    ];
    for (const b of bad) await ingestBytes(t.db, delivery(b));
    expect(await processMessages(t.db)).toMatchObject({ claimed: 3, dead: 3, processed: 0 });
    expect(await snapshot()).toEqual(before);
  });

  // ------------------------------------------------------------------------------- routing and status keys
  it("a damaged phone_number_id or WABA id is never cleaned into a real account's id", async () => {
    await tenant(t.db);
    const realPn = "100000000000001";
    const damagedPn = `1000000000${NUL}00001`;
    expect(damagedPn.replaceAll(NUL, "")).toBe(realPn);
    await ingestBytes(
      t.db,
      delivery({ wamid: "wamid.R1", bsuid: "LK.R1", from: "15550100007", pn: damagedPn }),
    );
    await ingestBytes(
      t.db,
      delivery({
        wamid: "wamid.R2",
        bsuid: "LK.R2",
        from: "15550100008",
        waba: `2000000000${NUL}00001`,
      }),
    );
    expect(await ev("wamid.R1")).toMatchObject({
      status: "UNROUTABLE",
      last_error: "missing_phone_number_id",
      organization_id: null,
    });
    expect(await ev("wamid.R2")).toMatchObject({ status: "UNROUTABLE", organization_id: null }); // no WABA to prove ownership
    expect(await processMessages(t.db)).toMatchObject({ claimed: 0 });
  });

  it("message and status ids with a NUL or a lone surrogate become DEAD malformed events, never a cleaned look-alike id", async () => {
    await tenant(t.db);
    await ingestBytes(
      t.db,
      delivery({ wamid: `wamid.A${NUL}B`, bsuid: "LK.S1", from: "15550100011" }),
    );
    await ingestBytes(
      t.db,
      delivery({ wamid: `wamid.C${LONE}D`, bsuid: "LK.S2", from: "15550100012" }),
    );
    const status = Buffer.from(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: WABA,
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: PN },
                  statuses: [{ id: `wamid.E${LONE}F`, status: "read", timestamp: "1790000000" }],
                },
              },
            ],
          },
        ],
      }),
    );
    await ingestBytes(t.db, status);
    const dead = await rows(
      "select event_type, last_error, status from webhook_events order by event_type",
    );
    expect(dead).toEqual([
      { event_type: "MESSAGE", last_error: "malformed_event", status: "DEAD" },
      { event_type: "MESSAGE", last_error: "malformed_event", status: "DEAD" },
      { event_type: "STATUS", last_error: "malformed_event", status: "DEAD" },
    ]);
    expect(
      await rows("select 1 from webhook_events where provider_object_id is not null"),
    ).toHaveLength(0);
  });

  it("the exact signed bytes are untouched: the raw body still contains the damaged identifier", async () => {
    await tenant(t.db);
    const bytes = delivery({ wamid: "wamid.RAW", bsuid: `LK.A${NUL}B`, from: "15550100009" });
    await ingestBytes(t.db, bytes);
    const [row] = await rows("select raw_body from webhook_requests");
    expect(Buffer.compare(row.raw_body, bytes)).toBe(0);
    expect(row.raw_body.toString("utf8")).toContain("LK.A\\u0000B");
  });
});
