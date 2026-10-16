import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContactLeads, CreateLeadResult, LeadItem } from "@/modules/leads";
import { ApiError } from "../leads/lead-api";
import {
  acceptCreateResult,
  createLeadPanelController,
  isContactLeads,
} from "./lead-panel-controller";
import { isUuid } from "../leads/[id]/lead-response";

// Deterministic races: every request the controller makes is held until the test resolves (or rejects) it, in any order.
// Fixtures follow the real contract (src/modules/leads/types.ts, for-contact.ts, create.ts).

const AT = "2026-01-01T00:00:00.000Z";
// Lead ids are UUIDs (the controller refuses anything else); tests name leads "L1", "N1"… and `uid` makes the UUID of a name.
const NAMES = new Map<string, string>();
const uid = (name: string) => {
  const id = `00000000-0000-4000-8000-${Buffer.from(name).toString("hex").padStart(12, "0").slice(-12)}`;
  NAMES.set(id, name);
  return id;
};
const label = { displayName: "Amaya", named: true, idHint: null };
const lead = (contactId: string, id: string, o: Partial<LeadItem> = {}): LeadItem => ({
  id: uid(id),
  status: "NEW",
  revision: 0,
  open: true,
  readOnly: false,
  createdAt: AT,
  createdKey: AT,
  statusChangedAt: AT,
  cycleStartedAt: AT,
  contact: { id: contactId, label, archived: false },
  source: {
    kind: "NONE",
    label: "No advertisement referral recorded",
    adTouches: 0,
    linkedTouches: 0,
    firstReceivedAt: null,
    latestReceivedAt: null,
  },
  ...o,
});
const closed = (c: string, id: string) =>
  lead(c, id, { status: "NOT_INTERESTED", open: false, revision: 1 });
const leadsOf = (
  contactId: string,
  o: { open?: LeadItem | null; leads?: LeadItem[]; create?: boolean; archived?: boolean } = {},
): ContactLeads => {
  const open = o.open === undefined ? null : o.open;
  const leads = o.leads ?? (open ? [open] : []);
  return {
    contact: { id: contactId, label, archived: o.archived ?? false },
    openLead: open,
    leads,
    can: { create: o.create ?? (!open && !o.archived) },
  };
};
const created = (c: string, id = "N1"): CreateLeadResult => ({ created: true, lead: lead(c, id) });
const existing = (c: string, id = "O1"): CreateLeadResult => ({
  created: false,
  lead: lead(c, id, { status: "QUALIFIED", revision: 3 }),
});

type Held<T> = { resolve: (v: T) => void; reject: (e: unknown) => void; signal: AbortSignal };

