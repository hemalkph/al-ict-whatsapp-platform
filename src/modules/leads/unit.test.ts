import { describe, expect, it } from "vitest";
import { schema } from "@/db";
import { toErrorResponse, ValidationError } from "@/shared/errors/http-errors";
import { decodeCursor, encodeCursor, isCalendarTimestamp } from "./cursor";
import {
  clickIdTail,
  contactLabel,
  displayLink,
  identifierTail,
  safeLine,
  safeText,
  sourceLabel,
} from "./display";
import {
  OPEN_LEAD_INDEX,
  LeadConflictError,
  alreadyOpen,
  contactArchived,
  isOpenLeadConflict,
  pgCode,
  reservedStatus,
  staleLead,
} from "./errors";
import { sourceSummary } from "./items";
import { likePattern, listLeads } from "./list";
import { listLeadEvents } from "./history";
import type { AccessContext } from "@/modules/access";
import {
  ALL_LEAD_STATUSES,
  isOpenStatus,
  isReserved,
  isStaffSettable,
  planTransition,
} from "./rules";
import {
  createLeadSchema,
  eventsQuerySchema,
  fieldsOf,
  listQuerySchema,
  parseOrThrow,
  statusChangeSchema,
} from "./schemas";

// Database-free tests of the lead rules, the schemas, the display helpers, the cursor and the error mapping.

describe("lifecycle rules", () => {
  it("the ten statuses are partitioned exactly as the schema says", () => {
    expect([...ALL_LEAD_STATUSES].sort()).toEqual([...schema.LEAD_STATUSES].sort());
    for (const s of ALL_LEAD_STATUSES) {
      expect(isOpenStatus(s), s).toBe((schema.OPEN_LEAD_STATUSES as readonly string[]).includes(s));
      expect(isStaffSettable(s), s).toBe(
        (schema.STAFF_SETTABLE_LEAD_STATUSES as readonly string[]).includes(s),
      );
      expect(isReserved(s), s).toBe(
        (schema.RESERVED_LEAD_STATUSES as readonly string[]).includes(s),
      );
    }
    expect([...schema.STAFF_SETTABLE_LEAD_STATUSES].sort()).toEqual([
      "INTERESTED",
      "INVALID",
      "NEW",
      "NOT_INTERESTED",
      "NO_RESPONSE",
      "QUALIFIED",
    ]);
    expect(isReserved("UNKNOWN")).toBe(true); // anything not settable fails closed
  });

  it("a transition is a no-op, a close, a reopen or a move between statuses of the same kind", () => {
    const settable = schema.STAFF_SETTABLE_LEAD_STATUSES;
    for (const from of settable)
      for (const to of settable) {
        const plan = planTransition(from, to).kind;
        if (from === to) expect(plan).toBe("noop");
        else if (isOpenStatus(from) && !isOpenStatus(to)) expect(plan).toBe("close");
        else if (!isOpenStatus(from) && isOpenStatus(to)) expect(plan).toBe("reopen");
        else expect(plan).toBe("move");
      }
    expect(planTransition("NEW", "INTERESTED").kind).toBe("move");
    expect(planTransition("NO_RESPONSE", "INVALID").kind).toBe("move");
    expect(planTransition("NO_RESPONSE", "NEW").kind).toBe("reopen");
    expect(planTransition("QUALIFIED", "NOT_INTERESTED").kind).toBe("close");
  });
});

