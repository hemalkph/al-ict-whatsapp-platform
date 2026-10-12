import { describe, expect, it } from "vitest";
import { INBOX_DEFAULTS, readInboxConfig } from "./config";
import { decodeCursor, encodeCursor } from "./cursor";
import {
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