function harness() {
  const reads: (Held<ContactLeads> & { contactId: string })[] = [];
  const creates: (Held<CreateLeadResult> & { contactId: string })[] = [];
  let actorChanged = false;
  const ctl = createLeadPanelController({
    fetchContactLeads: (contactId, { signal }) =>
      new Promise((resolve, reject) => reads.push({ contactId, signal, resolve, reject })),
    createLead: (contactId, { signal }) =>
      new Promise((resolve, reject) => creates.push({ contactId, signal, resolve, reject })),
    isActorChanged: () => actorChanged,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const st = () => ctl.getState();
  const shown = () => st().data?.leads.map((l) => NAMES.get(l.id) ?? l.id) ?? null;
  return { ctl, reads, creates, flush, st, shown, changeActor: () => (actorChanged = true) };
}
/** A contact selected and read, ready to create. */
async function ready(contactId = "A", data = leadsOf(contactId)) {
  const h = harness();
  h.ctl.select(contactId);
  h.reads.at(-1)!.resolve(data);
  await h.flush();
  return h;
}

describe("showing a contact's leads", () => {
  it("nothing is requested and nothing offered without a contact", () => {
    const h = harness();
    h.ctl.select(null);
    h.ctl.refresh();
    h.ctl.create();
    expect(h.reads).toHaveLength(0);
    expect(h.creates).toHaveLength(0);
    expect(h.st()).toMatchObject({ contactId: null, data: null, phase: "idle" });
  });

  it("an open lead, previous closed leads and the permission come from the read", async () => {
    const open = lead("A", "L2", { status: "QUALIFIED" });
    const h = await ready("A", leadsOf("A", { open, leads: [open, closed("A", "L1")] }));
    expect(h.reads[0]!.contactId).toBe("A");
    expect(h.st()).toMatchObject({ phase: "ready", readError: null });
    expect(h.st().data?.openLead?.id).toBe(uid("L2"));
    expect(h.shown()).toEqual(["L2", "L1"]);
    expect(h.st().data?.can.create).toBe(false);
  });

  it("no lead at all is an empty, ready state; a failed read is NOT that state", async () => {
    const h = await ready("A");
    expect(h.st()).toMatchObject({ phase: "ready", readError: null });
    expect(h.shown()).toEqual([]);
    const g = harness();
    g.ctl.select("A");
    g.reads[0]!.reject(new ApiError(500, "INTERNAL_ERROR"));
    await g.flush();
    expect(g.st()).toMatchObject({ data: null, readError: { next: "retry" } });
    g.ctl.refresh(); // Retry: a read
    g.reads[1]!.resolve(leadsOf("A"));
    await g.flush();
    expect(g.st()).toMatchObject({ phase: "ready", readError: null });
  });

  it("a refresh that fails keeps the leads already shown", async () => {
    const h = await ready("A", leadsOf("A", { leads: [closed("A", "L1")] }));
    h.ctl.refresh();
    expect(h.st().phase).toBe("loading");
    h.reads[1]!.reject(new ApiError(0, "NETWORK"));
    await h.flush();
    expect(h.shown()).toEqual(["L1"]);
    expect(h.st()).toMatchObject({ phase: "ready", readError: { next: "retry" } });
  });

  it("404 (missing or another organization's contact) is unavailable, not empty, and says nothing about whose it is", async () => {
    const h = harness();
    h.ctl.select("A");
    h.reads[0]!.reject(new ApiError(404, "NOT_FOUND"));
    await h.flush();
    expect(h.st()).toMatchObject({ data: null, readError: { kind: "not_found", next: "none" } });
  });

  it("a viewer (can.create false, no open lead, not archived) is offered nothing to create", async () => {
    const h = await ready("A", leadsOf("A", { create: false }));
    h.ctl.create();
    expect(h.creates).toHaveLength(0);
  });

  it("an archived contact cannot be used to create (the server says can.create false)", async () => {
    const h = await ready("A", leadsOf("A", { archived: true }));
    expect(h.st().data?.contact.archived).toBe(true);
    h.ctl.create();
    expect(h.creates).toHaveLength(0);
  });
});

describe("a read is applied only for the contact shown now, from the newest read", () => {
  it("A -> B: A's late answer (success or failure) never reaches B", async () => {
    const h = harness();
    h.ctl.select("A");
    h.ctl.select("B");
    expect(h.reads[0]!.signal.aborted).toBe(true);
    h.reads[0]!.resolve(leadsOf("A", { leads: [closed("A", "LA")] }));
    await h.flush();
    expect(h.st()).toMatchObject({ contactId: "B", data: null, phase: "loading" });
    h.reads[0]!.reject(new ApiError(500, "INTERNAL_ERROR"));
    await h.flush();
    expect(h.st().readError).toBeNull();
    h.reads[1]!.resolve(leadsOf("B", { leads: [closed("B", "LB")] }));
    await h.flush();
    expect(h.shown()).toEqual(["LB"]);
  });

  it("A -> B -> A: the first read of A is outdated even though A is shown again", async () => {
    const h = harness();
    h.ctl.select("A");
    h.ctl.select("B");
    h.ctl.select("A");
    expect(h.reads.map((r) => r.contactId)).toEqual(["A", "B", "A"]);
    h.reads[0]!.resolve(leadsOf("A", { leads: [closed("A", "OLD")] }));
    await h.flush();
    expect(h.st()).toMatchObject({ contactId: "A", data: null, phase: "loading" });
    h.reads[1]!.resolve(leadsOf("B", { leads: [closed("B", "LB")] }));
    await h.flush();
    expect(h.st().data).toBeNull();
    h.reads[2]!.resolve(leadsOf("A", { leads: [closed("A", "NEW")] }));
    await h.flush();
    expect(h.shown()).toEqual(["NEW"]);
  });

  it("an answer that names another contact is refused even from the current read (the second lock)", async () => {
    const h = harness();
    h.ctl.select("A");
    h.reads[0]!.resolve(leadsOf("B"));
    await h.flush();
    expect(h.st()).toMatchObject({ data: null, readError: { next: "retry" } });
    const g = harness();
    g.ctl.select("A");
    g.reads[0]!.resolve({ ...leadsOf("A"), leads: [closed("B", "X")] });
    await g.flush();
    expect(g.st().data).toBeNull();
  });

  it("closing the conversation hides the previous contact's leads and drops its late answer", async () => {
    const h = await ready("A", leadsOf("A", { leads: [closed("A", "LA")] }));
    h.ctl.refresh();
    h.ctl.select(null);
    expect(h.st()).toMatchObject({ contactId: null, data: null });
    h.reads[1]!.resolve(leadsOf("A"));
    await h.flush();
    expect(h.st().data).toBeNull();
  });

  it("two conversations of the same contact: re-opening reads afresh (the Inbox passes null in between)", async () => {
    const h = await ready("A");
    h.ctl.select(null);
    h.ctl.select("A");
    expect(h.reads).toHaveLength(2);
    h.ctl.select("A"); // a re-render with the same contact asks nothing more
    expect(h.reads).toHaveLength(2);
  });

  it("a newer refresh supersedes an older one", async () => {
    const h = await ready("A");
    h.ctl.refresh();
    h.ctl.refresh();
    h.reads[2]!.resolve(leadsOf("A", { leads: [closed("A", "NEWER")] }));
    await h.flush();
    h.reads[1]!.resolve(leadsOf("A", { leads: [closed("A", "OLDER")] }));
    await h.flush();
    expect(h.shown()).toEqual(["NEWER"]);
  });
});

// What is not a lead id. "\uD800" is a lone surrogate: a string by type, and encodeURIComponent throws "URI malformed" on it.
const BAD_IDS: [string, unknown][] = [
  ["empty", ""],
  ["a lone surrogate", "\uD800"],
  ["a surrogate in a UUID", "00000000-0000-4000-8000-00000000000\uD800"],
  ["not a UUID", "lead-1"],
  ["a UUID with a trailing newline", "00000000-0000-4000-8000-000000000001\n"],
  ["a UUID with padding", " 00000000-0000-4000-8000-000000000001"],
  ["a UUID with a wrong variant", "00000000-0000-4000-c000-000000000001"],
  ["a UUID with a wrong version", "00000000-0000-9000-8000-000000000001"],
  ["a number", 7],
  ["null", null],
  ["undefined", undefined],
  ["an object", { toString: () => "00000000-0000-4000-8000-000000000001" }],
];

describe("lead identifiers follow the backend's z.uuid() contract", () => {
  it.each([
    "6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2b",
    "6F1C2A3E-9B4D-4E5F-8A6B-7C8D9E0F1A2B",
    "018f3c1e-7a2b-7c3d-9e4f-5a6b7c8d9e0f",
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
  ])("accepts %s", (id) => expect(isUuid(id)).toBe(true));
  it.each(BAD_IDS)("refuses %s", (_name, id) => expect(isUuid(id)).toBe(false));
  it.each([
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
    "ffffffff-FFFF-ffff-ffff-ffffffffffff",
    "00000000-0000-0000-0000-000000000001",
    "6f1c2a3e-9b4d-0e5f-8a6b-7c8d9e0f1a2b",
    "6f1c2a3e-9b4d-9e5f-8a6b-7c8d9e0f1a2b",
    "6f1c2a3e-9b4d-4e5f-7a6b-7c8d9e0f1a2b",
    "6f1c2a3e-9b4d-4e5f-ca6b-7c8d9e0f1a2b",
  ])("refuses %s (not a UUID zod accepts)", (id) => expect(isUuid(id)).toBe(false));
  it("is the same set as the backend's schema over boundary samples (zod's z.uuid(), not a guess)", async () => {
    const { uuid } = await import("@/modules/leads/schemas");
    const hex = "0123456789abcdefABCDEF";
    const at = (i: number, ch: string, id = "6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2b") =>
      id.slice(0, i) + ch + id.slice(i + 1);
    const samples: unknown[] = [
      ...BAD_IDS.map(([, v]) => v),
      "6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2b",
      "6F1C2A3E-9B4D-4E5F-8A6B-7C8D9E0F1A2B",
      "6f1c2A3E-9b4d-4E5f-8a6B-7c8d9E0f1a2b",
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-0000-0000-000000000001",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      "ffffffff-FFFF-ffff-ffff-ffffffffffff",
      "fffffffF-ffff-ffff-ffff-ffffffffffff",
      "ffffffff-ffff-ffff-ffff-fffffffffffe",
      "6f1c2a3e9b4d4e5f8a6b7c8d9e0f1a2b",
      "{6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2b}",
      "urn:uuid:6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2b",
      "6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2b ",
      "6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2b\n",
      "\t6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2b",
      "6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2bb",
      "6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2",
      "6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2\u0662",
      "6f1c2a3e-9b4d-4e5f-8a6b-7c8d9e0f1a2\uD800",
      "\uD83D\uDE00",
      [],
      true,
      12,
    ];
    for (const v of "0123456789abcdefABCDEF") {
      samples.push(at(14, v), at(19, v)); // every version digit and every variant digit
    }
    for (const ch of hex + "gG-\uD800 ") samples.push(at(0, ch), at(35, ch), at(8, ch), at(13, ch));
    for (const v of samples) expect(isUuid(v), String(v)).toBe(uuid.safeParse(v).success);
    // the two cases the previous (case-insensitive) pattern got wrong
    expect(isUuid("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF")).toBe(false);
    expect(isUuid("ffffffff-FFFF-ffff-ffff-ffffffffffff")).toBe(false);
    expect(isUuid("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(true);
  });
});

describe("validating what a read says", () => {
  const ok = leadsOf("A", { open: lead("A", "L1"), leads: [lead("A", "L1"), closed("A", "L0")] });
  it("accepts the contract, including null openLead and an empty list", () => {
    expect(isContactLeads(ok, "A")).toBe(true);
    expect(isContactLeads(leadsOf("A"), "A")).toBe(true);
  });
  const bad: [string, unknown][] = [
    ["null", null],
    ["no contact", { ...ok, contact: null }],
    ["another contact", { ...ok, contact: { ...ok.contact, id: "B" } }],
    ["archived not a boolean", { ...ok, contact: { ...ok.contact, archived: "no" } }],
    ["leads not a list", { ...ok, leads: {} }],
    ["a null lead", { ...ok, leads: [null] }],
    ["a lead without an id", { ...ok, leads: [{ ...lead("A", "x"), id: undefined }] }],
    ["an unknown status", { ...ok, leads: [{ ...lead("A", "x"), status: "BOGUS" }] }],
    ["a created time that is not text", { ...ok, leads: [{ ...lead("A", "x"), createdAt: 1 }] }],
    [
      "an unknown source kind",
      { ...ok, leads: [{ ...lead("A", "x"), source: { kind: "__proto__" } }] },
    ],
    ["an open lead that is closed", { ...ok, openLead: closed("A", "c") }],
    ["an open lead of another contact", { ...ok, openLead: lead("B", "x") }],
    ...BAD_IDS.flatMap(([n, id]): [string, unknown][] => [
      [`openLead.id ${n}`, { ...ok, openLead: { ...lead("A", "x"), id } }],
      [`leads[].id ${n}`, { ...ok, leads: [lead("A", "L1"), { ...lead("A", "x"), id }] }],
    ]),
    ["can missing", { ...ok, can: null }],
    ["can.create not a boolean", { ...ok, can: { create: 1 } }],
  ];
  for (const [name, body] of bad)
    it(`refuses ${name}, as a retryable failed read`, async () => {
      expect(isContactLeads(body, "A")).toBe(false);
      const h = harness();
      h.ctl.select("A");
      h.reads[0]!.resolve(body as ContactLeads);
      await h.flush();
      expect(h.st()).toMatchObject({ phase: "idle", data: null, readError: { next: "retry" } });
    });
});

describe("validating what a creation says", () => {
  it("accepts created:true (a NEW lead at revision 0) and created:false (the existing OPEN lead), for this contact", () => {
    expect(acceptCreateResult(created("A"), "A")).toMatchObject({ created: true });
    expect(acceptCreateResult(existing("A"), "A")).toMatchObject({ created: false });
  });
  const bad: [string, unknown][] = [
    ["{created:true} with no lead", { created: true }],
    ["a null lead", { created: true, lead: null }],
    ["created not a boolean", { ...created("A"), created: "yes" }],
    ["another contact's lead", created("B")],
    [
      "a created lead that is not NEW",
      { created: true, lead: lead("A", "x", { status: "QUALIFIED" }) },
    ],
    ["a created lead not at revision 0", { created: true, lead: lead("A", "x", { revision: 1 }) }],
    ["an existing lead that is closed", { created: false, lead: closed("A", "x") }],
    ["a lead without an id", { created: true, lead: { ...lead("A", "x"), id: 7 } }],
    ...BAD_IDS.flatMap(([n, id]): [string, unknown][] => [
      [`created:true with an id ${n}`, { created: true, lead: { ...lead("A", "x"), id } }],
      [`created:false with an id ${n}`, { created: false, lead: { ...lead("A", "x"), id } }],
    ]),
  ];
  for (const [name, body] of bad)
    it(`refuses ${name}`, () => expect(acceptCreateResult(body, "A")).toBeNull());
});

describe("creating a lead", () => {
  it("created:true: one POST for the contact, then a READ shows the lead; nothing is inserted from the answer", async () => {
    const h = await ready("A");
    h.ctl.create();
    expect(h.creates.map((c) => c.contactId)).toEqual(["A"]);
    expect(h.st().creating).toBe(true);
    h.creates[0]!.resolve(created("A"));
    await h.flush();
    expect(h.st()).toMatchObject({
      creating: false,
      notice: { kind: "created", leadId: uid("N1") },
    });
    expect(h.shown()).toEqual([]); // still the last read: the panel does not invent the lead
    expect(h.reads).toHaveLength(2);
    h.ctl.create();
    expect(h.creates).toHaveLength(1); // not before the read
    h.reads[1]!.resolve(leadsOf("A", { open: lead("A", "N1") }));
    await h.flush();
    expect(h.shown()).toEqual(["N1"]);
    expect(h.st()).toMatchObject({ needsRead: false, notice: { kind: "created" } });
  });

  it("created:false is reported as an existing lead, never as a new one", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.creates[0]!.resolve(existing("A"));
    await h.flush();
    expect(h.st().notice).toEqual({ kind: "existing", leadId: uid("O1") });
  });

  it("a double click, Enter and Space: one POST while one is pending", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.ctl.create();
    h.ctl.create();
    expect(h.creates).toHaveLength(1);
  });

  it("not while a read is loading, and not without a successful read", () => {
    const h = harness();
    h.ctl.select("A");
    h.ctl.create();
    expect(h.creates).toHaveLength(0);
  });

  for (const [name, error, kind] of [
    ["CONTACT_ARCHIVED", new ApiError(409, "CONTACT_ARCHIVED"), "contact_archived"],
    ["ALREADY_OPEN", new ApiError(409, "ALREADY_OPEN"), "already_open"],
    ["403", new ApiError(403, "FORBIDDEN"), "forbidden"],
    ["404", new ApiError(404, "NOT_FOUND"), "not_found"],
  ] as const)
    it(`${name}: a refusal, not a success; not retried; the contact is read again`, async () => {
      const h = await ready("A", leadsOf("A", { leads: [closed("A", "L1")] }));
      h.ctl.create();
      h.creates[0]!.reject(error);
      await h.flush();
      expect(h.st().notice).toMatchObject({ kind: "refused", info: { kind } });
      expect(h.shown()).toEqual(["L1"]); // what was shown stays
      expect(h.creates).toHaveLength(1);
      expect(h.reads).toHaveLength(2);
    });

  it("401: reported, nothing read (it would be refused too), nothing repeated", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.creates[0]!.reject(new ApiError(401, "UNAUTHENTICATED"));
    await h.flush();
    expect(h.st().notice).toMatchObject({ kind: "refused", info: { next: "sign-in" } });
    expect(h.reads).toHaveLength(1);
  });
});

describe("an unknown creation outcome", () => {
  const cases: [string, (h: ReturnType<typeof harness>) => void][] = [
    ["a lost answer (network/timeout)", (h) => h.creates[0]!.reject(new ApiError(0, "NETWORK"))],
    ["a server error", (h) => h.creates[0]!.reject(new ApiError(500, "INTERNAL_ERROR"))],
    ["an unreadable 2xx", (h) => h.creates[0]!.reject(new ApiError(200, "BAD_RESPONSE"))],
    ["{created:true} with no lead", (h) => h.creates[0]!.resolve({ created: true } as never)],
    ["another contact's lead", (h) => h.creates[0]!.resolve(created("B"))],
    [
      "created:true with a malformed lead id",
      (h) => h.creates[0]!.resolve({ created: true, lead: { ...lead("A", "x"), id: "\uD800" } }),
    ],
    [
      "created:false with a malformed lead id",
      (h) =>
        h.creates[0]!.resolve({ created: false, lead: { ...lead("A", "x"), id: "not-a-uuid" } }),
    ],
  ];
  for (const [name, answer] of cases)
    it(`${name}: never repeated, never a success or failure; the contact is read and only then may it be tried again`, async () => {
      const h = await ready("A");
      h.ctl.create();
      answer(h);
      await h.flush();
      expect(h.st()).toMatchObject({ notice: { kind: "unknown" }, needsRead: true });
      expect(h.reads).toHaveLength(2);
      h.ctl.create();
      expect(h.creates).toHaveLength(1);
      // the committed lead appears in the read
      h.reads[1]!.resolve(leadsOf("A", { open: lead("A", "N1") }));
      await h.flush();
      expect(h.shown()).toEqual(["N1"]);
      expect(h.st()).toMatchObject({ needsRead: false, notice: { kind: "unknown" } });
      expect(h.creates).toHaveLength(1);
    });

  it("if the recovery read fails the uncertainty stays, creation stays unavailable, and Retry only reads", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.creates[0]!.reject(new ApiError(0, "NETWORK"));
    await h.flush();
    h.reads[1]!.reject(new ApiError(0, "NETWORK"));
    await h.flush();
    expect(h.st()).toMatchObject({ needsRead: true, readError: { next: "retry" } });
    h.ctl.create();
    expect(h.creates).toHaveLength(1);
    h.ctl.refresh();
    expect(h.reads).toHaveLength(3);
    expect(h.creates).toHaveLength(1);
    // the read finds nothing (the request may still be completing): creating is possible again, the uncertainty is still told
    h.reads[2]!.resolve(leadsOf("A"));
    await h.flush();
    expect(h.st()).toMatchObject({ needsRead: false, notice: { kind: "unknown" } });
    h.ctl.create();
    expect(h.creates).toHaveLength(2); // a new, explicit decision
  });
});

