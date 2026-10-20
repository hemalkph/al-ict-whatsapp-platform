import { describe, expect, it } from "vitest";
import { INBOX_DEFAULTS, readInboxConfig } from "./config";
import { decodeCursor, encodeCursor } from "./cursor";
import {
  HOLD_REASONS,
  contactLabel,
  deliveryView,
  describeMessage,
  mediaViews,
  safeLine,
  safeText,
} from "./display";
import { likePattern } from "./list";
import {
  assignmentSchema,
  listQuerySchema,
  messagesQuerySchema,
  noteSchema,
  quickReplyCreateSchema,
  quickReplyUpdateSchema,
  seenSchema,
  statusChangeSchema,
  tagCreateSchema,
} from "./schemas";
import { isPlainText } from "./text";

const U = "11111111-1111-4111-8111-111111111111";
const TS = "2026-06-01T12:00:00.123456Z";

describe("safe display text (provider text is untrusted)", () => {
  const ch = (...codes: number[]) => codes.map((c) => String.fromCharCode(c)).join("");

  it("removes control, bidi-override and zero-width-space characters, keeps newlines, and bounds the length", () => {
    expect(safeText(`a${ch(0x202e)}b${ch(7)}c${ch(0x200b)}d${ch(0xfeff)}e${ch(0x2066)}f`, 50)).toBe(
      "abcdef",
    );
    expect(safeText("line 1\nline 2\tend", 50)).toBe("line 1\nline 2\tend");
    expect(safeText("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(safeText(undefined, 10)).toBe("");
    expect(safeText(42 as never, 10)).toBe("");
  });

  it("KEEPS the zero-width joiner and non-joiner that Sinhala and Tamil need, and the text itself unchanged", () => {
    const sinhala = "ශිෂ්‍යයා ලියාපදිංචිය"; // contains U+200D
    const tamil = "வணக்கம், ICT வகுப்பு கட்டணம்";
    expect(sinhala.includes(ch(0x200d))).toBe(true);
    expect(safeText(sinhala, 200)).toBe(sinhala);
    expect(safeText(tamil, 200)).toBe(tamil);
    expect(safeText(`a${ch(0x200c)}b`, 10)).toBe(`a${ch(0x200c)}b`);
  });

  it("repairs malformed Unicode instead of throwing, and HTML stays literal text", () => {
    expect(() => safeText(`bad${ch(0xd800)}`, 20)).not.toThrow();
    expect(safeText(`bad${ch(0xd800)}`, 20).isWellFormed()).toBe(true);
    expect(safeText('<img src=x onerror="alert(1)">', 100)).toBe('<img src=x onerror="alert(1)">');
  });

  it("safeLine collapses whitespace into one bounded line", () => {
    expect(safeLine("  a \n\n b\t c  ", 20)).toBe("a b c");
    expect(safeLine("x".repeat(500), 20)).toHaveLength(20);
  });

  it("isPlainText matches the outbound rule", () => {
    expect(isPlainText("ok\nfine\ttab")).toBe(true);
    for (const bad of [ch(0), ch(7), ch(0x7f), ch(0xd800)])
      expect(isPlainText(`a${bad}b`)).toBe(false);
  });
});

describe("contact labels", () => {
  it("prefer the profile name, then the username, else a neutral fallback with a short id tail only", () => {
    expect(
      contactLabel({ profileName: "Nimal", username: "@n", waId: "94771234567", bsuid: null }),
    ).toEqual({ displayName: "Nimal", named: true, idHint: "…4567" });
    expect(
      contactLabel({ profileName: null, username: "@kasun", waId: null, bsuid: "LK.abcdef1234" }),
    ).toEqual({ displayName: "@kasun", named: true, idHint: "…1234" });
    expect(contactLabel({ profileName: "  ", username: null, waId: null, bsuid: null })).toEqual({
      displayName: "Unnamed contact",
      named: false,
      idHint: null,
    });
    expect(
      contactLabel({ profileName: null, username: null, waId: "12", bsuid: null }).idHint,
    ).toBeNull();
  });
});

describe("message descriptions", () => {
  it("text is text; media and unknown types get safe placeholders; nothing exposes raw JSON or URLs", () => {
    expect(describeMessage({ type: "TEXT", body: "hi", content: null })).toEqual({
      text: "hi",
      placeholder: null,
    });
    expect(describeMessage({ type: "TEXT", body: null, content: null }).placeholder).toBe(
      "Empty message",
    );
    expect(
      describeMessage({
        type: "IMAGE",
        body: "caption",
        content: { media: { id: "secret-media" } },
      }),
    ).toEqual({ text: "caption", placeholder: "Photo" });
    expect(
      describeMessage({
        type: "CONTACT",
        body: null,
        content: { contacts: [{ phones: ["0771111111"] }] },
      }),
    ).toEqual({ text: null, placeholder: "Shared contact card" });
    expect(
      describeMessage({
        type: "WHATEVER_NEW",
        body: null,
        content: { url: "https://x.example/private" },
      }),
    ).toEqual({ text: null, placeholder: "Unsupported message" });
    expect(
      describeMessage({
        type: "TEMPLATE",
        body: null,
        content: { template: { name: "fees_reminder" }, parameters: ["secret"] },
      }),
    ).toEqual({ text: null, placeholder: "Template: fees_reminder" });
    expect(
      describeMessage({
        type: "LOCATION",
        body: "Library",
        content: { address: "Main St", latitude: 6.9, longitude: 79.8 },
      }).text,
    ).toBe("Library · Main St");
    expect(describeMessage({ type: "REACTION", body: null, content: { emoji: "👍" } }).text).toBe(
      "👍",
    );
  });

  it("attachments expose metadata only, with a default state for anything unexpected", () => {
    expect(
      mediaViews([
        { mimeType: "image/jpeg", filename: "a.jpg", sizeBytes: 10, storageStatus: "PENDING" },
        { mimeType: null, filename: null, sizeBytes: -5, storageStatus: "ODD" },
      ]),
    ).toEqual([
      { mimeType: "image/jpeg", filename: "a.jpg", sizeBytes: 10, state: "PENDING" },
      { mimeType: null, filename: null, sizeBytes: null, state: "PENDING" },
    ]);
  });
});

describe("delivery display never overstates", () => {
  const view = (o: Partial<Parameters<typeof deliveryView>[0]>) =>
    deliveryView({
      requestState: null,
      holdReason: null,
      failureCode: null,
      providerStatus: null,
      providerErrorCode: null,
      ...o,
    });

  it.each([
    [{ requestState: "QUEUED" }, "QUEUED", "neutral"],
    [{ requestState: "SENDING" }, "SENDING", "neutral"],
    [{ requestState: "ACCEPTED" }, "ACCEPTED", "neutral"],
    [{ requestState: "ACCEPTED", providerStatus: "SENT" }, "SENT", "neutral"],
    [{ requestState: "ACCEPTED", providerStatus: "DELIVERED" }, "DELIVERED", "good"],
    [{ requestState: "ACCEPTED", providerStatus: "READ" }, "READ", "good"],
    [
      { requestState: "ACCEPTED", providerStatus: "FAILED", providerErrorCode: "131026" },
      "FAILED",
      "error",
    ],
    [{ requestState: "REJECTED", failureCode: "invalid_request" }, "REJECTED", "error"],
    [{ requestState: "HELD", holdReason: "window_closed" }, "HELD", "warning"],
    [{ requestState: "UNKNOWN_OUTCOME" }, "UNKNOWN_OUTCOME", "warning"],
    [{ requestState: null, providerStatus: "READ" }, "READ", "good"],
    [{ requestState: null }, "NONE", "neutral"],
  ])("%j shows %s", (input, phase, severity) => {
    expect(view(input)).toMatchObject({ phase, severity });
  });

  it("a queued message is never described as sent, and acceptance is never described as delivered", () => {
    expect(view({ requestState: "QUEUED" }).detail).toMatch(/not been sent to WhatsApp yet/);
    expect(view({ requestState: "ACCEPTED" }).label).toBe("Accepted by WhatsApp");
    expect(view({ requestState: "ACCEPTED" }).detail).toMatch(
      /not yet reported as sent or delivered/,
    );
  });

  it("a provider status cannot override a request that was not accepted", () => {
    expect(
      view({ requestState: "HELD", holdReason: "window_closed", providerStatus: "READ" }).phase,
    ).toBe("HELD");
    expect(view({ requestState: "UNKNOWN_OUTCOME", providerStatus: "DELIVERED" }).phase).toBe(
      "UNKNOWN_OUTCOME",
    );
    expect(view({ requestState: "QUEUED", providerStatus: "READ" }).phase).toBe("QUEUED");
  });

  it("an unknown outcome carries the warning and never invites a resend", () => {
    const v = view({ requestState: "UNKNOWN_OUTCOME" });
    expect(v.detail).toMatch(/may or may not have been sent/);
    expect(v.detail).toMatch(/Do not send it again/);
    expect(JSON.stringify(v)).not.toMatch(/resend|retry|try again/i);
  });
});

describe("cursors", () => {
  it("round-trip exactly and refuse anything this module did not produce", () => {
    const c = { t: TS, id: U };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    for (const bad of [
      "",
      "nonsense",
      "e30",
      "a".repeat(201),
      "%%%",
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({ t: "2026-06-01", id: U })).toString("base64url"),
      Buffer.from(JSON.stringify({ t: TS, id: "x" })).toString("base64url"),
      Buffer.from(JSON.stringify({ t: TS, id: U, extra: 1 })).toString("base64url"),
    ])
      expect(decodeCursor(bad)).toBeNull();
  });
});

describe("search patterns", () => {
  it("escape LIKE wildcards so staff-typed text is literal", () => {
    expect(likePattern("100%_a\\b", "contains")).toBe("%100\\%\\_a\\\\b%");
    expect(likePattern("9477", "prefix")).toBe("9477%");
  });
});

describe("input schemas", () => {
  it("list queries are bounded, defaulted and strict", () => {
    expect(listQuerySchema.parse({})).toEqual({ view: "all", limit: 30 });
    expect(
      listQuerySchema.parse({ view: "mine", q: "  nim ", limit: "50", accountId: U }),
    ).toMatchObject({ view: "mine", q: "nim", limit: 50 });
    for (const bad of [
      { limit: "51" },
      { limit: "0" },
      { view: "everything" },
      { q: "a" },
      { q: "x".repeat(65) },
      { accountId: "no" },
      { organizationId: U },
      { cursor: "" },
    ])
      expect(listQuerySchema.safeParse(bad).success).toBe(false);
    expect(messagesQuerySchema.safeParse({ limit: "100" }).success).toBe(false);
  });

  it("status and assignment changes need the value the browser saw", () => {
    expect(statusChangeSchema.safeParse({ to: "PENDING", expected: "OPEN" }).success).toBe(true);
    for (const bad of [
      { to: "PENDING" },
      { expected: "OPEN" },
      { to: "DONE", expected: "OPEN" },
      { to: "OPEN", expected: "OPEN", x: 1 },
    ])
      expect(statusChangeSchema.safeParse(bad).success).toBe(false);
    expect(
      assignmentSchema.safeParse({ assigneeMembershipId: null, expectedAssigneeMembershipId: null })
        .success,
    ).toBe(true);
    expect(
      assignmentSchema.safeParse({ assigneeMembershipId: U, expectedAssigneeMembershipId: U })
        .success,
    ).toBe(true);
    for (const bad of [
      { assigneeMembershipId: U },
      { assigneeMembershipId: "x", expectedAssigneeMembershipId: null },
      { assigneeMembershipId: undefined, expectedAssigneeMembershipId: null },
    ])
      expect(assignmentSchema.safeParse(bad).success).toBe(false);
  });

  it("marking seen is bounded to 100 distinct-looking ids", () => {
    expect(seenSchema.safeParse({ messageIds: [U] }).success).toBe(true);
    expect(seenSchema.safeParse({ messageIds: Array(100).fill(U) }).success).toBe(true);
    expect(seenSchema.safeParse({ messageIds: Array(101).fill(U) }).success).toBe(false);
    expect(seenSchema.safeParse({ messageIds: [] }).success).toBe(false);
    expect(seenSchema.safeParse({ messageIds: ["x"] }).success).toBe(false);
  });

  it("notes, quick replies and tags are bounded, exact and single-line where they should be", () => {
    expect(noteSchema.safeParse({ body: "ok\nmultiple lines" }).success).toBe(true);
    for (const body of ["", " ", "x".repeat(4001), "a\u0000"])
      expect(noteSchema.safeParse({ body }).success).toBe(false);
    expect(quickReplyCreateSchema.safeParse({ title: "Hi", body: "Hello" }).success).toBe(true);
    for (const bad of [
      { title: "t".repeat(61), body: "b" },
      { title: "a\nb", body: "b" },
      { title: "t", body: "b".repeat(1001) },
      { title: "t", body: "b", x: 1 },
    ])
      expect(quickReplyCreateSchema.safeParse(bad).success).toBe(false);
    expect(quickReplyUpdateSchema.safeParse({}).success).toBe(false);
    expect(quickReplyUpdateSchema.safeParse({ archived: true }).success).toBe(true);
    expect(tagCreateSchema.safeParse({ name: "Theory" }).success).toBe(true);
    for (const name of ["", "x".repeat(41), "two\nlines", "tab\there"])
      expect(tagCreateSchema.safeParse({ name }).success).toBe(false);
  });
});

describe("polling configuration", () => {
  it("uses defaults and clamps nonsense: a mistyped value cannot cause a request storm", () => {
    expect(readInboxConfig({})).toEqual(INBOX_DEFAULTS);
    expect(readInboxConfig({ INBOX_POLL_LIST_MS: "20000", INBOX_POLL_CHAT_MS: "3000" })).toEqual({
      listPollMs: 20000,
      chatPollMs: 3000,
    });
    for (const bad of ["0", "10", "1", "-5", "abc", "1.5", "99999999", "", " 5000"])
      expect(readInboxConfig({ INBOX_POLL_LIST_MS: bad, INBOX_POLL_CHAT_MS: bad })).toEqual(
        INBOX_DEFAULTS,
      );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Phase 08E-0.4: how interactive messages are shown to staff (closes the third outstanding Phase 08D condition together with
// interactive.db.test.ts). Pure display functions only; the database side reads real BOT requests. Nothing here changes the
// production display code: where it behaves in a way staff may find surprising, the test pins the CURRENT output and says so.

describe("interactive messages in the Inbox: what staff see", () => {
  // Realistic ids and a token: none of them may ever be shown (an id is `b1.<22-character token>.<option key>`).
  const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
  const rid = (key: string) => `b1.${TOKEN}.${key}`;
  const buttons = {
    v: 1,
    kind: "buttons",
    body: "Choose a topic",
    footer: "Reply to continue",
    buttons: [
      { id: rid("fees"), title: "Fees" },
      { id: rid("timetable"), title: "Timetable" },
      { id: rid("staff"), title: "Talk to staff" },
    ],
  };
  const list = {
    v: 1,
    kind: "list",
    body: "Pick a class",
    footer: "Tap Menu",
    buttonLabel: "Menu",
    sections: [
      {
        title: "Menu",
        rows: [
          { id: rid("theory"), title: "ICT Theory", description: "Tuesday evening" },
          { id: rid("practical"), title: "ICT Practical" },
        ],
      },
    ],
  };
  const sent = (body: string | null, interactive: unknown) =>
    describeMessage({ type: "INTERACTIVE", body, content: { interactive } });

  describe("a bot's outbound buttons and list", () => {
    it("buttons: the body, then the option titles; footer and ids are never shown", () => {
      expect(sent("Choose a topic", buttons)).toEqual({
        text: "Choose a topic · Fees / Timetable / Talk to staff",
        placeholder: "Interactive message",
      });
    });

    it("a list: the body, then every row title across sections; descriptions, section titles, footer and button label are not shown", () => {
      expect(sent("Pick a class", list)).toEqual({
        text: "Pick a class · ICT Theory / ICT Practical",
        placeholder: "Interactive message",
      });
      const two = {
        ...list,
        sections: [
          { title: "Theory", rows: [{ id: rid("t1"), title: "Paper 1" }] },
          { title: "Practical", rows: [{ id: rid("p1"), title: "Lab A" }] },
        ],
      };
      expect(sent("Pick", two).text).toBe("Pick · Paper 1 / Lab A");
    });

    it("Sinhala and Tamil titles are kept, including the zero-width joiner Sinhala spelling needs", () => {
      const sinhala = "ශ්\u200dරී ලංකා";
      const r = sent("තෝරන්න", {
        ...buttons,
        buttons: [
          { id: rid("a"), title: sinhala },
          { id: rid("b"), title: "கட்டணம்" },
        ],
      });
      expect(r.text).toBe(`තෝරන්න · ${sinhala} / கட்டணம்`);
    });

    it("a body-less message shows the options alone, and one with nothing to show has no text at all", () => {
      expect(sent(null, buttons)).toEqual({
        text: "Fees / Timetable / Talk to staff",
        placeholder: "Interactive message",
      });
      expect(sent(null, { ...buttons, buttons: [] })).toEqual({
        text: null,
        placeholder: "Interactive message",
      });
    });
  });

  describe("a customer's reply", () => {
    it("a button reply and a list reply show the title the customer tapped, never the id or the description", () => {
      expect(
        describeMessage({
          type: "INTERACTIVE",
          body: "Fees",
          content: { subtype: "button_reply", id: rid("fees"), title: "Fees" },
        }),
      ).toEqual({ text: "Fees", placeholder: "Interactive reply" });
      expect(
        describeMessage({
          type: "INTERACTIVE",
          body: "ICT Theory",
          content: {
            subtype: "list_reply",
            id: rid("theory"),
            title: "ICT Theory",
            description: "Tuesday evening",
          },
        }),
      ).toEqual({ text: "ICT Theory", placeholder: "Interactive reply" });
    });

    it("a reply stored without a body falls back to the stored title", () => {
      expect(
        describeMessage({
          type: "INTERACTIVE",
          body: null,
          content: { subtype: "button_reply", id: rid("fees"), title: "Fees" },
        }),
      ).toEqual({ text: "Fees", placeholder: "Interactive reply" });
    });

    it("a template quick-reply BUTTON shows its text; its payload (an internal campaign key) is never shown", () => {
      expect(
        describeMessage({
          type: "BUTTON",
          body: "Yes, I am interested",
          content: { payload: "CAMPAIGN_4471_YES", text: "Yes, I am interested" },
        }),
      ).toEqual({ text: "Yes, I am interested", placeholder: "Button reply" });
      expect(
        describeMessage({
          type: "BUTTON",
          body: null,
          content: { payload: "CAMPAIGN_4471_YES", text: "Yes" },
        }),
      ).toEqual({ text: "Yes", placeholder: "Button reply" });
      expect(
        describeMessage({ type: "BUTTON", body: null, content: { payload: "CAMPAIGN_4471_YES" } }),
      ).toEqual({ text: null, placeholder: "Button reply" });
    });
  });

  describe("malformed and incomplete stored content never throws and never shows raw JSON", () => {
    it.each([
      ["no content", null, { text: "Hi", placeholder: "Interactive reply" }],
      ["a non-object content", "oops", { text: "Hi", placeholder: "Interactive reply" }],
      [
        "interactive: a string",
        { interactive: "oops" },
        { text: "Hi", placeholder: "Interactive reply" },
      ],
      [
        "interactive: null",
        { interactive: null },
        { text: "Hi", placeholder: "Interactive reply" },
      ],
      [
        "interactive: an array",
        { interactive: ["a"] },
        { text: "Hi", placeholder: "Interactive reply" },
      ],
      [
        "interactive: a number",
        { interactive: 42 },
        { text: "Hi", placeholder: "Interactive reply" },
      ],
      ["interactive: {}", { interactive: {} }, { text: "Hi", placeholder: "Interactive message" }],
      [
        "buttons that are not a list",
        { interactive: { buttons: "x" } },
        { text: "Hi", placeholder: "Interactive message" },
      ],
      [
        "sections that are not a list",
        { interactive: { sections: "x" } },
        { text: "Hi", placeholder: "Interactive message" },
      ],
      [
        "buttons holding junk and one valid title",
        { interactive: { buttons: [1, null, "x", { title: 5 }, { title: "ok" }] } },
        { text: "Hi · ok", placeholder: "Interactive message" },
      ],
      [
        "sections holding junk and one valid row",
        { interactive: { sections: [null, 5, { rows: "x" }, { rows: [{ title: "A" }, {}] }] } },
        { text: "Hi · A", placeholder: "Interactive message" },
      ],
    ])("%s", (_name, content, expected) => {
      const r = describeMessage({ type: "INTERACTIVE", body: "Hi", content });
      expect(r).toEqual(expected);
      expect(`${r.text} ${r.placeholder}`).not.toMatch(/[{}[\]]|"|buttons|sections/);
    });

    // PINNED CURRENT BEHAVIOUR (reported, not changed): a BOT message whose stored `content.interactive` is unusable is
    // labelled "Interactive reply", the label meant for a CUSTOMER's reply. Unreachable through the approved queue function
    // (it always stores a valid payload) but reachable for a damaged row.
    it("pins: an outbound bot message with unusable content is labelled with the customer-reply placeholder", () => {
      expect(sent("Hi", "oops").placeholder).toBe("Interactive reply");
    });
  });

  describe("truncation and control characters", () => {
    it("an option title is cut to 24 characters (no ellipsis), whitespace collapsed", () => {
      expect(sent("B", { buttons: [{ title: "T".repeat(40) }] }).text).toBe(
        `B · ${"T".repeat(24)}`,
      );
      expect(sent("B", { buttons: [{ title: "A\n\t  B" }] }).text).toBe("B · A B");
    });

    it("control characters, bidirectional overrides, the zero-width space and the BOM are removed from titles and body", () => {
      const dirty = `x${String.fromCharCode(0, 7, 0x1b, 0x202e, 0x2066, 0x200b, 0xfeff)}y`;
      expect(sent(dirty, { buttons: [{ title: dirty }] }).text).toBe("xy · xy");
    });

    it("a lone surrogate becomes the replacement character instead of breaking the output", () => {
      const t = sent("a", { buttons: [{ title: `b${String.fromCharCode(0xd83d)}c` }] }).text!;
      expect(t).toBe("a · b\ufffdc");
      expect(t.isWellFormed()).toBe(true);
    });

    it("the body is cut at 4096 with an ellipsis; the joined option list at 240", () => {
      const body = sent("x".repeat(5000), buttons).text!;
      expect(body.startsWith(`${"x".repeat(4095)}…`)).toBe(true);
      const rows = Array.from({ length: 10 }, (_, i) => ({ title: `R${i}`.padEnd(24, "z") }));
      const joined = rows.map((r) => r.title).join(" / ");
      expect(joined.length).toBeGreaterThan(240);
      expect(sent("Pick", { sections: [{ rows }] }).text).toBe(`Pick · ${joined.slice(0, 240)}`);
    });
  });

  describe("nothing internal is exposed", () => {
    it("no id, token, payload key, campaign key or raw JSON appears in any rendering", () => {
      const outputs = [
        sent("Choose a topic", buttons),
        sent("Pick a class", list),
        describeMessage({
          type: "INTERACTIVE",
          body: "Fees",
          content: { subtype: "button_reply", id: rid("fees"), title: "Fees" },
        }),
        describeMessage({
          type: "INTERACTIVE",
          body: "ICT Theory",
          content: {
            subtype: "list_reply",
            id: rid("theory"),
            title: "ICT Theory",
            description: "d",
          },
        }),
        describeMessage({
          type: "BUTTON",
          body: "Yes",
          content: { payload: "CAMPAIGN_4471_YES", text: "Yes" },
        }),
      ];
      const text = JSON.stringify(outputs);
      for (const secret of [
        TOKEN,
        "b1.",
        "CAMPAIGN_4471",
        'fees"',
        '"kind"',
        '"v":',
        "footer",
        "Reply to continue",
      ])
        expect(text, secret).not.toContain(secret);
    });
  });
});

describe("delivery of a bot's interactive message: every request state and provider status", () => {
  const view = (o: Partial<Parameters<typeof deliveryView>[0]>) =>
    deliveryView({
      requestState: null,
      holdReason: null,
      failureCode: null,
      providerStatus: null,
      providerErrorCode: null,
      ...o,
    });

  it.each([
    ["QUEUED", null, "QUEUED", "Queued", "neutral"],
    ["SENDING", null, "SENDING", "Sending…", "neutral"],
    ["ACCEPTED", null, "ACCEPTED", "Accepted by WhatsApp", "neutral"],
    ["ACCEPTED", "SENT", "SENT", "Sent", "neutral"],
    ["ACCEPTED", "DELIVERED", "DELIVERED", "Delivered", "good"],
    ["ACCEPTED", "READ", "READ", "Read", "good"],
    ["ACCEPTED", "FAILED", "FAILED", "Delivery failed", "error"],
    ["REJECTED", null, "REJECTED", "Rejected by WhatsApp", "error"],
    ["HELD", null, "HELD", "Not sent", "warning"],
    ["UNKNOWN_OUTCOME", null, "UNKNOWN_OUTCOME", "Outcome unknown", "warning"],
  ])(
    "%s with provider status %s shows %s",
    (requestState, providerStatus, phase, label, severity) => {
      expect(
        view({
          requestState,
          providerStatus,
          holdReason: requestState === "HELD" ? "bot_stopped" : null,
          failureCode: requestState === "REJECTED" ? "invalid_request" : null,
        }),
      ).toMatchObject({ phase, label, severity });
    },
  );

  // The provider can only report on a message Meta ACCEPTED (the id is stored at acceptance), so these combinations do not
  // occur in production; the display contract still must never let a provider status override a request that was not accepted.
  it.each(["QUEUED", "SENDING", "REJECTED", "HELD", "UNKNOWN_OUTCOME"] as const)(
    "a provider status cannot override %s",
    (requestState) => {
      const base = view({ requestState, holdReason: "bot_stopped", failureCode: "x" });
      for (const providerStatus of ["SENT", "DELIVERED", "READ", "FAILED"])
        expect(
          view({ requestState, providerStatus, holdReason: "bot_stopped", failureCode: "x" }),
        ).toEqual(base);
    },
  );

  it("a failed delivery names the WhatsApp error code only, and a rejection a plain reason", () => {
    expect(
      view({ requestState: "ACCEPTED", providerStatus: "FAILED", providerErrorCode: "131026" })
        .detail,
    ).toBe("WhatsApp error 131026");
    expect(view({ requestState: "REJECTED", failureCode: "invalid_request" }).detail).toBe(
      "invalid request",
    );
  });

  describe("every reason a bot request can be held", () => {
    // Codes written by the approved bot dispatch (migration 0008's bot_request_hold_code, the claim, the final authorization
    // and enqueue) plus the one the 08E reconciler will write (bot_send_deadline, V3.2 N.1), so the display contract is pinned
    // before the runtime produces it.
    const SHARED = [
      "window_closed",
      "no_inbound",
      "account_inactive",
      "contact_archived",
      "recipient_changed",
      "identity_ambiguous",
      "bsuid_send_unavailable",
      "deadline_passed",
      "outbound_disabled",
    ];
    const BOT_ONLY = [
      "bot_stopped",
      "bot_epoch_superseded",
      "bot_deployment_inactive",
      "bot_archived",
      "bot_output_suppressed",
      "bot_session_ended",
      "bot_step_superseded",
      "staff_took_over",
      "conversation_resolved",
      "bot_state_unreadable",
      "bots_runtime_disabled",
      "payload_invalid",
      "bot_send_deadline",
    ];

    it.each(SHARED)("%s uses the curated wording shared with staff messages", (code) => {
      expect(HOLD_REASONS[code], code).toBeDefined();
      expect(view({ requestState: "HELD", holdReason: code })).toEqual({
        phase: "HELD",
        label: "Not sent",
        severity: "warning",
        detail: `Not sent: ${HOLD_REASONS[code]}.`,
      });
    });

    // PINNED CURRENT BEHAVIOUR (reported, not changed): the bot-only codes have NO curated wording, so staff see the code with
    // its underscores replaced by spaces ("Not sent: bot epoch superseded."). Readable, never raw JSON or an id, but jargon.
    it.each(BOT_ONLY)("%s falls back to the code's words", (code) => {
      expect(HOLD_REASONS[code]).toBeUndefined();
      expect(view({ requestState: "HELD", holdReason: code })).toEqual({
        phase: "HELD",
        label: "Not sent",
        severity: "warning",
        detail: `Not sent: ${code.replace(/_/g, " ")}.`,
      });
    });

    it("whatever the code, the held display is a warning that says nothing was sent and exposes no identifier", () => {
      for (const code of [...SHARED, ...BOT_ONLY]) {
        const v = view({ requestState: "HELD", holdReason: code });
        expect(v.detail, code).not.toMatch(/_|b1\.|[0-9a-f]{8}-[0-9a-f]{4}/);
        expect(v.detail, code).toMatch(/^Not sent: /);
      }
    });
  });
});