describe("input schemas", () => {
  const uuid = "6f1c4d0a-8b5e-4a57-9d34-0c2d9a1b7e11";

  it("creation takes a contact id and nothing else", () => {
    expect(createLeadSchema.safeParse({ contactId: uuid }).success).toBe(true);
    for (const body of [
      {},
      { contactId: "x" },
      { contactId: uuid, cycleStartedAt: "2020-01-01T00:00:00Z" },
      { contactId: uuid, status: "NEW" },
      { contactId: uuid, revision: 0 },
      null,
      [],
      "x",
    ])
      expect(createLeadSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });

  it("a status change takes a settable target and the revision seen, nothing else", () => {
    for (const to of schema.STAFF_SETTABLE_LEAD_STATUSES)
      expect(statusChangeSchema.safeParse({ to, expectedRevision: 0 }).success, to).toBe(true);
    for (const to of schema.RESERVED_LEAD_STATUSES)
      expect(statusChangeSchema.safeParse({ to, expectedRevision: 0 }).success, to).toBe(false);
    for (const body of [
      { to: "NEW" },
      { expectedRevision: 1 },
      { to: "NEW", expectedRevision: -1 },
      { to: "NEW", expectedRevision: 1.5 },
      { to: "NEW", expectedRevision: "1" },
      { to: "NEW", expectedRevision: 2 ** 31 },
      { to: "NEW", expectedRevision: 1, closedAt: "2020-01-01" },
      { to: "NEW", expectedRevision: 1, from: "NEW" },
    ])
      expect(statusChangeSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    expect(statusChangeSchema.safeParse({ to: "NEW", expectedRevision: 2 ** 31 - 1 }).success).toBe(
      true,
    );
  });

  it("list queries are bounded: page size 1..50 (default 30), search 2..64 characters after trimming, known keys only", () => {
    expect(listQuerySchema.parse({}).limit).toBe(30);
    expect(listQuerySchema.parse({ limit: "50" }).limit).toBe(50);
    expect(listQuerySchema.parse({ q: "  ab  " }).q).toBe("ab");
    for (const query of [
      { limit: "0" },
      { limit: "51" },
      { limit: "1.5" },
      { q: "a" },
      { q: "x".repeat(65) },
      { state: "everything" },
      { attribution: "organic" },
      { status: "NOPE" },
      { organizationId: uuid },
    ])
      expect(listQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    for (const status of schema.LEAD_STATUSES)
      expect(listQuerySchema.safeParse({ status }).success).toBe(true);
    expect(eventsQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(eventsQuerySchema.safeParse({ q: "ab" }).success).toBe(false);
  });

  it("validation reports field NAMES only: an unknown key by its (plain) name, never a value", () => {
    const parsed = createLeadSchema.safeParse({
      contactId: uuid,
      cycleStartedAt: "SECRET-VALUE",
      "weird key!": 1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const fields = fieldsOf(parsed.error.issues);
      expect(fields).toContain("cycleStartedAt");
      expect(fields).toContain("body"); // a key that is not a plain identifier is not echoed
      expect(JSON.stringify(fields)).not.toContain("SECRET-VALUE");
      expect(JSON.stringify(fields)).not.toContain("weird");
    }
    expect(() =>
      parseOrThrow(statusChangeSchema.safeParse({ to: "PAID", expectedRevision: 0 })),
    ).toThrow(ValidationError);
  });
});

describe("search patterns", () => {
  it("LIKE wildcards and the escape character are literal", () => {
    expect(likePattern("100%_x\\", "contains")).toBe("%100\\%\\_x\\\\%");
    expect(likePattern("9477", "prefix")).toBe("9477%");
  });
});

describe("cursors", () => {
  const id = "6f1c4d0a-8b5e-4a57-9d34-0c2d9a1b7e11";
  it("round-trip with microsecond text, and anything else is refused", () => {
    const cursor = { t: "2026-03-01T10:00:00.000123Z", id };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    const forge = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const bad of [
      "",
      "garbage",
      "x".repeat(201),
      "a b",
      forge({ t: "2026-03-01T10:00:00.123Z", id }), // milliseconds only
      forge({ t: "2026-03-01T10:00:00.000123Z", id: "x" }),
      forge({ t: "2026-03-01T10:00:00.000123Z", id, extra: 1 }),
      forge("x"),
    ])
      expect(decodeCursor(bad), bad).toBeNull();
  });
});

describe("display of untrusted text", () => {
  it("removes control, bidirectional and zero-width-space characters, keeps Sinhala joiners, and is bounded", () => {
    expect(safeText("a\u0000b\u0007c\u202Ed\u2066e\u200Bf\uFEFFg", 50)).toBe("abcdefg");
    const sinhala = "ශ්\u200Dරී"; // contains a zero-width joiner, which Sinhala needs
    expect(safeText(sinhala, 50)).toBe(sinhala);
    expect(safeText("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(safeText(5, 10)).toBe("");
    expect(safeText("lone \ud800 surrogate", 50).isWellFormed()).toBe(true);
    expect(safeLine("  a \n\t b  ", 20)).toBe("a b");
    expect(safeLine("x".repeat(500), 40)).toHaveLength(40);
  });

  it("labels a contact by its name, else its username, else 'Unnamed contact', with a short identifier tail", () => {
    expect(
      contactLabel({ profileName: "Kamal", username: "k", waId: "94771234567", bsuid: null }),
    ).toEqual({
      displayName: "Kamal",
      named: true,
      idHint: "…4567",
    });
    expect(
      contactLabel({ profileName: null, username: "ict_teacher", waId: null, bsuid: "US.1234567" }),
    ).toEqual({
      displayName: "ict_teacher",
      named: true,
      idHint: "…4567",
    });
    expect(
      contactLabel({ profileName: " \u202E ", username: null, waId: "12", bsuid: null }),
    ).toEqual({
      displayName: "Unnamed contact",
      named: false,
      idHint: null,
    });
  });

  it("provider links become origin and path only, and only when they are plain http(s) links", () => {
    expect(displayLink("https://fb.me/abc?utm=x#y")).toBe("https://fb.me/abc");
    expect(displayLink("http://example.test")).toBe("http://example.test/");
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<b>",
      "file:///etc/passwd",
      "ftp://x.test/a",
      "https://user:pw@x.test/a",
      "https://x.test/" + "p".repeat(300),
      "not a url",
      "",
      "https://x.test/" + "q".repeat(3000),
      null,
      5,
    ])
      expect(displayLink(bad), String(bad).slice(0, 40)).toBeNull();
  });

  it("the click id is never returned: at most its last four characters, and only for a long id", () => {
    expect(clickIdTail("ARAkLkA8rmlFeiCktEJQ")).toBe("…tEJQ");
    expect(clickIdTail("ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDL")).toBe("…AFDL");
    expect(clickIdTail("shortid")).toBeNull();
    expect(clickIdTail(null)).toBeNull();
    expect(clickIdTail(123456789012)).toBeNull();
  });

  it("source labels say what is stored and never guess or invent an origin", () => {
    expect(sourceLabel("META_AD")).toBe("Meta ad");
    expect(sourceLabel("FACEBOOK_AD")).toBe("Facebook ad");
    expect(sourceLabel("something_new")).toBe("Referral");
    for (const type of schema.ATTRIBUTION_SOURCE_TYPES) expect(sourceLabel(type)).toBeTruthy();
  });

  it("a source summary is 'Meta ad' only for linked ad touches, and 'no advertisement referral recorded' otherwise (never 'organic')", () => {
    const none = sourceSummary({ adTouches: 0, linkedTouches: 0, first: null, latest: null });
    expect(none).toMatchObject({ kind: "NONE", label: "No advertisement referral recorded" });
    expect(
      sourceSummary({ adTouches: 2, linkedTouches: 2, first: new Date(0), latest: new Date(1000) }),
    ).toMatchObject({
      kind: "META_AD",
      label: "Meta ad",
      firstReceivedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(sourceSummary({ adTouches: 0, linkedTouches: 1, first: null, latest: null }).kind).toBe(
      "OTHER_REFERRAL",
    );
    expect(JSON.stringify([none])).not.toMatch(/organic/i);
  });
});

describe("errors", () => {
  it("conflicts are 409 with a fixed code and message, and the reason is not part of the response", async () => {
    const all: Array<[LeadConflictError, string]> = [
      [staleLead(), "STALE_STATE"],
      [alreadyOpen(), "ALREADY_OPEN"],
      [contactArchived(), "CONTACT_ARCHIVED"],
      [reservedStatus(), "RESERVED_STATUS"],
    ];
    for (const [error, code] of all) {
      const res = toErrorResponse(error);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe(code);
      expect(JSON.stringify(body)).not.toContain(error.reason);
    }
  });

  it("only the one-open-lead index violation is the 'already open' backstop; no raw database error is a client error", () => {
    const violation = (code: string, constraint: string) => ({ cause: { code, constraint } });
    expect(isOpenLeadConflict(violation("23505", OPEN_LEAD_INDEX))).toBe(true);
    expect(isOpenLeadConflict(violation("23505", "leads_pkey"))).toBe(false);
    expect(isOpenLeadConflict(violation("23514", OPEN_LEAD_INDEX))).toBe(false);
    expect(isOpenLeadConflict(new Error("x"))).toBe(false);
    expect(isOpenLeadConflict(null)).toBe(false);
    expect(pgCode({ cause: { cause: { code: "40P01" } } })).toBe("40P01");
    expect(pgCode({ code: "not a code" })).toBeNull();
  });
});

describe("cursor timestamps are real instants (review B-M2)", () => {
  const id = "6f1c4d0a-8b5e-4a57-9d34-0c2d9a1b7e11";
  const cursorAt = (t: string) => Buffer.from(JSON.stringify({ t, id })).toString("base64url");

  it("a real month, day, hour, minute and second are accepted, microseconds exactly as PostgreSQL wrote them", () => {
    for (const t of [
      "2026-03-01T10:00:00.000123Z",
      "2026-12-31T23:59:59.999999Z",
      "2026-01-01T00:00:00.000000Z",
      "2024-02-29T12:00:00.000001Z", // leap year
      "2000-02-29T00:00:00.000000Z", // divisible by 400: leap
      "2026-04-30T01:02:03.456789Z",
      "0001-01-01T00:00:00.000000Z",
    ]) {
      expect(isCalendarTimestamp(t), t).toBe(true);
      expect(decodeCursor(cursorAt(t)), t).toEqual({ t, id });
    }
    // the text is returned untouched: nothing is converted through a Date
    expect(decodeCursor(cursorAt("2026-03-01T10:00:00.000123Z"))!.t).toBe(
      "2026-03-01T10:00:00.000123Z",
    );
  });

  it("an impossible month, day, hour, minute or second is refused before it can reach PostgreSQL", () => {
    for (const t of [
      "2026-99-99T25:61:61.000000Z", // the reviewer's reproduction
      "2026-00-10T10:00:00.000000Z",
      "2026-13-10T10:00:00.000000Z",
      "2026-01-00T10:00:00.000000Z",
      "2026-01-32T10:00:00.000000Z",
      "2026-04-31T10:00:00.000000Z",
      "2026-06-31T10:00:00.000000Z",
      "2026-02-29T10:00:00.000000Z", // 2026 is not a leap year
      "2100-02-29T10:00:00.000000Z", // divisible by 100 but not 400
      "2026-02-30T10:00:00.000000Z",
      "2026-01-01T24:00:00.000000Z",
      "2026-01-01T25:00:00.000000Z",
      "2026-01-01T10:60:00.000000Z",
      "2026-01-01T10:00:60.000000Z",
      "2026-01-01T10:00:99.000000Z",
      "0000-01-01T00:00:00.000000Z", // there is no year 0
      "2026-01-01T10:00:00.123Z", // milliseconds only
      "2026-01-01 10:00:00.000000Z",
    ]) {
      expect(isCalendarTimestamp(t), t).toBe(false);
      expect(decodeCursor(cursorAt(t)), t).toBeNull();
    }
  });

  it("equal timestamps are told apart by the id: both cursors are valid and different", () => {
    const t = "2026-03-01T10:00:00.000999Z";
    const other = "7a1c4d0a-8b5e-4a57-9d34-0c2d9a1b7e11";
    const a = encodeCursor({ t, id });
    const b = encodeCursor({ t, id: other });
    expect(a).not.toBe(b);
    expect(decodeCursor(a)).toEqual({ t, id });
    expect(decodeCursor(b)).toEqual({ t, id: other });
  });

  it("a bad cursor is a validation error in the list and the history, never a database error", async () => {
    const ctx = {
      userId: "u",
      membershipId: "m",
      organizationId: "o",
      role: "VIEWER",
      can: () => true,
    } as unknown as AccessContext;
    const never = { execute: () => Promise.reject(new Error("reached the database")) } as never;
    const bad = cursorAt("2026-99-99T25:61:61.000000Z");
    await expect(listLeads(ctx, { cursor: bad }, { db: never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      listLeadEvents(ctx, "6f1c4d0a-8b5e-4a57-9d34-0c2d9a1b7e11", { cursor: bad }, { db: never }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("identifier tails are cleaned before they are cut (review B-L1)", () => {
  it("a bidirectional override or control character at the end never reaches the response", () => {
    const base = "ARAkLkA8rmlFeiCktEJQ";
    for (const bad of [
      "\u202E",
      "\u2066",
      "‎",
      "‏",
      "؜",
      "\u0007",
      "\u0000",
      "\u007F",
      "\u0085",
      " ",
      "\uFEFF",
      "\u200B",
      "\n",
      "\t",
      " ",
    ]) {
      const tail = clickIdTail(`${base}${bad}`)!;
      expect(tail, JSON.stringify(bad)).toBe("…tEJQ");
      // and in the middle of the last characters
      expect(clickIdTail(`${base.slice(0, -2)}${bad}${base.slice(-2)}`), JSON.stringify(bad)).toBe(
        "…tEJQ",
      );
      // and a run of them
      expect(clickIdTail(`${base}${bad}${bad}${bad}`)).toBe("…tEJQ");
    }
  });

  it("an ordinary identifier shows its last four characters, a short one nothing, and the full value never", () => {
    const clid = "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDL";
    expect(clickIdTail(clid)).toBe("…AFDL");
    expect(clickIdTail(clid)).not.toContain("QTwRiy");
    expect(clickIdTail("123456789012")).toBe("…9012"); // the shortest that is shown
    expect(clickIdTail("12345678901")).toBeNull();
    expect(clickIdTail("shortid")).toBeNull();
    expect(clickIdTail("")).toBeNull();
    expect(clickIdTail(null)).toBeNull();
    expect(clickIdTail(undefined)).toBeNull();
    expect(clickIdTail(12345678901234)).toBeNull();
    // too short only once the unsafe characters are gone: nothing is shown, rather than a tail of padding
    expect(
      clickIdTail("\u202E\u202E\u202E\u202E\u202E\u202E\u202E\u202E\u202E\u202E\u202E\u202Eab"),
    ).toBeNull();
  });

  it("is cut by whole characters, keeps Sinhala and Tamil (with their joiners), and stays well-formed", () => {
    const sinhala = "id-0123456789-ශ්\u200Dරී"; // ends with the Sinhala 'shri' conjunct, which needs a ZWJ
    expect(identifierTail(sinhala, 2, 1)).toBe("…ශ්\u200Dරී"); // two user-perceived characters, joiner kept
    expect(identifierTail(sinhala, 3, 1)).toBe("…-ශ්\u200Dරී");
    expect(identifierTail("id-0123456789-தமிழ்", 3, 1)).toBe("…தமிழ்");
    // an emoji (a surrogate pair) is not split in half
    expect(identifierTail("abcdefghijkl😀😀", 2, 1)).toBe("…😀😀");
    expect(clickIdTail("abcdefghijkl\ud800")!.isWellFormed()).toBe(true);
  });

  it("the same cleaning applies to the contact's identifier hint, and the stored value is never modified by display", () => {
    expect(
      contactLabel({ profileName: null, username: null, waId: "94771234567\u202E", bsuid: null })
        .idHint,
    ).toBe("…4567");
    expect(
      contactLabel({
        profileName: null,
        username: null,
        waId: null,
        bsuid: "US.123456\u202E\u0007",
      }).idHint,
    ).toBe("…3456");
    const stored = "ARAkLkA8rmlFeiCktEJQ\u202E";
    const copy = stored.slice();
    clickIdTail(stored);
    expect(stored).toBe(copy);
    expect(stored.endsWith("\u202E")).toBe(true);
  });

  it("the shared safe-text policy also removes the other bidirectional marks and line separators, and keeps joiners", () => {
    expect(safeText("a‎b‏c؜d e f", 50)).toBe("abcdef");
    expect(safeText("\u200Dx\u200C", 50)).toBe("\u200Dx\u200C");
  });
});