describe("a malformed lead id never enters the panel", () => {
  const bad = { ...lead("A", "x"), id: "\uD800" };
  it("a malformed read is a retryable panel error; nothing is published; Retry reads only; a valid answer is then accepted", async () => {
    const h = harness();
    h.ctl.select("A");
    h.reads[0]!.resolve(leadsOf("A", { open: bad, leads: [bad] }));
    await h.flush();
    expect(h.st()).toMatchObject({ phase: "idle", data: null, readError: { next: "retry" } });
    h.ctl.create();
    expect(h.creates).toHaveLength(0);
    h.ctl.refresh();
    expect(h.reads).toHaveLength(2);
    h.reads[1]!.resolve(leadsOf("A", { open: lead("A", "L1") }));
    await h.flush();
    expect(h.st()).toMatchObject({ phase: "ready", readError: null });
    expect(h.shown()).toEqual(["L1"]);
  });

  it("a malformed refresh keeps the leads already shown and trusts none of the new answer", async () => {
    const good = lead("A", "L1");
    const h = await ready("A", leadsOf("A", { open: good }));
    h.ctl.refresh();
    h.reads[1]!.resolve(leadsOf("A", { open: lead("A", "L2"), leads: [lead("A", "L2"), bad] }));
    await h.flush();
    expect(h.shown()).toEqual(["L1"]); // not a mix of trusted and malformed records
    expect(h.st()).toMatchObject({ phase: "ready", readError: { next: "retry" } });
  });

  it("a committed creation answered with a malformed id: one POST, an unknown outcome, a GET shows the real lead, no malformed id anywhere", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.creates[0]!.resolve({ created: true, lead: bad });
    await h.flush();
    expect(h.st()).toMatchObject({ notice: { kind: "unknown" }, needsRead: true });
    expect(JSON.stringify(h.st())).not.toContain("\\ud800");
    expect(h.reads).toHaveLength(2);
    expect(h.creates).toHaveLength(1);
    h.reads[1]!.resolve(leadsOf("A", { open: lead("A", "N1") }));
    await h.flush();
    expect(h.shown()).toEqual(["N1"]);
    expect(h.st()).toMatchObject({ needsRead: false, notice: { kind: "unknown" } });
    expect(h.creates).toHaveLength(1);
  });

  it("if the recovery read is malformed too, the uncertainty stays and Retry is a GET", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.creates[0]!.resolve({ created: false, lead: bad });
    await h.flush();
    h.reads[1]!.resolve(leadsOf("A", { open: bad, leads: [bad] }));
    await h.flush();
    expect(h.st()).toMatchObject({ needsRead: true, readError: { next: "retry" } });
    h.ctl.create();
    expect(h.creates).toHaveLength(1);
    h.ctl.refresh();
    expect(h.reads).toHaveLength(3);
    expect(h.creates).toHaveLength(1);
  });
});

