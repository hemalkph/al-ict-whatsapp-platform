import { describe, expect, it } from "vitest";
import { normalizeEnvelope, pairContact, type NormalizedEvent } from "./normalize";
import { parseDelivery } from "./parse";
import { fixture } from "./testing";

const events = (name: string): NormalizedEvent[] => {
  const parsed = parseDelivery(fixture(name));
  if (!parsed.ok) throw new Error(`${name} did not parse`);
  return normalizeEnvelope(parsed.envelope);
};
const only = (name: string): NormalizedEvent => {
  const all = events(name);
  expect(all, name).toHaveLength(1);
  return all[0]!;
};
const PN = "100000000000001";
const WABA = "200000000000001";
const msg = (payload: Record<string, unknown>) => payload.message as Record<string, unknown>;
const contactOf = (event: NormalizedEvent) =>
  event.payload.contact as Record<string, unknown> | null;

describe("normalizeEnvelope: one delivery, many events", () => {
  it("turns a text message into one MESSAGE event keyed by phone_number_id and the opaque wamid", () => {
    const e = only("text-phone.json");
    expect(e).toMatchObject({
      eventType: "MESSAGE",
      wabaId: WABA,
      phoneNumberId: PN,
      providerObjectId: "wamid.FAKE00000000000000000001",
      idempotencyKey: `wa:msg:v1:${PN}:wamid.FAKE00000000000000000001`,
      intrinsic: { kind: "queue" },
      pairing: "wa_id",
    });
    expect(e.payload).toMatchObject({ v: 1, wabaId: WABA, field: "messages" });
    expect(msg(e.payload).text).toEqual({ body: "Does the ICT class start in January?" });
  });

  it("builds a STATUS event whose key carries the status and the provider timestamp", () => {
    const e = only("status-delivered-phone-bsuid.json");
    expect(e).toMatchObject({
      eventType: "STATUS",
      providerObjectId: "wamid.FAKE00000000000000000200",
      idempotencyKey: `wa:status:v1:${PN}:wamid.FAKE00000000000000000200:delivered:1790000000`,
      intrinsic: { kind: "queue" },
    });
  });

  it("queues sent, delivered, read and failed statuses and ignores `played` (not mirrored)", () => {
    for (const name of ["status-sent.json", "status-read.json", "status-failed.json"]) {
      expect(only(name).intrinsic, name).toEqual({ kind: "queue" });
    }
    expect(only("status-played.json").intrinsic).toEqual({
      kind: "ignored",
      reason: "status_not_mirrored",
    });
  });

  it("keeps statuses with different values (or timestamps) distinct but collapses an exact redelivery", () => {
    const sent = only("status-sent.json");
    const read = only("status-read.json");
    expect(sent.idempotencyKey).not.toBe(read.idempotencyKey);
    expect(only("status-sent.json").idempotencyKey).toBe(sent.idempotencyKey);
  });

  it("expands one HTTP delivery into one event per message and per status, across entries and changes", () => {
    const all = events("multi-event-request.json");
    expect(all.map((e) => [e.eventType, e.phoneNumberId, e.wabaId])).toEqual([
      ["MESSAGE", PN, WABA],
      ["STATUS", PN, WABA],
      ["MESSAGE", "100000000000002", "200000000000002"],
    ]);
    expect(new Set(all.map((e) => e.idempotencyKey)).size).toBe(3);
  });

  it("never lets the identical element on two phone_number_ids collide", () => {
    const [a, b] = events("same-message-two-numbers.json");
    expect(a!.providerObjectId).toBe(b!.providerObjectId);
    expect(a!.idempotencyKey).not.toBe(b!.idempotencyKey);
    expect(a!.idempotencyKey).toContain(`:${PN}:`);
    expect(b!.idempotencyKey).toContain(":100000000000002:");
  });

  it("emits media, interactive, reaction, location, contacts and unknown-type messages as ordinary queued MESSAGE events", () => {
    for (const name of [
      "image.json",
      "video.json",
      "audio-voice.json",
      "document.json",
      "sticker.json",
      "location.json",
      "contacts-shared.json",
      "interactive-button-reply.json",
      "interactive-list-reply.json",
      "button-quick-reply.json",
      "reaction.json",
      "reaction-removed.json",
      "reply-context-product.json",
      "text-reply-context.json",
      "referral-ctwa-text.json",
      "unsupported-edit.json",
      "unknown-type.json",
    ]) {
      const e = only(name);
      expect(e.eventType, name).toBe("MESSAGE");
      expect(e.intrinsic, name).toEqual({ kind: "queue" });
    }
  });

  it("preserves the original element (referral, context, media) inside the event payload for the later worker", () => {
    const referral = msg(only("referral-ctwa-text.json").payload).referral as Record<
      string,
      unknown
    >;
    expect(referral.source_type).toBe("ad");
    expect(referral.ctwa_clid).toMatch(/^FAKE-ctwa-clid/);
    expect(msg(only("reply-context-product.json").payload).context).toMatchObject({
      from: "15550100001",
    });
    expect(msg(only("image.json").payload).image).toMatchObject({ id: "900000000000001" });
  });

  it("does NOT interpret system messages (G0 item H1 is unresolved): preserved untouched as an IGNORED OTHER event", () => {
    for (const name of [
      "system-user-changed-user-id.json",
      "system-user-changed-number-legacy.json",
    ]) {
      const e = only(name);
      expect(e.eventType).toBe("OTHER");
      expect(e.intrinsic).toEqual({ kind: "ignored", reason: "system_message_pending_h1" });
      expect(e.idempotencyKey).toMatch(/^wa:other:v1:100000000000001:[0-9a-f]{64}$/);
      expect((e.payload.element as Record<string, unknown>).type).toBe("system"); // the raw item is kept for replay
    }
  });

  it("never emits IDENTITY events while H1 is unresolved (user_id_update is just an unsupported field)", () => {
    const all = [
      ...events("user-id-update.json"),
      ...events("system-user-changed-user-id.json"),
      ...events("system-user-changed-number-legacy.json"),
    ];
    expect(all.some((e) => (e.eventType as string) === "IDENTITY")).toBe(false);
    expect(only("user-id-update.json").intrinsic).toEqual({
      kind: "ignored",
      reason: "unsupported_field",
    });
  });

  it("turns a change on another field into an IGNORED OTHER event keyed by the canonical form of the change", () => {
    const e = only("unsupported-field-change.json");
    expect(e).toMatchObject({
      eventType: "OTHER",
      intrinsic: { kind: "ignored", reason: "unsupported_field" },
    });
    expect(e.idempotencyKey).toMatch(/^wa:other:v1:waba:200000000000001:[0-9a-f]{64}$/); // no phone_number_id: WABA scope
  });

  it("derives the OTHER key from meaning, not from key order or whitespace", () => {
    const base = { field: "account_alerts", value: { b: 1, a: [1, 2], c: { y: 1, x: 2 } } };
    const reordered = { value: { c: { x: 2, y: 1 }, a: [1, 2], b: 1 }, field: "account_alerts" };
    const wrap = (change: unknown) => ({
      object: "whatsapp_business_account",
      entry: [{ id: "9", changes: [change] }],
    });
    const a = normalizeEnvelope(wrap(base) as never)[0]!;
    const b = normalizeEnvelope(wrap(reordered) as never)[0]!;
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    const other = normalizeEnvelope(wrap({ ...base, value: { b: 2 } }) as never)[0]!;
    expect(other.idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it("produces the same events whether non-ASCII text is literal UTF-8 or \\uXXXX-escaped (idempotency is by meaning)", () => {
    const literal = events("text-sinhala-raw-utf8.json");
    const escaped = events("text-sinhala-escaped.json");
    expect(literal.map((e) => e.idempotencyKey)).toEqual(escaped.map((e) => e.idempotencyKey));
    expect(literal.map((e) => e.payload)).toEqual(escaped.map((e) => e.payload));
  });

  it("strips U+0000 from the stored copy", () => {
    const e = only("text-with-nul-escape.json");
    expect(JSON.stringify(e.payload)).not.toContain("\\u0000");
    expect((msg(e.payload).text as { body: string }).body).toBe("beforeafter");
  });

  it("yields no events for an empty delivery and skips non-object changes", () => {
    expect(events("empty-entry.json")).toEqual([]);
    const env = {
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [1, null, "x", []] }],
    };
    expect(normalizeEnvelope(env as never)).toEqual([]);
  });

  it("marks elements too malformed to key as DEAD instead of dropping or crashing", () => {
    const wrap = (value: unknown) => ({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "messages",
              value: { metadata: { phone_number_id: PN }, ...(value as object) },
            },
          ],
        },
      ],
    });
    const cases: Array<[string, unknown]> = [
      ["a message without an id", { messages: [{ from: "1", type: "text" }] }],
      ["a message with an empty id", { messages: [{ id: "", type: "text" }] }],
      ["a message with a control character in the id", { messages: [{ id: "w\nx" }] }],
      ["a message with an over-long id", { messages: [{ id: "w".repeat(513) }] }],
      ["a non-object message", { messages: ["text", 1, null] }],
      ["a status without a timestamp", { statuses: [{ id: "w", status: "sent" }] }],
      ["a status without an id", { statuses: [{ status: "sent", timestamp: "1" }] }],
    ];
    for (const [name, value] of cases) {
      const all = normalizeEnvelope(wrap(value) as never);
      expect(all.length, name).toBeGreaterThan(0);
      for (const e of all) {
        expect(e.intrinsic, name).toEqual({ kind: "dead", reason: "malformed_event" });
        expect(e.idempotencyKey, name).toMatch(/^wa:malformed:v1:/);
      }
    }
  });

  it("ignores group messages and unknown value shapes without losing them", () => {
    const wrap = (value: unknown) => ({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "messages",
              value: { metadata: { phone_number_id: PN }, ...(value as object) },
            },
          ],
        },
      ],
    });
    const group = normalizeEnvelope(
      wrap({ messages: [{ id: "w1", group_id: "g", type: "text" }] }) as never,
    )[0]!;
    expect(group).toMatchObject({
      eventType: "MESSAGE",
      intrinsic: { kind: "ignored", reason: "group_unsupported" },
    });
    const errors = normalizeEnvelope(wrap({ errors: [{ code: 1 }] }) as never)[0]!;
    expect(errors).toMatchObject({
      eventType: "OTHER",
      intrinsic: { kind: "ignored", reason: "unsupported_value" },
    });
  });

  it("accepts a numeric status timestamp but treats it as the same key text", () => {
    const wrap = (ts: unknown) => ({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: PN },
                statuses: [{ id: "w", status: "sent", timestamp: ts }],
              },
            },
          ],
        },
      ],
    });
    expect(normalizeEnvelope(wrap(1790000000) as never)[0]!.idempotencyKey).toBe(
      normalizeEnvelope(wrap("1790000000") as never)[0]!.idempotencyKey,
    );
  });

  it("rejects an unusable phone_number_id as absent (so it cannot inject key separators or control characters)", () => {
    const e = normalizeEnvelope({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "messages",
              value: { metadata: { phone_number_id: "a\nb" }, messages: [{ id: "w" }] },
            },
          ],
        },
      ],
    } as never)[0]!;
    expect(e.phoneNumberId).toBeNull();
    expect(e.idempotencyKey).toBe(`wa:msg:v1:waba:${WABA}:w`);
  });

  it("does not parse or interpret the wamid", () => {
    const wamid = "anything: goes / here ප";
    const e = normalizeEnvelope({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "messages",
              value: { metadata: { phone_number_id: PN }, messages: [{ id: wamid }] },
            },
          ],
        },
      ],
    } as never)[0]!;
    expect(e.providerObjectId).toBe(wamid);
    expect(e.idempotencyKey).toBe(`wa:msg:v1:${PN}:${wamid}`);
  });
});

