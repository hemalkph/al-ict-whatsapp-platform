import { describe, expect, expectTypeOf, it } from "vitest";
import { REPLY_ID_PATTERN as BOT_REPLY_ID_PATTERN } from "@/modules/bots/reply-id";
import type { OutboundMessage } from "@/modules/bots/engine";
import { botFinalVerdict, type BotFinalClaim } from "./bot-authorization";
import {
  INTERACTIVE_LIMITS as L,
  REPLY_ID_PATTERN,
  botSendContent,
  parseInteractivePayload,
  providerInteractive,
  type BotOutboundMessage,
  type InteractivePayload,
} from "./interactive";
import { retryableRecordFailure } from "./dispatch";
import { buildPayload } from "./meta-transport";
import { SEND_START_BUDGET_MS, SERVICE_WINDOW_MS, SERVICE_WINDOW_SAFETY_MARGIN_MS } from "./policy";
import { ON } from "./testing";

// Interactive payloads and the BOT final-authorization decision (Phase 08D, ADR 0020). Pure: no database, no network.

const token = "AAAAAAAAAAAAAAAAAAAAAA"; // 22 base64url characters
const id = (key: string) => `b1.${token}.${key}`;
const si = "ඔබට උදව් අවශ්‍යද? 🙂";
const ta = "உங்களுக்கு உதவி வேண்டுமா?";

const buttons: BotOutboundMessage = {
  kind: "buttons",
  body: `${si} / ${ta} / Need help?`,
  footer: "A/L ICT 🎓",
  buttons: [
    { id: id("yes"), title: "ඔව් ✅" },
    { id: id("no"), title: "இல்லை" },
    { id: id("later"), title: "Later" },
  ],
};
const list: BotOutboundMessage = {
  kind: "list",
  body: "Choose a class",
  buttonLabel: "Classes",
  footer: "Sinhala / தமிழ் / English",
  rows: [
    { id: id("theory"), title: "Theory 📘", description: "Saturday 8 am" },
    { id: id("revision"), title: "Revision" },
  ],
};

