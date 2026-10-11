import { describe, expect, it, vi } from "vitest";
import { classifyResponse, classifyTransportError, parseRetryAfter } from "./classify";
import { readOutboundConfig } from "./config";
import { MetaTransport, buildPayload, type HttpPost } from "./meta-transport";
import { RETRY_AFTER_CAP_MS, RETRY_MAX_MS, THROTTLE_RETRY_VERIFIED, retryDelayMs } from "./policy";
import { isSendableText, submitSchema } from "./schemas";
import { HttpAttemptError, type SendRequest } from "./transport";
import {
  chooseRecipient,
  assess,
  type ConversationContext,
  type AccountState,
  type TemplateRow,
} from "./eligibility";
import { serviceWindow } from "./window";

const NOW = new Date("2026-06-01T12:00:00Z");
const min = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("service window", () => {
  it.each([
    [min(1), true],
    [min(23 * 60), true],
    [min(24 * 60 - 10 - 0.1), true],
    [min(24 * 60 - 10), false], // the safety margin begins: 23h50m
    [min(24 * 60), false],
    [min(24 * 60 + 1), false],
  ])("last inbound %s -> open=%s", (at, open) => {
    expect(serviceWindow(at, NOW).open).toBe(open);
  });

  it("no inbound history is closed; an invalid date is closed", () => {
    expect(serviceWindow(null, NOW)).toEqual({ open: false, reason: "no_inbound" });
    expect(serviceWindow(new Date("nope"), NOW)).toEqual({ open: false, reason: "no_inbound" });
  });

  it("a timestamp slightly ahead of the clock counts as now; one far ahead is distrusted", () => {
    const skew = serviceWindow(new Date(NOW.getTime() + 3 * 60_000), NOW);
    expect(skew.open && skew.closesAt.getTime()).toBe(NOW.getTime() + 24 * 3600_000 - 10 * 60_000);
    expect(serviceWindow(new Date(NOW.getTime() + 11 * 60_000), NOW)).toEqual({
      open: false,
      reason: "inbound_timestamp_invalid",
    });
    expect(serviceWindow(new Date(NOW.getTime() + 72 * 3600_000), NOW)).toEqual({
      open: false,
      reason: "inbound_timestamp_invalid",
    });
  });

  it("closes exactly at the margin even with sub-second precision", () => {
    const start = min(24 * 60 - 10);
    expect(serviceWindow(new Date(start.getTime() + 1), NOW).open).toBe(true);
    expect(serviceWindow(start, NOW).open).toBe(false);
  });
});

describe("configuration gates", () => {
  it("every gate is on only for the exact string 'true'", () => {
    for (const bad of [
      undefined,
      "",
      "TRUE",
      "True",
      "1",
      "yes",
      "on",
      " true",
      "true ",
      "false",
    ]) {
      const c = readOutboundConfig({
        WHATSAPP_OUTBOUND_ENABLED: bad,
        WHATSAPP_LIVE_SEND_ENABLED: bad,
        WHATSAPP_BSUID_RECIPIENT_ENABLED: bad,
      });
      expect(c, JSON.stringify(bad)).toMatchObject({
        outboundEnabled: false,
        liveSendEnabled: false,
        bsuidRecipientEnabled: false,
      });
    }
    expect(readOutboundConfig({ WHATSAPP_OUTBOUND_ENABLED: "true" })).toMatchObject({
      outboundEnabled: true,
      liveSendEnabled: false,
      bsuidRecipientEnabled: false,
    });
    expect(readOutboundConfig({ WHATSAPP_LIVE_SEND_ENABLED: "true" })).toMatchObject({
      outboundEnabled: false,
      liveSendEnabled: true,
    });
  });

  it("the Graph version has no default and must look like a version", () => {
    expect(readOutboundConfig({}).graphApiVersion).toBeNull();
    for (const bad of ["25.0", "v25", "latest", "v25.0/../x", "v25.0 "])
      expect(
        readOutboundConfig({ WHATSAPP_GRAPH_API_VERSION: bad }).graphApiVersion,
        bad,
      ).toBeNull();
    expect(readOutboundConfig({ WHATSAPP_GRAPH_API_VERSION: "v25.0" }).graphApiVersion).toBe(
      "v25.0",
    );
    expect(readOutboundConfig({ WHATSAPP_GRAPH_API_VERSION: "v30.1" }).graphApiVersion).toBe(
      "v30.1",
    );
  });
});