describe("contact pairing (never contacts[0], never array position)", () => {
  it("pairs a BSUID-only sender through from_user_id <-> user_id", () => {
    const e = only("text-bsuid-only-username.json");
    expect(e.pairing).toBe("user_id");
    expect(contactOf(e)).toMatchObject({ user_id: "LK.100000000000000001" });
  });

  it("pairs a phone-only sender through from <-> wa_id", () => {
    expect(only("text-phone.json").pairing).toBe("wa_id");
  });

  it("pairs a phone + BSUID sender through the BSUID first", () => {
    expect(only("text-phone-and-bsuid.json").pairing).toBe("user_id");
  });

  it("gives each message in a synthetic multi-sender delivery ITS OWN contact element, not contacts[0]", () => {
    const all = events("multi-sender-pairing.json");
    expect(all).toHaveLength(3);
    const names = all.map(
      (e) => (contactOf(e)?.profile as { name?: string } | undefined)?.name ?? null,
    );
    // contacts[] is [Second Sender, First Sender]; messages are [first, second, third]
    expect(names).toEqual(["First Sender", "Second Sender", null]);
    expect(all.map((e) => e.pairing)).toEqual(["user_id", "user_id", "none"]);
    expect(all.map((e) => msg(e.payload).id)).toEqual([
      "wamid.FAKE00000000000000000050",
      "wamid.FAKE00000000000000000051",
      "wamid.FAKE00000000000000000052",
    ]);
  });

  it("still emits the message when nothing matches, just without enrichment", () => {
    const e = events("multi-sender-pairing.json")[2]!;
    expect(e.eventType).toBe("MESSAGE");
    expect(e.intrinsic).toEqual({ kind: "queue" });
    expect(e.payload.contact).toBeNull();
  });

  it("drops a matched contact whose wa_id contradicts the message's own `from`, keeping the message", () => {
    const result = pairContact({ from: "111", from_user_id: "U1" }, [
      { user_id: "U1", wa_id: "999" },
    ]);
    expect(result).toEqual({ contact: null, pairing: "conflict" });
  });

  it("drops a contact found by wa_id whose user_id contradicts the message's from_user_id", () => {
    expect(
      pairContact({ from: "111", from_user_id: "U1" }, [{ user_id: "U2", wa_id: "111" }]),
    ).toEqual({ contact: null, pairing: "conflict" });
  });

  it("falls back to wa_id when from_user_id matches no contact, and tolerates absent or malformed contacts", () => {
    expect(pairContact({ from: "111", from_user_id: "UX" }, [{ wa_id: "111" }])).toMatchObject({
      pairing: "wa_id",
    });
    for (const contacts of [undefined, null, "x", 1, {}, [], [null, 1, "x"]]) {
      expect(pairContact({ from: "111" }, contacts)).toEqual({ contact: null, pairing: "none" });
    }
  });

  it("a conflicting contact does not fail normalization of the request", () => {
    const env = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: PN },
                contacts: [{ user_id: "U1", wa_id: "999" }],
                messages: [{ id: "w1", from: "111", from_user_id: "U1", type: "text" }],
              },
            },
          ],
        },
      ],
    };
    const [e] = normalizeEnvelope(env as never);
    expect(e).toMatchObject({
      eventType: "MESSAGE",
      pairing: "conflict",
      intrinsic: { kind: "queue" },
    });
    expect(e!.payload.contact).toBeNull();
  });
});
