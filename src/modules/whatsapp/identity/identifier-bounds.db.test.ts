import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { process as processMessages } from "../inbound/testing";
import { TEST_APP_SECRET, postSigned } from "../worker/testing";
import { PN, WABA, ingestBytes, tenant } from "./testing";

// Provider identifiers at and beyond their bounds, through the whole path: signed webhook -> normalization -> persisted
// event -> queue worker -> MESSAGE handler. An identifier is accepted byte for byte or the event dies permanently; it is
// never cut to fit. Bounds: reply and reaction targets 512 (the wamid bound), media id 255.

const NUL = String.fromCharCode(0);
const LONE = String.fromCharCode(0xd800);
const GRIN = String.fromCodePoint(0x1f600);
const id = (n: number, ch = "p") => ch.repeat(n);

function delivery(wamid: string, bsuid: string, extra: Record<string, unknown>): Buffer {
  const message: Record<string, unknown> = {
    id: wamid,
    from: "15550100001",
    from_user_id: bsuid,
    timestamp: String(Math.floor(Date.now() / 1000) - 60),
    type: "text",
    text: { body: "hello" },
    ...extra,
  };
  return Buffer.from(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550100001", phone_number_id: PN },
                contacts: [{ wa_id: "15550100001", user_id: bsuid, profile: { name: "S" } }],
                messages: [message],
              },
            },
          ],
        },
      ],
    }),
  );
}