describe("a creation is bound to its contact", () => {
  it("A's creation finishing while B is shown never touches B, and is shown when A is opened again", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.ctl.select("B");
    expect(h.creates[0]!.signal.aborted).toBe(false); // switching does not abandon it (the server may commit)
    h.reads[1]!.resolve(leadsOf("B"));
    await h.flush();
    h.creates[0]!.resolve(created("A"));
    await h.flush();
    expect(h.st()).toMatchObject({ contactId: "B", notice: null, creating: false });
    expect(h.st().data?.contact.id).toBe("B");
    expect(h.reads).toHaveLength(2); // A is not read while B is shown
    h.ctl.create(); // B may create its own
    expect(h.creates.map((c) => c.contactId)).toEqual(["A", "B"]);

    h.ctl.select("A");
    expect(h.st()).toMatchObject({
      notice: { kind: "created", leadId: uid("N1") },
      needsRead: true,
    });
    h.reads[2]!.resolve(leadsOf("A", { open: lead("A", "N1") }));
    await h.flush();
    expect(h.shown()).toEqual(["N1"]);
    expect(h.st().needsRead).toBe(false);
  });

  it("back to A while A's creation is still on its way: shown as pending, no second POST", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.ctl.select("B");
    h.ctl.select("A");
    expect(h.st().creating).toBe(true);
    h.reads[2]!.resolve(leadsOf("A"));
    await h.flush();
    h.ctl.create();
    expect(h.creates).toHaveLength(1);
    h.creates[0]!.resolve(created("A"));
    await h.flush();
    expect(h.reads).toHaveLength(4); // read again now that it is known
  });

  it("an unknown outcome for A while B is shown stays A's", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.ctl.select("B");
    h.creates[0]!.reject(new ApiError(0, "NETWORK"));
    await h.flush();
    expect(h.st().notice).toBeNull();
    h.ctl.select("A");
    expect(h.st()).toMatchObject({ notice: { kind: "unknown" }, needsRead: true });
  });
});