describe("interactive payloads", () => {
  it("the reply-id grammar is the bot contract's, and the message shape is the engine's", () => {
    expect(REPLY_ID_PATTERN.source).toBe(BOT_REPLY_ID_PATTERN.source);
    expectTypeOf<OutboundMessage>().toEqualTypeOf<BotOutboundMessage>();
  });

  it("maps buttons and a flat list losslessly (one section titled with the button label), and parses back identically", () => {
    const b = botSendContent(buttons);
    expect(b).toEqual({
      type: "interactive",
      payload: {
        v: 1,
        kind: "buttons",
        body: buttons.kind === "buttons" ? buttons.body : "",
        footer: "A/L ICT 🎓",
        buttons: [
          { id: id("yes"), title: "ඔව් ✅" },
          { id: id("no"), title: "இல்லை" },
          { id: id("later"), title: "Later" },
        ],
      },
    });
    const l = botSendContent(list);
    expect(l).toEqual({
      type: "interactive",
      payload: {
        v: 1,
        kind: "list",
        body: "Choose a class",
        footer: "Sinhala / தமிழ் / English",
        buttonLabel: "Classes",
        sections: [
          {
            title: "Classes",
            rows: [
              { id: id("theory"), title: "Theory 📘", description: "Saturday 8 am" },
              { id: id("revision"), title: "Revision" },
            ],
          },
        ],
      },
    });
    // a stored copy (JSON round trip, as through jsonb) parses back to exactly the same value
    for (const c of [b, l])
      if (c?.type === "interactive")
        expect(parseInteractivePayload(JSON.parse(JSON.stringify(c.payload)))).toEqual(c.payload);
    expect(botSendContent({ kind: "text", text: "Hello" })).toEqual({
      type: "text",
      body: "Hello",
    });
  });

  it("builds exactly Meta's documented interactive JSON (optional fields omitted, never null)", () => {
    const recipient = { kind: "PHONE" as const, id: "94770000000" };
    const send = (payload: InteractivePayload) =>
      buildPayload(
        {
          phoneNumberId: "1",
          credentialRef: "X",
          recipient,
          message: { type: "interactive", payload },
        },
        false,
      );
    const b = botSendContent(buttons);
    const l = botSendContent(list);
    if (b?.type !== "interactive" || l?.type !== "interactive") throw new Error("fixture");
    expect(send(b.payload)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "94770000000",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: b.payload.body },
        footer: { text: "A/L ICT 🎓" },
        action: {
          buttons: [
            { type: "reply", reply: { id: id("yes"), title: "ඔව් ✅" } },
            { type: "reply", reply: { id: id("no"), title: "இல்லை" } },
            { type: "reply", reply: { id: id("later"), title: "Later" } },
          ],
        },
      },
    });
    expect(send(l.payload)).toMatchObject({
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Choose a class" },
        footer: { text: "Sinhala / தமிழ் / English" },
        action: {
          button: "Classes",
          sections: [
            {
              title: "Classes",
              rows: [
                { id: id("theory"), title: "Theory 📘", description: "Saturday 8 am" },
                { id: id("revision"), title: "Revision" },
              ],
            },
          ],
        },
      },
    });
    const noFooter = { ...b.payload };
    delete noFooter.footer;
    const json = providerInteractive(noFooter);
    expect(json).not.toHaveProperty("footer");
    expect(JSON.stringify(send(l.payload))).not.toContain("null");
    // a BSUID recipient stays gated for interactive messages too
    expect(
      buildPayload(
        {
          phoneNumberId: "1",
          credentialRef: "X",
          recipient: { kind: "BSUID", id: "x" },
          message: { type: "interactive", payload: b.payload },
        },
        false,
      ),
    ).toBeNull();
  });

  it("every limit is accepted at its maximum and refused one above it", () => {
    const s = (n: number) => "a".repeat(n);
    const ok = (p: unknown) => parseInteractivePayload(p) !== null;
    const btn = (over: Record<string, unknown> = {}, buttonOver: Record<string, unknown> = {}) => ({
      v: 1,
      kind: "buttons",
      body: "b",
      buttons: [{ id: id("a"), title: "t", ...buttonOver }],
      ...over,
    });
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: id(`r${i}`), title: "t" }));
    const lst = (over: Record<string, unknown> = {}, rowOver: Record<string, unknown> = {}) => ({
      v: 1,
      kind: "list",
      body: "b",
      buttonLabel: "x",
      sections: [{ title: "s", rows: [{ id: id("a"), title: "t", ...rowOver }] }],
      ...over,
    });
    const cases: Array<[string, unknown, boolean]> = [
      ["button body max", btn({ body: s(L.bodyMax) }), true],
      ["button body max+1", btn({ body: s(L.bodyMax + 1) }), false],
      ["footer max", btn({ footer: s(L.footerMax) }), true],
      ["footer max+1", btn({ footer: s(L.footerMax + 1) }), false],
      ["button title max", btn({}, { title: s(L.buttonTitleMax) }), true],
      ["button title max+1", btn({}, { title: s(L.buttonTitleMax + 1) }), false],
      [
        "three buttons",
        btn({ buttons: [1, 2, 3].map((i) => ({ id: id(`k${i}`), title: `t${i}` })) }),
        true,
      ],
      [
        "four buttons",
        btn({ buttons: [1, 2, 3, 4].map((i) => ({ id: id(`k${i}`), title: `t${i}` })) }),
        false,
      ],
      ["no buttons", btn({ buttons: [] }), false],
      [
        "duplicate button titles",
        btn({ buttons: [1, 2].map((i) => ({ id: id(`k${i}`), title: "same" })) }),
        false,
      ],
      [
        "duplicate ids",
        btn({ buttons: [1, 2].map((i) => ({ id: id("k"), title: `t${i}` })) }),
        false,
      ],
      ["empty body", btn({ body: "" }), false],
      ["id outside the reply-id grammar", btn({}, { id: "free-text-id" }), false],
      ["unknown key", btn({ header: { type: "text", text: "h" } }), false],
      ["version other than 1", btn({ v: 2 }), false],
      ["list body max", lst({ body: s(L.bodyMax) }), true],
      ["list body max+1", lst({ body: s(L.bodyMax + 1) }), false],
      ["button label max", lst({ buttonLabel: s(L.listButtonLabelMax) }), true],
      ["button label max+1", lst({ buttonLabel: s(L.listButtonLabelMax + 1) }), false],
      [
        "section title max",
        lst({ sections: [{ title: s(L.sectionTitleMax), rows: rows(1) }] }),
        true,
      ],
      [
        "section title max+1",
        lst({ sections: [{ title: s(L.sectionTitleMax + 1), rows: rows(1) }] }),
        false,
      ],
      ["section title missing", lst({ sections: [{ rows: rows(1) }] }), false],
      ["row title max", lst({}, { title: s(L.rowTitleMax) }), true],
      ["row title max+1", lst({}, { title: s(L.rowTitleMax + 1) }), false],
      ["description max", lst({}, { description: s(L.rowDescriptionMax) }), true],
      ["description max+1", lst({}, { description: s(L.rowDescriptionMax + 1) }), false],
      ["ten rows", lst({ sections: [{ title: "s", rows: rows(10) }] }), true],
      ["eleven rows", lst({ sections: [{ title: "s", rows: rows(11) }] }), false],
      [
        "eleven rows across sections",
        lst({
          sections: [
            { title: "a", rows: rows(6) },
            { title: "b", rows: rows(11).slice(6) },
          ],
        }),
        false,
      ],
      ["no sections", lst({ sections: [] }), false],
      ["empty section", lst({ sections: [{ title: "s", rows: [] }] }), false],
    ];
    for (const [name, payload, expected] of cases) expect(ok(payload), name).toBe(expected);
    // UTF-16 code units: a supplementary-plane emoji counts 2, so 10 emoji fill a 20-unit button title, 11 do not
    expect(ok(btn({}, { title: "🙂".repeat(10) }))).toBe(true);
    expect(ok(btn({}, { title: "🙂".repeat(11) }))).toBe(false);
    // an engine message that would exceed a limit is never stored
    expect(botSendContent({ kind: "text", text: "" })).toBeNull();
    expect(
      botSendContent({ kind: "buttons", body: "b", buttons: [{ id: "bad", title: "t" }] }),
    ).toBeNull();
  });
});