describe("identifier bounds: exact or rejected, never cut", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.stubEnv("META_APP_SECRET", TEST_APP_SECRET);
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations cascade",
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const rows = async (q: string, p: unknown[] = []) => (await t.pool.query(q, p)).rows;
  const counts = async () => ({
    contacts: (await rows("select count(*)::int n from contacts"))[0].n,
    conversations: (await rows("select count(*)::int n from conversations"))[0].n,
    messages: (await rows("select count(*)::int n from messages"))[0].n,
    attachments: (await rows("select count(*)::int n from message_attachments"))[0].n,
    aliases: (await rows("select count(*)::int n from contact_bsuids"))[0].n,
  });
  const ev = async (wamid: string) =>
    (await rows("select * from webhook_events where provider_object_id = $1", [wamid]))[0];

  /** Delivers the bytes through the real ingest path and runs the worker once. */
  async function run(bytes: Buffer) {
    await ingestBytes(t.db, bytes);
    return processMessages(t.db);
  }
  /** The event must be dead, tenant-routed, untouched in the raw store, and must have created nothing. */
  async function expectRejected(
    wamid: string,
    bytes: Buffer,
    before: Awaited<ReturnType<typeof counts>>,
  ) {
    const e = await ev(wamid);
    expect(e).toMatchObject({
      status: "DEAD",
      last_error: "invalid_provider_identifier",
      attempts: 1,
    });
    expect(e.organization_id).not.toBeNull(); // kept with its trusted tenant and account
    expect(e.whatsapp_account_id).not.toBeNull();
    expect(await counts()).toEqual(before);
    const [req] = await rows(
      "select raw_body from webhook_requests order by received_at desc limit 1",
    );
    expect(Buffer.compare(req.raw_body, bytes)).toBe(0); // the signed bytes are exactly what arrived
  }

  // ----------------------------------------------------------------------------------------- reply target
  describe("reply target (bound 512)", () => {
    it.each([511, 512])("length %i is accepted and stored unchanged", async (n) => {
      await tenant(t.db);
      const target = id(n);
      const bytes = delivery(`wamid.R${n}`, "LK.R", { context: { id: target } });
      expect(await run(bytes)).toMatchObject({ processed: 1, dead: 0 });
      const [m] = await rows("select reply_to_wamid from messages where wamid = $1", [
        `wamid.R${n}`,
      ]);
      expect(m.reply_to_wamid).toBe(target);
      expect(m.reply_to_wamid).toHaveLength(n);
    });

    it("length 513 is permanently rejected and nothing is created", async () => {
      await tenant(t.db);
      const before = await counts();
      const bytes = delivery("wamid.R513", "LK.R", { context: { id: id(513) } });
      expect(await run(bytes)).toMatchObject({ claimed: 1, dead: 1, processed: 0 });
      await expectRejected("wamid.R513", bytes, before);
    });

    it("an oversized reply never links to the parent whose id is its first 512 characters", async () => {
      await tenant(t.db);
      const parentId = id(512, "q");
      // the parent: another customer's message in its own conversation, with a 512-character wamid
      expect(await run(delivery(parentId, "LK.PARENT", { from: "15550100002" }))).toMatchObject({
        processed: 1,
      });
      const before = await counts();
      const bytes = delivery("wamid.ORPHANREPLY", "LK.CHILD", { context: { id: parentId + "X" } });
      expect(await run(bytes)).toMatchObject({ dead: 1, processed: 0 });
      await expectRejected("wamid.ORPHANREPLY", bytes, before);
      expect(
        await rows(
          "select 1 from messages where reply_to_message_id is not null or reply_to_wamid is not null",
        ),
      ).toHaveLength(0);
    });

    it("an exact 512-character reply to a message in ANOTHER conversation is stored by wamid but never linked across conversations", async () => {
      await tenant(t.db);
      const parentId = id(512, "q");
      await run(delivery(parentId, "LK.PARENT", { from: "15550100002" }));
      expect(
        await run(delivery("wamid.CROSS", "LK.CHILD", { context: { id: parentId } })),
      ).toMatchObject({ processed: 1 });
      const [m] = await rows(
        "select reply_to_wamid, reply_to_message_id from messages where wamid = 'wamid.CROSS'",
      );
      expect(m.reply_to_wamid).toBe(parentId);
      expect(m.reply_to_message_id).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------- reaction target
  describe("reaction target (bound 512)", () => {
    const reaction = (target: string) => ({
      type: "reaction",
      text: undefined,
      reaction: { message_id: target, emoji: GRIN },
    });

    it.each([511, 512])("length %i is accepted and stored unchanged", async (n) => {
      await tenant(t.db);
      expect(await run(delivery(`wamid.X${n}`, "LK.X", reaction(id(n))))).toMatchObject({
        processed: 1,
        dead: 0,
      });
      const [m] = await rows("select content from messages where wamid = $1", [`wamid.X${n}`]);
      expect(m.content.target_wamid).toBe(id(n));
    });

    it("length 513 is permanently rejected and nothing is created", async () => {
      await tenant(t.db);
      const before = await counts();
      const bytes = delivery("wamid.X513", "LK.X", reaction(id(513)));
      expect(await run(bytes)).toMatchObject({ dead: 1, processed: 0 });
      await expectRejected("wamid.X513", bytes, before);
    });
  });

  // ------------------------------------------------------------------------------------------ media id
  describe("media id (bound 255)", () => {
    const image = (mediaId: string) => ({
      type: "image",
      text: undefined,
      image: { id: mediaId, mime_type: "image/jpeg", caption: "slip" },
    });

    it.each([254, 255])("length %i is accepted; the attachment keeps the exact id", async (n) => {
      await tenant(t.db);
      expect(await run(delivery(`wamid.M${n}`, "LK.M", image(id(n, "9"))))).toMatchObject({
        processed: 1,
        dead: 0,
      });
      const [a] = await rows("select meta_media_id from message_attachments");
      expect(a.meta_media_id).toBe(id(n, "9"));
    });

    it("length 256 is permanently rejected: no message, no attachment", async () => {
      await tenant(t.db);
      const before = await counts();
      const bytes = delivery("wamid.M256", "LK.M", image(id(256, "9")));
      expect(await run(bytes)).toMatchObject({ dead: 1, processed: 0 });
      await expectRejected("wamid.M256", bytes, before);
      expect(before.attachments).toBe(0);
    });
  });

  // ----------------------------------------------------------------------- the other protections remain
  describe("existing protections", () => {
    it.each([
      ["a NUL inside a reply target", (v: string) => ({ context: { id: v + NUL } })],
      ["a lone surrogate inside a reply target", (v: string) => ({ context: { id: v + LONE } })],
      [
        "a NUL that would make a 513-character id fit after cleaning",
        () => ({ context: { id: id(512) + NUL } }),
      ],
    ])("%s is rejected, not cleaned", async (_n, make) => {
      await tenant(t.db);
      const before = await counts();
      const bytes = delivery("wamid.PROT", "LK.P", make("wamid.parent"));
      expect(await run(bytes)).toMatchObject({ dead: 1, processed: 0 });
      await expectRejected("wamid.PROT", bytes, before);
    });

    it("valid Unicode identifiers are preserved exactly, including at the bound", async () => {
      await tenant(t.db);
      const parent = GRIN.repeat(256); // 512 UTF-16 code units
      expect(await run(delivery("wamid.UNI", "LK.U", { context: { id: parent } }))).toMatchObject({
        processed: 1,
        dead: 0,
      });
      expect(
        (await rows("select reply_to_wamid from messages where wamid = 'wamid.UNI'"))[0]
          .reply_to_wamid,
      ).toBe(parent);
      const before = await counts();
      const tooLong = GRIN.repeat(256) + "x";
      const bytes = delivery("wamid.UNI2", "LK.U", { context: { id: tooLong } });
      expect(await run(bytes)).toMatchObject({ dead: 1 });
      await expectRejected("wamid.UNI2", bytes, before);
    });

    it("ordinary text is still cut to its limit and cleaned, never rejected", async () => {
      await tenant(t.db);
      expect(
        await run(delivery("wamid.TXT", "LK.T", { text: { body: "x".repeat(4100) + NUL } })),
      ).toMatchObject({ processed: 1, dead: 0 });
      expect(
        (await rows("select body from messages where wamid = 'wamid.TXT'"))[0].body,
      ).toHaveLength(4096);
    });
  });

  // -------------------------------------------------------------------- the full signed-webhook regression
  it("signed webhook -> persisted event -> worker -> permanent rejection (the real HTTP handler, a real signature)", async () => {
    await tenant(t.db);
    const before = await counts();
    const bytes = delivery("wamid.SIGNED", "LK.S", { context: { id: id(513) } });
    const res = await postSigned(t.db, bytes);
    expect(res.status).toBe(200); // acknowledged and durably stored exactly as before
    const [stored] = await rows(
      "select status, event_type, organization_id from webhook_events where provider_object_id = 'wamid.SIGNED'",
    );
    expect(stored).toMatchObject({ status: "PENDING", event_type: "MESSAGE" });
    expect(stored.organization_id).not.toBeNull();
    expect(await processMessages(t.db)).toMatchObject({ claimed: 1, dead: 1, processed: 0 });
    await expectRejected("wamid.SIGNED", bytes, before);
  });
});