describe("retry timing", () => {
  it("backs off, honours a Retry-After hint, and is bounded", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n, null, mid))).toEqual([
      30_000, 60_000, 120_000, 240_000,
    ]);
    expect(retryDelayMs(1, 600_000, mid)).toBe(600_000);
    expect(retryDelayMs(30, null, mid)).toBeLessThanOrEqual(RETRY_MAX_MS * 1.2);
    expect(retryDelayMs(1, 10 * 3600_000, mid)).toBe(RETRY_AFTER_CAP_MS);
    expect(retryDelayMs(1, -5, mid)).toBe(30_000);
  });
});

describe("text validation", () => {
  it.each([
    ["plain", "Hello", true],
    ["Sinhala, Tamil, emoji, ZWJ", "සිංහල தமிழ் \u{1F600} ‍", true],
    ["newline, CR and tab", "a\nb\r\nc\td", true],
    ["NUL", "a\u0000b", false],
    ["bell", "a\u0007b", false],
    ["escape", "a\u001bb", false],
    ["DEL", "a\u007fb", false],
    ["lone high surrogate", `a${String.fromCharCode(0xd800)}b`, false],
    ["lone low surrogate", `a${String.fromCharCode(0xdc00)}b`, false],
  ])("%s", (_n, value, ok) => {
    expect(isSendableText(value)).toBe(ok);
  });

  it("the request schema rejects unknown fields at every level", () => {
    const ok = {
      idempotencyKey: "abcdefgh1",
      conversationId: "00000000-0000-4000-8000-000000000001",
      message: { type: "text", body: "hi" },
    };
    expect(submitSchema.safeParse(ok).success).toBe(true);
    for (const extra of [
      { organizationId: "x" },
      { to: "1" },
      { message: { type: "text", body: "hi", to: "1" } },
    ])
      expect(submitSchema.safeParse({ ...ok, ...extra }).success).toBe(false);
    expect(
      submitSchema.safeParse({
        ...ok,
        message: {
          type: "template",
          templateId: "00000000-0000-4000-8000-000000000002",
          parameters: Array(21).fill("x"),
        },
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ recipients
const ctx = (
  over: Partial<ConversationContext> = {},
  contact: Partial<ConversationContext["contact"]> = {},
): ConversationContext => ({
  conversationId: "c",
  accountId: "a",
  contactId: "k",
  lastInboundAt: min(5),
  contact: { waId: "94771234567", archivedAt: null, marketingConsentStatus: "UNKNOWN", ...contact },
  aliases: [],
  ...over,
});
const account: AccountState = {
  id: "a",
  status: "ACTIVE",
  archivedAt: null,
  phoneNumberId: "123456789012345",
  credentialRef: "WA_TOKEN",
};
const template = (over: Partial<TemplateRow> = {}) =>
  ({
    id: "t",
    organizationId: "o",
    whatsappAccountId: "a",
    name: "n",
    languageCode: "en_US",
    category: "UTILITY",
    status: "APPROVED",
    bodyParameterCount: 0,
    attestedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as TemplateRow;

describe("chooseRecipient", () => {
  it("a contact with a current BSUID is addressed by it only when BSUID sending is enabled, and NEVER falls back to its stored phone", () => {
    const c = ctx({
      aliases: [
        { bsuid: "LK.cur", retiredAt: null },
        { bsuid: "LK.old", retiredAt: NOW },
      ],
    });
    expect(chooseRecipient(c, true)).toEqual({
      ok: true,
      recipient: { kind: "BSUID", id: "LK.cur" },
    });
    // the stored wa_id (94771234567) is historical for a BSUID-established contact: it is not a fallback
    expect(chooseRecipient(c, false)).toEqual({ ok: false, code: "bsuid_send_unavailable" });
  });
  it("only a contact never observed with a BSUID (legacy phone-only) is addressed by its phone", () => {
    for (const enabled of [true, false])
      expect(chooseRecipient(ctx(), enabled)).toEqual({
        ok: true,
        recipient: { kind: "PHONE", id: "94771234567" },
      });
  });
  it("never uses a retired alias, never mixes identities, never guesses", () => {
    expect(
      chooseRecipient(
        ctx({ aliases: [{ bsuid: "LK.old", retiredAt: NOW }] }, { waId: null }),
        true,
      ),
    ).toEqual({ ok: false, code: "identity_ambiguous" });
    expect(chooseRecipient(ctx({ aliases: [{ bsuid: "LK.old", retiredAt: NOW }] }), true)).toEqual({
      ok: false,
      code: "identity_ambiguous",
    });
    expect(
      chooseRecipient(
        ctx({
          aliases: [
            { bsuid: "LK.a", retiredAt: null },
            { bsuid: "LK.b", retiredAt: null },
          ],
        }),
        true,
      ),
    ).toEqual({ ok: false, code: "identity_ambiguous" });
    expect(chooseRecipient(ctx({}, { waId: null }), true)).toEqual({
      ok: false,
      code: "no_identity",
    });
    expect(
      chooseRecipient(
        ctx({ aliases: [{ bsuid: "LK.a", retiredAt: null }] }, { waId: null }),
        false,
      ),
    ).toEqual({ ok: false, code: "bsuid_send_unavailable" });
  });
  it("refuses an identifier that is not intact instead of cleaning it", () => {
    expect(chooseRecipient(ctx({}, { waId: "9477\u0000123" }), false)).toEqual({
      ok: false,
      code: "identity_ambiguous",
    });
    expect(chooseRecipient(ctx({}, { waId: "x".repeat(256) }), false)).toEqual({
      ok: false,
      code: "identity_ambiguous",
    });
    expect(
      chooseRecipient(ctx({ aliases: [{ bsuid: "LK.\u0001bad", retiredAt: null }] }), true),
    ).toEqual({ ok: false, code: "identity_ambiguous" });
  });
});

describe("assess", () => {
  const base = { account, bsuidRecipientEnabled: false, now: NOW };
  it("text needs an open window and an active account", () => {
    expect(assess({ ...base, context: ctx(), message: { type: "text" } })).toMatchObject({
      ok: true,
    });
    expect(
      assess({ ...base, context: ctx({ lastInboundAt: min(25 * 60) }), message: { type: "text" } }),
    ).toEqual({ ok: false, code: "window_closed" });
    expect(
      assess({
        ...base,
        account: { ...account, status: "DISABLED" },
        context: ctx(),
        message: { type: "text" },
      }),
    ).toEqual({ ok: false, code: "account_inactive" });
    expect(assess({ ...base, account: null, context: ctx(), message: { type: "text" } })).toEqual({
      ok: false,
      code: "account_inactive",
    });
  });
  it("templates: approval, parameters, category and consent", () => {
    const m = (t: TemplateRow | null, n = 0) => ({
      type: "template" as const,
      template: t,
      parameterCount: n,
    });
    const recent = ctx({ lastInboundAt: min(30) });
    expect(assess({ ...base, context: recent, message: m(template()) })).toMatchObject({
      ok: true,
    });
    expect(assess({ ...base, context: recent, message: m(null) })).toEqual({
      ok: false,
      code: "template_not_found",
    });
    expect(
      assess({ ...base, context: recent, message: m(template({ status: "PENDING_ATTESTATION" })) }),
    ).toEqual({ ok: false, code: "template_not_approved" });
    expect(
      assess({ ...base, context: recent, message: m(template({ bodyParameterCount: 1 })) }),
    ).toEqual({ ok: false, code: "template_parameters_mismatch" });
    expect(
      assess({ ...base, context: recent, message: m(template({ category: "AUTHENTICATION" })) }),
    ).toEqual({ ok: false, code: "template_category_unsupported" });
    expect(
      assess({ ...base, context: recent, message: m(template({ category: "MARKETING" })) }),
    ).toEqual({ ok: false, code: "marketing_consent_missing" });
    expect(
      assess({
        ...base,
        context: ctx({ lastInboundAt: min(30) }, { marketingConsentStatus: "GRANTED" }),
        message: m(template({ category: "MARKETING" })),
      }),
    ).toMatchObject({ ok: true });
    expect(
      assess({ ...base, context: ctx({ lastInboundAt: null }), message: m(template()) }),
    ).toEqual({ ok: false, code: "no_prior_contact" });
  });

  describe("a phone-only identity is not enough for a PROACTIVE template", () => {
    const m = (category: "UTILITY" | "MARKETING") => ({
      type: "template" as const,
      template: template({ category }),
      parameterCount: 0,
    });
    const old = ctx({ lastInboundAt: min(99 * 60) }); // wrote once, four days ago; phone-only contact
    const granted = { marketingConsentStatus: "GRANTED" as const };

    it("a recent qualifying inbound (window open) allows a phone-only template", () => {
      expect(
        assess({ ...base, context: ctx({ lastInboundAt: min(30) }), message: m("UTILITY") }),
      ).toMatchObject({
        ok: true,
        recipient: { kind: "PHONE" },
      });
    });
    it("a historical inbound alone does not: HELD with the window's reason, even with recorded consent", () => {
      expect(assess({ ...base, context: old, message: m("UTILITY") })).toEqual({
        ok: false,
        code: "window_closed",
      });
      expect(
        assess({
          ...base,
          context: ctx({ lastInboundAt: min(99 * 60) }, granted),
          message: m("MARKETING"),
        }),
      ).toEqual({ ok: false, code: "window_closed" });
      // just past the edge (24h minus the 10-minute margin)
      expect(
        assess({
          ...base,
          context: ctx({ lastInboundAt: min(24 * 60 - 9) }),
          message: m("UTILITY"),
        }),
      ).toEqual({ ok: false, code: "window_closed" });
    });
    it("an inbound dated in the future cannot open it", () => {
      expect(
        assess({ ...base, context: ctx({ lastInboundAt: min(-60) }), message: m("UTILITY") }),
      ).toEqual({ ok: false, code: "inbound_timestamp_invalid" });
    });
    it("a never-inbound contact keeps its existing refusal codes", () => {
      expect(
        assess({ ...base, context: ctx({ lastInboundAt: null }), message: m("UTILITY") }),
      ).toEqual({
        ok: false,
        code: "no_prior_contact",
      });
      expect(
        assess({
          ...base,
          context: ctx({ lastInboundAt: null }, granted),
          message: m("MARKETING"),
        }),
      ).toEqual({ ok: false, code: "no_inbound" });
    });
    it("a contact with a current BSUID is unaffected by this rule (it is governed by the BSUID gate, which stays off)", () => {
      const bsuid = ctx({
        lastInboundAt: min(99 * 60),
        aliases: [{ bsuid: "LK.cur", retiredAt: null }],
      });
      expect(assess({ ...base, context: bsuid, message: m("UTILITY") })).toEqual({
        ok: false,
        code: "bsuid_send_unavailable",
      });
      expect(
        assess({ ...base, bsuidRecipientEnabled: true, context: bsuid, message: m("UTILITY") }),
      ).toMatchObject({ ok: true, recipient: { kind: "BSUID" } });
    });
  });
});

// -------------------------------------------------------------------------------------------- classification
describe("provider response classification", () => {
  const ok = {
    messaging_product: "whatsapp",
    contacts: [{ input: "1", wa_id: "1" }],
    messages: [{ id: "wamid.HBgL/+=", message_status: "accepted" }],
  };
  const err = (code: number) => ({
    error: { code, message: "SECRET PROVIDER TEXT", type: "x", fbtrace_id: "t" },
  });

  it("accepts a well-formed success and keeps the id exactly", () => {
    expect(classifyResponse(200, ok, null)).toEqual({
      kind: "accepted",
      wamid: "wamid.HBgL/+=",
      providerStatus: "accepted",
      httpStatus: 200,
    });
    expect(classifyResponse(200, { messages: [{ id: "wamid.X" }] }, null)).toMatchObject({
      kind: "accepted",
      providerStatus: null,
    });
  });

  it.each([
    ["no body", undefined],
    ["no messages", { messages: [] }],
    ["two messages", { messages: [{ id: "a" }, { id: "b" }] }],
    ["a missing id", { messages: [{}] }],
    ["a numeric id", { messages: [{ id: 5 }] }],
    ["an id with a control character", { messages: [{ id: "wamid.\nX" }] }],
    ["an oversized id", { messages: [{ id: "x".repeat(513) }] }],
    ["an unrelated object", { hello: "world" }],
  ])("a 2xx with %s is UNKNOWN (the message may exist), never accepted", (_n, body) => {
    expect(classifyResponse(200, body, null)).toMatchObject({
      kind: "unknown",
      reason: "malformed_success_response",
    });
  });

  it.each([
    [0, 401, "credential_rejected"],
    [190, 401, "credential_rejected"],
    [10, 403, "credential_rejected"],
    [131005, 403, "credential_rejected"],
    [100, 400, "invalid_request"],
    [131008, 400, "invalid_request"],
    [131009, 400, "invalid_request"],
    [131047, 400, "window_closed_at_provider"],
    [131026, 400, "recipient_unreachable"],
    [131050, 400, "recipient_unreachable"],
    [131048, 429, "ecosystem_limit"],
    [131049, 400, "ecosystem_limit"],
    [131049, 429, "ecosystem_limit"],
    [132001, 400, "template_rejected"],
    [132000, 400, "template_rejected"],
    [368, 403, "account_restricted"],
    [131037, 400, "account_restricted"],
  ])("code %i (HTTP %i) is conclusively rejected as %s", (code, status, reason) => {
    // 131048 / 131049 come with 429 in Meta's table, but they mean "wait a day", not "retry in a minute"
    expect(classifyResponse(status, err(code), null)).toMatchObject({
      kind: "rejected",
      reason,
      providerErrorCode: String(code),
    });
  });

  it.each([130429, 131056, 80007, 4])(
    "documented rate-limit code %i on a 429 is terminal UNKNOWN (Meta does not say nothing was created); the code is kept, the Retry-After hint is not acted on",
    (code) => {
      expect(classifyResponse(429, err(code), "30")).toEqual({
        kind: "unknown",
        reason: "rate_limited_semantics_unverified",
        httpStatus: 429,
        providerErrorCode: String(code),
      });
    },
  );

  it("the throttle path is preserved behind the policy switch (verified-contract future), and only for a well-formed documented 429", () => {
    const verified = { throttleRetryVerified: true };
    expect(classifyResponse(429, err(130429), "30", verified)).toEqual({
      kind: "throttled",
      retryAfterMs: 30_000,
      httpStatus: 429,
      providerErrorCode: "130429",
    });
    // the response-shape validation still applies with the switch on
    expect(classifyResponse(429, undefined, "30", verified)).toMatchObject({ kind: "unknown" });
    expect(classifyResponse(429, err(424242), "30", verified)).toMatchObject({ kind: "unknown" });
    expect(
      classifyResponse(429, { ...err(130429), messages: [{ id: "x" }] }, "30", verified),
    ).toMatchObject({ kind: "unknown", reason: "contradictory_error_response" });
    expect(THROTTLE_RETRY_VERIFIED).toBe(false);
  });

  it("Retry-After is parsed strictly and capped", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("999999")).toBe(RETRY_AFTER_CAP_MS);
    for (const bad of ["abc", "-1", "1.5", "", "Wed, 21 Oct 2026 07:28:00 GMT", null])
      expect(parseRetryAfter(bad as never)).toBeNull();
  });

  describe("uncertain provider answers are UNKNOWN, never throttled or rejected", () => {
    const created = { messages: [{ id: "wamid.MAYBE" }], contacts: [{ input: "x", wa_id: "x" }] };
    it.each([
      ["a bare 429", 429, undefined, "rate_limit_unrecognized"],
      ["a 429 with an unparseable body", 429, undefined, "rate_limit_unrecognized"],
      ["a 429 with a non-Meta JSON body", 429, { hello: 1 }, "rate_limit_unrecognized"],
      ["a 429 with an undocumented code", 429, err(424242), "rate_limit_unrecognized"],
      [
        "a 429 with a non-integer code",
        429,
        { error: { code: "130429" } },
        "rate_limit_unrecognized",
      ],
      [
        "a 429 with a documented code and success-shaped data",
        429,
        { ...err(130429), ...created },
        "contradictory_error_response",
      ],
      [
        "a 429 with an empty-but-present messages object",
        429,
        { ...err(130429), messages: {} },
        "contradictory_error_response",
      ],
      ["a 400 with an undocumented code", 400, err(999999), "unrecognized_client_error"],
      ["a 404 with an undocumented code", 404, err(1), "unrecognized_client_error"],
      ["a 400 with no error object", 400, { hello: 1 }, "unrecognized_client_error"],
      [
        "a 400 with a documented rejection code and success-shaped data",
        400,
        { ...err(100), ...created },
        "contradictory_error_response",
      ],
      ["a throttle code on a 400", 400, err(130429), "unrecognized_client_error"],
      [
        "a 200 that also carries an error",
        200,
        { ...err(130429), ...created },
        "contradictory_success_response",
      ],
      ["a 200 with no message id", 200, { messages: [] }, "malformed_success_response"],
      [
        "a 200 with two message ids",
        200,
        { messages: [{ id: "a1" }, { id: "b2" }] },
        "malformed_success_response",
      ],
      ["a 200 with an unparseable body", 200, undefined, "malformed_success_response"],
      ["a 408", 408, err(100), "unexpected_status"],
      ["a redirect", 302, undefined, "unexpected_status"],
    ])("%s", (_name, status, body, reason) => {
      expect(classifyResponse(status, body, "30")).toEqual({
        kind: "unknown",
        reason,
        httpStatus: status,
      });
    });
  });

  it.each([500, 502, 503, 504])(
    "HTTP %i is UNKNOWN: the service failed, which does not prove nothing was created",
    (status) => {
      expect(classifyResponse(status, err(131000), null)).toMatchObject({
        kind: "unknown",
        reason: "provider_server_error",
        httpStatus: status,
      });
      expect(classifyResponse(status, undefined, null)).toMatchObject({ kind: "unknown" });
    },
  );

  it("the provider's error text never appears in a result", () => {
    for (const status of [400, 401, 429, 500])
      expect(JSON.stringify(classifyResponse(status, err(100), null))).not.toContain(
        "SECRET PROVIDER TEXT",
      );
  });
});

describe("transport error classification", () => {
  const wrapped = (code: string) =>
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("x"), { code }),
    });
  // An error code describes the LAST thing that went wrong, which can be a later connection attempt, so no code proves that
  // nothing was transmitted. Every failure of an HTTP attempt is UNKNOWN, including the ones that look harmless.
  it.each([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "UND_ERR_CONNECT_TIMEOUT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "UND_ERR_SOCKET",
    "ABORT_ERR",
  ])("%s is UNKNOWN, never not_sent", (code) => {
    expect(classifyTransportError(wrapped(code))).toEqual({
      kind: "unknown",
      reason: "transport_error_after_possible_send",
      httpStatus: null,
    });
  });
  it.each(["timeout", "aborted", "network", "response_incomplete"] as const)(
    "an HTTP attempt that failed with %s is UNKNOWN with a fixed reason",
    (kind) => {
      expect(classifyTransportError(new HttpAttemptError(kind))).toEqual({
        kind: "unknown",
        reason: `transport_${kind}`,
        httpStatus: null,
      });
    },
  );
  it("an abort or any unknown error is UNKNOWN", () => {
    expect(classifyTransportError(new DOMException("aborted", "AbortError"))).toMatchObject({
      kind: "unknown",
    });
    expect(classifyTransportError("weird")).toMatchObject({ kind: "unknown" });
  });
});

// ------------------------------------------------------------------------------------------------ MetaTransport
describe("MetaTransport (a fake HTTP implementation; no network exists)", () => {
  const TOKEN = "EAAB-test-token-0123456789abcdef";
  const live = {
    WHATSAPP_OUTBOUND_ENABLED: "true",
    WHATSAPP_LIVE_SEND_ENABLED: "true",
    WHATSAPP_GRAPH_API_VERSION: "v25.0",
    WA_TOKEN: TOKEN,
  };
  const text: SendRequest = {
    phoneNumberId: "123456789012345",
    credentialRef: "WA_TOKEN",
    recipient: { kind: "PHONE", id: "94771234567" },
    message: { type: "text", body: "Hello", replyToWamid: null },
  };
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) as Uint8Array | null,
  });
  const transport = (env: Record<string, string | undefined>, fetchImpl: HttpPost) =>
    new MetaTransport({ env: () => env, post: fetchImpl });
  const send = (tr: MetaTransport, req: SendRequest = text) =>
    tr.send(req, new AbortController().signal);

  it("builds the documented request: POST to graph.facebook.com/{version}/{phone-number-id}/messages with a Bearer token", async () => {
    const fetchImpl = vi.fn<HttpPost>(async () => reply(200, { messages: [{ id: "wamid.OK1" }] }));
    const result = await send(transport(live, fetchImpl));
    expect(result).toMatchObject({ kind: "accepted", wamid: "wamid.OK1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v25.0/123456789012345/messages");
    expect(Object.keys(init).sort()).toEqual(["body", "headers", "signal"]); // no method/redirect/destination options to override
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "94771234567",
      type: "text",
      text: { body: "Hello" },
    });
    expect(url).not.toContain(TOKEN);
  });

  it("encodes Unicode text exactly and a reply as context.message_id", async () => {
    const fetchImpl = vi.fn<HttpPost>(async () => reply(200, { messages: [{ id: "wamid.OK2" }] }));
    const body = 'සිංහල \u{1F600} "quoted" \\ back\nline';
    await send(transport(live, fetchImpl), {
      ...text,
      message: { type: "text", body, replyToWamid: "wamid.PARENT" },
    });
    const sent = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(sent.text.body).toBe(body);
    expect(sent.context).toEqual({ message_id: "wamid.PARENT" });
  });

  it("builds a template request with its language and body parameters", async () => {
    const payload = buildPayload(
      {
        ...text,
        message: {
          type: "template",
          name: "order_update",
          languageCode: "si",
          bodyParameters: ["A", "B"],
        },
      },
      false,
    );
    expect(payload).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "94771234567",
      type: "template",
      template: {
        name: "order_update",
        language: { code: "si" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "A" },
              { type: "text", text: "B" },
            ],
          },
        ],
      },
    });
    expect(
      buildPayload(
        {
          ...text,
          message: { type: "template", name: "hello", languageCode: "en_US", bodyParameters: [] },
        },
        false,
      ),
    ).toMatchObject({ template: { name: "hello", language: { code: "en_US" } } });
    expect(
      (
        buildPayload(
          {
            ...text,
            message: { type: "template", name: "hello", languageCode: "en_US", bodyParameters: [] },
          },
          false,
        ) as { template: object }
      ).template,
    ).not.toHaveProperty("components");
  });

  it("addresses a BSUID with `recipient` and OMITS `to`, only when BSUID sending is enabled; never the reverse", () => {
    const bsuid: SendRequest = {
      ...text,
      recipient: { kind: "BSUID", id: "US.13491208655302741918" },
    };
    const on = buildPayload(bsuid, true)!;
    expect(on.recipient).toBe("US.13491208655302741918");
    expect(on).not.toHaveProperty("to");
    expect(buildPayload(bsuid, false)).toBeNull();
    const phone = buildPayload(text, true)!;
    expect(phone.to).toBe("94771234567");
    expect(phone).not.toHaveProperty("recipient");
  });

  it("a BSUID request with BSUID sending off is not sent and makes no HTTP call", async () => {
    const fetchImpl = vi.fn<HttpPost>();
    const result = await send(transport(live, fetchImpl), {
      ...text,
      recipient: { kind: "BSUID", id: "US.1" },
    });
    expect(result).toEqual({ kind: "not_sent", reason: "bsuid_recipient_not_enabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("the gates are enforced at the HTTP boundary on every call", () => {
    it.each([
      ["outbound disabled", { ...live, WHATSAPP_OUTBOUND_ENABLED: undefined }, "outbound_disabled"],
      [
        "live send disabled",
        { ...live, WHATSAPP_LIVE_SEND_ENABLED: undefined },
        "live_send_disabled",
      ],
      ["live send 'TRUE'", { ...live, WHATSAPP_LIVE_SEND_ENABLED: "TRUE" }, "live_send_disabled"],
      ["live send '1'", { ...live, WHATSAPP_LIVE_SEND_ENABLED: "1" }, "live_send_disabled"],
      [
        "no Graph version",
        { ...live, WHATSAPP_GRAPH_API_VERSION: undefined },
        "graph_version_unconfigured",
      ],
      [
        "a malformed Graph version",
        { ...live, WHATSAPP_GRAPH_API_VERSION: "latest" },
        "graph_version_unconfigured",
      ],
      ["no token in the environment", { ...live, WA_TOKEN: undefined }, "credential_unavailable"],
      ["a too-short token", { ...live, WA_TOKEN: "short" }, "credential_unavailable"],
      [
        "a token with whitespace",
        { ...live, WA_TOKEN: "has whitespace in the token value" },
        "credential_unavailable",
      ],
    ])("%s: nothing is sent", async (_n, env, reason) => {
      const fetchImpl = vi.fn<HttpPost>();
      expect(await send(transport(env, fetchImpl))).toEqual({ kind: "not_sent", reason });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("the gates are re-read on every call, so a flag turned off mid-run stops the very next send", async () => {
      const env: Record<string, string | undefined> = { ...live };
      const fetchImpl = vi.fn<HttpPost>(async () => reply(200, { messages: [{ id: "wamid.G1" }] }));
      const tr = transport(env, fetchImpl);
      expect((await send(tr)).kind).toBe("accepted");
      env.WHATSAPP_LIVE_SEND_ENABLED = "false";
      expect((await send(tr)).kind).toBe("not_sent");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("an account without a credential reference, or with an arbitrary string instead of a variable NAME, is not sent", async () => {
      const fetchImpl = vi.fn<HttpPost>();
      for (const credentialRef of [
        null,
        "",
        "lower_case",
        "EAAB.looks.like.a.token",
        "has space",
      ]) {
        expect(
          await send(transport(live, fetchImpl), { ...text, credentialRef }),
          String(credentialRef),
        ).toMatchObject({ kind: "not_sent" });
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("a phone_number_id that is not a number is not sent (nothing from the caller reaches the URL)", async () => {
      const fetchImpl = vi.fn<HttpPost>();
      for (const phoneNumberId of ["../../evil", "123/messages?x=", "abc", "12", "1".repeat(31)])
        expect(
          await send(transport(live, fetchImpl), { ...text, phoneNumberId }),
          phoneNumberId,
        ).toEqual({ kind: "not_sent", reason: "invalid_phone_number_id" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("result handling", () => {
    it("never returns, throws or logs the token or the provider's error text", async () => {
      const spies = (["log", "warn", "error", "info"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined),
      );
      const fetchImpl = vi.fn<HttpPost>(async () =>
        reply(401, { error: { code: 190, message: `token ${TOKEN} expired` } }),
      );
      const result = await send(transport(live, fetchImpl));
      expect(result).toMatchObject({
        kind: "rejected",
        reason: "credential_rejected",
        providerErrorCode: "190",
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
      vi.restoreAllMocks();
    });

    it("an oversized body, invalid JSON and invalid UTF-8 are read safely: a 200 stays UNKNOWN", async () => {
      for (const body of ["x".repeat(70_000), "{not json", "\u0000"]) {
        const result = await send(transport(live, async () => reply(200, body)));
        expect(result).toMatchObject({ kind: "unknown" });
      }
    });

    it("every failure of the HTTP attempt is UNKNOWN: a refusal, a reset, a timeout or an abort proves nothing about what was sent", async () => {
      for (const error of [
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
        Object.assign(new Error("x"), { code: "ENOTFOUND" }),
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
        new HttpAttemptError("timeout"),
      ]) {
        const result = await send(
          transport(live, async () => {
            throw error;
          }),
        );
        expect(result).toMatchObject({ kind: "unknown", httpStatus: null });
      }
    });

    it("the dispatcher is told when an HTTP attempt begins, and not for a pre-flight refusal", async () => {
      const started = vi.fn();
      const post = vi.fn<HttpPost>(async () => reply(200, { messages: [{ id: "wamid.H1" }] }));
      await transport(live, post).send(text, new AbortController().signal, {
        httpStarted: started,
      });
      expect(started).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledTimes(1);
      const refused = vi.fn();
      const post2 = vi.fn<HttpPost>();
      const result = await transport({ ...live, WHATSAPP_LIVE_SEND_ENABLED: "false" }, post2).send(
        text,
        new AbortController().signal,
        { httpStarted: refused },
      );
      expect(result).toEqual({ kind: "not_sent", reason: "live_send_disabled" });
      expect(refused).not.toHaveBeenCalled();
      expect(post2).not.toHaveBeenCalled();
    });

    it("a documented 429 is UNKNOWN, not throttled, whatever Retry-After says", async () => {
      const result = await send(
        transport(live, async () =>
          reply(429, { error: { code: 130429 } }, { "retry-after": "12" }),
        ),
      );
      expect(result).toEqual({
        kind: "unknown",
        reason: "rate_limited_semantics_unverified",
        httpStatus: 429,
        providerErrorCode: "130429",
      });
    });

    it("an abort signal that is already set sends nothing; one that fires during the attempt is UNKNOWN", async () => {
      const already = new AbortController();
      already.abort();
      const post = vi.fn<HttpPost>();
      expect(await transport(live, post).send(text, already.signal)).toEqual({
        kind: "not_sent",
        reason: "aborted_before_http",
      });
      expect(post).not.toHaveBeenCalled();

      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      const tr = transport(live, async (_u, init) => {
        seen = init.signal;
        controller.abort();
        await new Promise((r) => setTimeout(r, 5));
        throw new HttpAttemptError("aborted");
      });
      const result = await tr.send(text, controller.signal);
      expect(seen?.aborted).toBe(true);
      expect(result).toMatchObject({ kind: "unknown", reason: "transport_aborted" });
    });
  });
});