describe("the BOT final authorization decision", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const claim: BotFinalClaim = {
    requestId: "r",
    organizationId: "o",
    owner: "me",
    recipient: { kind: "PHONE", id: "94770000000" },
    messageType: "INTERACTIVE",
  };
  const row = (over: Record<string, unknown> = {}) =>
    ({
      state: "SENDING",
      claimed_by: "me",
      send_started_at: new Date(now.getTime() - 1_000),
      dispatch_deadline: new Date(now.getTime() + 60_000),
      recipient_kind: "PHONE",
      recipient_id: "94770000000",
      origin: "BOT",
      account_id: "a",
      account_status: "ACTIVE",
      account_archived_at: null,
      phone_number_id: "1",
      credential_ref: "X",
      conversation_id: "c",
      whatsapp_account_id: "a",
      contact_id: "k",
      last_inbound_at: new Date(now.getTime() - 60 * 60_000),
      wa_id: "94770000000",
      contact_archived_at: null,
      marketing_consent_status: "UNKNOWN",
      aliases: [],
      bot_hold_code: null,
      ...over,
    }) as never;
  const bots = { ...ON, botsRuntimeEnabled: true };
  const verdict = (over: Record<string, unknown> = {}, config = bots, at = now) =>
    botFinalVerdict(row(over), claim, config, at);

  it("authorizes a request that passes every check", () => {
    expect(verdict()).toEqual({ kind: "ok" });
  });

  it("refuses, in the approved order, with the first failing check's code", () => {
    expect(verdict({ state: "HELD" })).toEqual({ kind: "stale" });
    expect(verdict({ claimed_by: "other" })).toEqual({ kind: "stale" });
    expect(verdict({ origin: "STAFF" })).toEqual({ kind: "stale" });
    const r = (over: Record<string, unknown>, config = bots, at = now) =>
      (verdict(over, config, at) as { reason?: string }).reason;
    expect(r({}, { ...bots, outboundEnabled: false })).toBe("outbound_disabled");
    expect(r({}, { ...bots, botsRuntimeEnabled: false })).toBe("bots_runtime_disabled");
    expect(r({ account_status: "DISABLED", bot_hold_code: "bot_stopped" })).toBe(
      "account_inactive_before_dispatch",
    );
    expect(
      r({
        send_started_at: new Date(now.getTime() - SEND_START_BUDGET_MS - 1),
        bot_hold_code: "x",
      }),
    ).toBe("claim_expired_before_dispatch");
    expect(r({ dispatch_deadline: new Date(now.getTime() - 1), bot_hold_code: "x" })).toBe(
      "deadline_passed_before_dispatch",
    );
    expect(r({ bot_hold_code: "staff_took_over", contact_archived_at: now })).toBe(
      "staff_took_over",
    );
    expect(r({ contact_archived_at: now })).toBe("contact_archived");
    expect(r({ last_inbound_at: null })).toBe("no_inbound");
    expect(r({ aliases: [{ bsuid: "IN.abcdef", retiredAt: null }] })).toBe(
      "bsuid_send_unavailable",
    );
    expect(r({ wa_id: "94771111111" })).toBe("recipient_changed");
    expect(r({ recipient_id: "94771111111" })).toBe("recipient_changed");
  });

  it("evaluates the service window with the time given AFTER the read: eligible at claim, closed at the final check", () => {
    const t0 = now;
    const lastInbound = new Date(
      t0.getTime() - SERVICE_WINDOW_MS + SERVICE_WINDOW_SAFETY_MARGIN_MS + 30_000,
    );
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const over = {
      last_inbound_at: lastInbound,
      send_started_at: t0,
      dispatch_deadline: at(120_000),
    };
    expect(verdict(over, bots, t0)).toEqual({ kind: "ok" });
    expect(verdict(over, bots, at(31_000))).toEqual({ kind: "refused", reason: "window_closed" });
  });
});