describe("the account changes", () => {
  it("ACTOR_CHANGED on a read blocks: everything is hidden and nothing more is requested", async () => {
    const h = await ready("A", leadsOf("A", { leads: [closed("A", "L1")] }));
    h.ctl.refresh();
    h.reads[1]!.reject(new ApiError(409, "ACTOR_CHANGED"));
    await h.flush();
    expect(h.st()).toMatchObject({ blocked: true, data: null, contactId: null });
    h.ctl.select("B");
    h.ctl.refresh();
    h.ctl.create();
    expect(h.reads).toHaveLength(2);
    expect(h.creates).toHaveLength(0);
  });

  it("blocking drops late answers of a creation that was on its way", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.ctl.refresh();
    h.ctl.block();
    h.creates[0]!.resolve(created("A"));
    h.reads[1]!.resolve(leadsOf("A", { open: lead("A", "N1") }));
    await h.flush();
    expect(h.st()).toMatchObject({ blocked: true, data: null, notice: null });
    expect(h.reads).toHaveLength(2);
  });

  it("after the POST was ANSWERED: the follow-up read meets ACTOR_CHANGED; everything is dropped, nothing more is sent", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.creates[0]!.resolve(created("A")); // committed and answered; the follow-up read is pending
    await h.flush();
    expect(h.reads).toHaveLength(2);
    h.reads[1]!.reject(new ApiError(409, "ACTOR_CHANGED"));
    await h.flush();
    expect(h.st()).toMatchObject({ blocked: true, data: null, notice: null, contactId: null });
    h.ctl.refresh();
    h.ctl.create();
    h.ctl.select("B");
    expect(h.reads).toHaveLength(2);
    expect(h.creates).toHaveLength(1);
  });

  it("while recovering an unknown outcome: the old actor's data never comes back and the POST is not repeated", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.creates[0]!.reject(new ApiError(0, "NETWORK"));
    await h.flush();
    h.ctl.block();
    h.reads[1]!.resolve(leadsOf("A", { open: lead("A", "N1") }));
    await h.flush();
    expect(h.st()).toMatchObject({ blocked: true, data: null, notice: null });
    expect(h.creates).toHaveLength(1);
    expect(h.reads).toHaveLength(2);
  });

  it("before the server processed it: the creation is refused, the page blocks, nothing is retried", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.creates[0]!.reject(new ApiError(409, "ACTOR_CHANGED"));
    await h.flush();
    expect(h.st()).toMatchObject({ blocked: true, data: null });
    expect(h.creates).toHaveLength(1);
    expect(h.reads).toHaveLength(1);
  });

  it("the sticky flag stops a read or a creation before it is sent", async () => {
    const h = await ready("A");
    h.changeActor();
    h.ctl.create();
    expect(h.creates).toHaveLength(0);
    expect(h.st().blocked).toBe(true);
    const g = harness();
    g.changeActor();
    g.ctl.select("A");
    expect(g.reads).toHaveLength(0);
  });
});

describe("leaving the Inbox", () => {
  it("late answers after unmount change nothing, and a remount reads afresh", async () => {
    const h = await ready("A");
    h.ctl.create();
    h.ctl.refresh();
    h.ctl.cancel();
    expect(h.reads[1]!.signal.aborted).toBe(true);
    h.creates[0]!.resolve(created("A"));
    h.reads[1]!.resolve(leadsOf("A", { open: lead("A", "N1") }));
    await h.flush();
    expect(h.st()).toMatchObject({ contactId: null, data: null, notice: null, creating: false });
    expect(h.reads).toHaveLength(2);
    h.ctl.select("A"); // React may mount the same controller again
    expect(h.reads).toHaveLength(3);
  });

  it("a defect while applying a read does not leave the panel loading, and is reported", async () => {
    const h = harness();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let armed = true;
    h.ctl.subscribe(() => {
      if (armed && h.st().phase === "ready") {
        armed = false;
        throw new Error("a subscriber failed");
      }
    });
    h.ctl.select("A");
    h.reads[0]!.resolve(leadsOf("A"));
    await h.flush();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    expect(h.st()).toMatchObject({ phase: "ready", readError: { next: "retry" } });
  });
});

describe("boundaries of the Inbox lead panel (static)", () => {
  const read = (f: string) =>
    readFileSync(join(process.cwd(), "src/app/(app)/inbox", f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const files = ["lead-panel.tsx", "lead-panel-controller.ts", "inbox-app.tsx"];
  it("no status change, revision or second mutation path from the Inbox: only the contact read and manual creation", () => {
    for (const f of files)
      expect(read(f), f).not.toMatch(
        /changeLeadStatus|expectedRevision|\/status\b|StaffSettable|fetchLeadDetail/,
      );
    expect(read("inbox-app.tsx")).toMatch(
      /import \{ fetchContactLeads, createLead \} from "\.\.\/leads\/lead-api";/,
    );
    for (const f of ["lead-panel.tsx", "lead-panel-controller.ts"])
      expect(read(f), f).not.toMatch(
        /\bapi(<[^>]*>)?\(|\bfetch\(|setTimeout|setInterval|localStorage|sessionStorage/,
      );
  });
  it("the account-changed notice makes no rollback claim and does not depend on a pending creation", () => {
    const app = read("inbox-app.tsx");
    const notice = app.slice(app.indexOf("if (actorChanged)"), app.indexOf("const quote ="));
    expect(notice).not.toMatch(/nothing was changed|rolled back|cancelled all|was not created/i);
    expect(notice).toMatch(/may\s+already\s+have\s+completed/);
    expect(notice).not.toMatch(/leadState|blockedWhile/);
  });
  it("lead links are built only from ids through the lead path helper, never from a URL the server or browser supplied", () => {
    const panel = read("lead-panel.tsx");
    expect(panel.match(/href=\{leadHref\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(panel).not.toMatch(/href=\{(?!leadHref\()[^"]/);
    expect(panel).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