describe("acceptance-record retry classification (RT7 and the error-chain rule)", () => {
  const pg = (code: string, cause?: unknown) => Object.assign(new Error(code), { code, cause });
  const wrapped = (inner: unknown) => Object.assign(new Error("Failed query"), { cause: inner });

  it("retries only a deadlock or serialization failure raised inside the transaction", () => {
    expect(retryableRecordFailure(pg("40P01"), false)).toBe(true);
    expect(retryableRecordFailure(pg("40001"), false)).toBe(true);
    expect(retryableRecordFailure(wrapped(pg("40P01")), false)).toBe(true); // Drizzle-wrapped
  });

  it("never retries an error raised at COMMIT (ambiguous: it may have committed) — RT7", () => {
    expect(retryableRecordFailure(pg("40P01"), true)).toBe(false);
    expect(retryableRecordFailure(pg("40001"), true)).toBe(false);
  });

  it("never retries a connection failure, wherever it sits in the error chain, or any other code", () => {
    expect(retryableRecordFailure(new Error("Connection terminated unexpectedly"), false)).toBe(
      false,
    );
    expect(retryableRecordFailure(pg("57P01"), false)).toBe(false);
    expect(retryableRecordFailure(wrapped(pg("57P01")), false)).toBe(false);
    expect(retryableRecordFailure(pg("40P01", pg("57P01")), false)).toBe(false);
    expect(retryableRecordFailure(pg("08006"), false)).toBe(false);
    expect(retryableRecordFailure(pg("23505"), false)).toBe(false);
    expect(retryableRecordFailure(undefined, false)).toBe(false);
  });
});
