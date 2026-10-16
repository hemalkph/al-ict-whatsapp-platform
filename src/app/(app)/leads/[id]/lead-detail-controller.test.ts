import { describe, expect, it, vi } from "vitest";
import type {
  ContactLeads,
  LeadDetail,
  LeadEventPage,
  LeadEventView,
  StatusChangeResult,
} from "@/modules/leads";
import { ApiError } from "../lead-api";
import { acceptStatusResult, createDetailController } from "./lead-detail-controller";

// Deterministic races: every request the controller makes is held until the test resolves (or rejects) it, in any order.

const OTHER_LEAD = "00000000-0000-4000-8000-0000000000a2";
const CONTACT = "00000000-0000-4000-8000-0000000000c1"; // ids are UUIDs: the controller refuses anything else
const ev = (id: string): LeadEventView => ({
  id,
  kind: "STATUS",
  at: "2026-01-01T00:00:00.000Z",
  atKey: id,
  actorName: "Staff",
  origin: null,
  from: "NEW",
  to: "QUALIFIED",
  revision: 1,
  touch: null,
});
const NONE = {
  kind: "NONE",
  label: "No advertisement referral recorded",
  adTouches: 0,
  linkedTouches: 0,
  firstReceivedAt: null,
  latestReceivedAt: null,
} as const;
const evPage = (ids: string[], nextCursor: string | null = null): LeadEventPage => ({
  events: ids.map(ev),
  nextCursor,
});
const detail = (
  id = "L1",
  name = "Amaya",
  history = evPage(["e3", "e2"], "C1"),
  o: { status?: string; revision?: number; readOnly?: boolean; edit?: boolean } = {},
): LeadDetail => {
  const label = { displayName: name, named: true, idHint: null };
  const at = "2026-01-01T00:00:00.000Z";
  return {
    lead: {
      id,
      status: (o.status ?? "NEW") as LeadDetail["lead"]["status"],
      revision: o.revision ?? 5,
      readOnly: o.readOnly ?? false,
      open: !["NOT_INTERESTED", "NO_RESPONSE", "INVALID"].includes(o.status ?? "NEW"),
      createdAt: at,
      createdKey: at,
      statusChangedAt: at,
      cycleStartedAt: at,
      closedAt: null,
      origin: "MANUAL",
      contact: { id: CONTACT, label, archived: false },
      source: NONE,
    },
    contact: {
      id: CONTACT,
      label,
      archived: false,
      firstSeenAt: at,
      lastSeenAt: at,
      identity: { bsuidTail: null, lastObservedPhone: null },
    },
    conversations: [],
    attribution: {
      source: NONE,
      linked: [],
      linkedTotal: 0,
      first: null,
      latest: null,
      otherForContact: [],
      otherTotal: 0,
    },
    can: { edit: o.edit ?? true },
    history,
  };
};
const result = (changed: boolean, status: string, revision: number): StatusChangeResult =>
  ({
    changed,
    lead: {
      id: "L1",
      status,
      revision,
      open: !["NOT_INTERESTED", "NO_RESPONSE", "INVALID"].includes(status),
      readOnly: false,
      statusChangedAt: "2026-01-02T00:00:00.000Z",
      cycleStartedAt: "2026-01-01T00:00:00.000Z",
    },
  }) as unknown as StatusChangeResult;
const contactLeads = (openLeadId: string | null) =>
  ({ openLead: openLeadId ? { id: openLeadId } : null }) as unknown as ContactLeads;

type Held<T> = { resolve: (v: T) => void; reject: (e: unknown) => void; signal: AbortSignal };

function harness(initial = detail()) {
  const details: (Held<LeadDetail> & { leadId: string })[] = [];
  const events: (Held<LeadEventPage> & { leadId: string; cursor: string })[] = [];
  const changes: (Held<StatusChangeResult> & {
    leadId: string;
    to: string;
    expectedRevision: number;
  })[] = [];
  const contacts: (Held<ContactLeads> & { contactId: string })[] = [];
  let actorChanged = false;
  const ctl = createDetailController({
    detail: initial,
    fetchDetail: (leadId, { signal }) =>
      new Promise((resolve, reject) => details.push({ leadId, signal, resolve, reject })),
    fetchEvents: (leadId, { cursor, signal }) =>
      new Promise((resolve, reject) => events.push({ leadId, cursor, signal, resolve, reject })),
    changeStatus: (leadId, change, { signal }) =>
      new Promise((resolve, reject) =>
        changes.push({
          leadId,
          to: change.to,
          expectedRevision: change.expectedRevision,
          signal,
          resolve,
          reject,
        }),
      ),
    fetchContactLeads: (contactId, { signal }) =>
      new Promise((resolve, reject) => contacts.push({ contactId, signal, resolve, reject })),
    isActorChanged: () => actorChanged,
  });
  const ids = () => ctl.getState().history.items.map((e) => e.id);
  const name = () => ctl.getState().detail.lead.contact.label.displayName;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    ctl,
    details,
    events,
    changes,
    contacts,
    ids,
    name,
    flush,
    changeActor: () => (actorChanged = true),
  };
}

describe("the first page", () => {
  it("starts from what the server rendered, in the server's order, without requesting anything", () => {
    const h = harness();
    expect(h.ids()).toEqual(["e3", "e2"]);
    expect(h.name()).toBe("Amaya");
    expect(h.ctl.getState()).toMatchObject({ phase: "ready", unavailable: false, blocked: false });
    expect(h.details).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("a detail with an empty history and no cursor has nothing to load", () => {
    const h = harness(detail("L1", "Amaya", evPage([])));
    h.ctl.loadOlder();
    expect(h.events).toHaveLength(0);
    expect(h.ids()).toEqual([]);
  });
});

describe("load older", () => {
  it("continues from the cursor of the page it holds, appends in order and stops when no cursor remains", async () => {
    const h = harness();
    h.ctl.loadOlder();
    expect(h.ctl.getState().phase).toBe("loading-older");
    expect(h.events[0]).toMatchObject({ leadId: "L1", cursor: "C1" });
    h.events[0]!.resolve(evPage(["e1", "e0"], "C2"));
    await h.flush();
    expect(h.ids()).toEqual(["e3", "e2", "e1", "e0"]);
    h.ctl.loadOlder();
    expect(h.events[1]).toMatchObject({ cursor: "C2" });
    h.events[1]!.resolve(evPage(["e00"], null));
    await h.flush();
    expect(h.ids()).toEqual(["e3", "e2", "e1", "e0", "e00"]);
    h.ctl.loadOlder(); // the end: nothing is requested
    expect(h.events).toHaveLength(2);
  });

  it("keeps an event that arrives twice once, at its first position", async () => {
    const h = harness();
    h.ctl.loadOlder();
    h.events[0]!.resolve(evPage(["e2", "e1"], null));
    await h.flush();
    expect(h.ids()).toEqual(["e3", "e2", "e1"]);
  });

  it("an empty page ends the history even if it carries a cursor (it would only repeat the same request)", async () => {
    const h = harness();
    h.ctl.loadOlder();
    h.events[0]!.resolve(evPage([], "LOOP"));
    await h.flush();
    h.ctl.loadOlder();
    expect(h.events).toHaveLength(1);
  });

  it("is refused while a request runs: two clicks send one request", () => {
    const h = harness();
    h.ctl.loadOlder();
    h.ctl.loadOlder();
    h.ctl.refresh(); // a refresh supersedes it (below); a second loadOlder alone does not
    expect(h.events).toHaveLength(1);
  });

  it("a failure keeps the events shown, offers a retry that asks for the SAME page, and never retries by itself", async () => {
    const h = harness();
    h.ctl.loadOlder();
    h.events[0]!.reject(new ApiError(500, "INTERNAL_ERROR"));
    await h.flush();
    const s = h.ctl.getState();
    expect(s.error).toMatchObject({ during: "older", info: { next: "retry" } });
    expect(h.ids()).toEqual(["e3", "e2"]);
    expect(s.phase).toBe("ready");
    expect(h.events).toHaveLength(1);
    h.ctl.retry();
    expect(h.events[1]).toMatchObject({ cursor: "C1" });
    expect(h.ctl.getState().error).toBeNull();
    h.events[1]!.resolve(evPage(["e1"], null));
    await h.flush();
    expect(h.ids()).toEqual(["e3", "e2", "e1"]);
  });
});

describe("refresh", () => {
  it("keeps the old data visible until the answer replaces it, history included (back to its first page)", async () => {
    const h = harness();
    h.ctl.loadOlder();
    h.events[0]!.resolve(evPage(["e1"], null));
    await h.flush();
    h.ctl.refresh();
    expect(h.ctl.getState().phase).toBe("refreshing");
    expect(h.name()).toBe("Amaya");
    expect(h.ids()).toEqual(["e3", "e2", "e1"]);
    h.details[0]!.resolve(detail("L1", "Amaya 2", evPage(["e4", "e3"], "C9")));
    await h.flush();
    expect(h.name()).toBe("Amaya 2");
    expect(h.ids()).toEqual(["e4", "e3"]);
    h.ctl.loadOlder();
    expect(h.events[1]).toMatchObject({ cursor: "C9" });
  });

  it("a failed refresh leaves the loaded lead and history in place", async () => {
    const h = harness();
    h.ctl.refresh();
    h.details[0]!.reject(new ApiError(0, "NETWORK"));
    await h.flush();
    expect(h.ctl.getState().error).toMatchObject({ during: "refresh", info: { next: "retry" } });
    expect(h.name()).toBe("Amaya");
    expect(h.ids()).toEqual(["e3", "e2"]);
    h.ctl.retry();
    expect(h.details).toHaveLength(2);
  });

  it("an answer for another lead is never applied", async () => {
    const h = harness();
    h.ctl.refresh();
    h.details[0]!.resolve(detail("OTHER", "Someone Else"));
    await h.flush();
    expect(h.name()).toBe("Amaya");
    expect(h.ctl.getState().error).not.toBeNull();
  });

  it("404 or 403 replaces the page with a notice: the lead is no longer shown", async () => {
    for (const status of [404, 403]) {
      const h = harness();
      h.ctl.refresh();
      h.details[0]!.reject(new ApiError(status, status === 404 ? "NOT_FOUND" : "FORBIDDEN"));
      await h.flush();
      expect(h.ctl.getState()).toMatchObject({ unavailable: true, error: null, phase: "ready" });
      h.ctl.loadOlder();
      expect(h.events).toHaveLength(0);
    }
  });

  it("an expired session is reported, not hidden", async () => {
    const h = harness();
    h.ctl.refresh();
    h.details[0]!.reject(new ApiError(401, "UNAUTHENTICATED"));
    await h.flush();
    expect(h.ctl.getState().error).toMatchObject({ info: { next: "sign-in" } });
  });
});

describe("races", () => {
  it("a refresh supersedes Load older: the late older page is dropped even though it arrives", async () => {
    const h = harness();
    h.ctl.loadOlder();
    h.ctl.refresh();
    expect(h.events[0]!.signal.aborted).toBe(true);
    h.details[0]!.resolve(detail("L1", "Fresh", evPage(["f2", "f1"], "F1")));
    await h.flush();
    h.events[0]!.resolve(evPage(["STALE"], null));
    await h.flush();
    expect(h.ids()).toEqual(["f2", "f1"]);
    expect(h.ctl.getState().phase).toBe("ready");
  });

  it("an older refresh never replaces a newer one", async () => {
    const h = harness();
    h.ctl.refresh();
    h.ctl.refresh();
    const [first, second] = h.details;
    expect(first!.signal.aborted).toBe(true);
    second!.resolve(detail("L1", "NEWER"));
    await h.flush();
    first!.resolve(detail("L1", "OLDER"));
    await h.flush();
    expect(h.name()).toBe("NEWER");
  });

  it("an error of a superseded request does not replace the current state", async () => {
    const h = harness();
    h.ctl.refresh();
    h.ctl.refresh();
    h.details[1]!.resolve(detail("L1", "Fine"));
    await h.flush();
    h.details[0]!.reject(new ApiError(500, "INTERNAL_ERROR"));
    await h.flush();
    expect(h.ctl.getState().error).toBeNull();
    expect(h.name()).toBe("Fine");
  });

  it("leaving the page abandons everything in flight; late answers change nothing", async () => {
    const h = harness();
    h.ctl.refresh();
    h.ctl.cancel();
    expect(h.details[0]!.signal.aborted).toBe(true);
    h.details[0]!.resolve(detail("L1", "AFTER UNMOUNT"));
    await h.flush();
    expect(h.name()).toBe("Amaya");
  });
});

describe("the signed-in account changed", () => {
  it("blocking supersedes what is in flight: a late success is never applied and nothing more is requested", async () => {
    const h = harness();
    h.ctl.loadOlder();
    h.ctl.block();
    expect(h.ctl.getState().blocked).toBe(true);
    expect(h.events[0]!.signal.aborted).toBe(true);
    h.events[0]!.resolve(evPage(["LATE"], null));
    await h.flush();
    expect(h.ids()).toEqual(["e3", "e2"]);
    h.ctl.refresh();
    h.ctl.loadOlder();
    h.ctl.retry();
    expect(h.details).toHaveLength(0);
    expect(h.events).toHaveLength(1);
  });

  it("a refusal (409 ACTOR_CHANGED) blocks the page, whichever request met it", async () => {
    const h = harness();
    h.ctl.refresh();
    h.details[0]!.reject(new ApiError(409, "ACTOR_CHANGED"));
    await h.flush();
    expect(h.ctl.getState()).toMatchObject({ blocked: true, error: null });
  });

  it("a refusal on Load older (history pagination) blocks the page too, and a late older page is never applied", async () => {
    const h = harness();
    h.ctl.loadOlder();
    h.events[0]!.reject(new ApiError(409, "ACTOR_CHANGED"));
    await h.flush();
    expect(h.ctl.getState()).toMatchObject({ blocked: true, error: null });
    const g = harness();
    g.ctl.loadOlder();
    g.ctl.refresh(); // a refresh supersedes the older-page request
    g.ctl.block();
    g.events[0]!.resolve(evPage(["e1"]));
    g.details[0]!.resolve(detail("L1", "Changed"));
    await g.flush();
    expect(g.ids()).toEqual(["e3", "e2"]);
    expect(g.ctl.getState()).toMatchObject({ blocked: true });
  });

  it("the sticky flag blocks a request before it is sent (the flag outlives navigation)", () => {
    const h = harness();
    h.changeActor();
    h.ctl.refresh();
    expect(h.details).toHaveLength(0);
    expect(h.ctl.getState().blocked).toBe(true);
  });

  it("blocking twice is harmless", () => {
    const h = harness();
    h.ctl.block();
    h.ctl.block();
    expect(h.ctl.getState().blocked).toBe(true);
  });
});

describe("subscription", () => {
  it("notifies on every change and stops after unsubscribe", () => {
    const h = harness();
    let n = 0;
    const off = h.ctl.subscribe(() => n++);
    h.ctl.refresh();
    expect(n).toBeGreaterThan(0);
    off();
    const before = n;
    h.ctl.block();
    expect(n).toBe(before);
  });
});

// ------------------------------------------------------------------------------------------------------ status management
const st = (h: ReturnType<typeof harness>) => h.ctl.getState().status;
const lead = (h: ReturnType<typeof harness>) => h.ctl.getState().detail.lead;
/** A change request that is already on its way, from a lead at revision 5 that is NEW (move) or closed (reopen). */
function sending(h = harness(), to: "QUALIFIED" | "NOT_INTERESTED" | "NEW" = "QUALIFIED") {
  h.ctl.choose(to);
  h.ctl.requestChange();
  if (to === "NOT_INTERESTED" || h.ctl.getState().detail.lead.status === "NOT_INTERESTED")
    h.ctl.confirm();
  return h;
}

describe("choosing a status", () => {
  it("a choice is bound to the revision shown; choosing the current status clears it", () => {
    const h = harness();
    h.ctl.choose("QUALIFIED");
    expect(st(h).draft).toEqual({ to: "QUALIFIED", revision: 5 });
    h.ctl.choose("NEW"); // the current status: no decision
    expect(st(h).draft).toBeNull();
    h.ctl.choose("QUALIFIED");
    h.ctl.choose(null);
    expect(st(h).draft).toBeNull();
  });

  it("nothing can be chosen on a lead that is read-only, in a reserved status, for a role that cannot edit, or while busy", () => {
    for (const d of [
      detail("L1", "A", evPage([]), { readOnly: true }),
      detail("L1", "A", evPage([]), { status: "PAID", readOnly: true }),
      detail("L1", "A", evPage([]), { edit: false }),
      detail("L1", "A", evPage([]), { status: "SOMETHING_NEW" }),
    ]) {
      const h = harness(d);
      h.ctl.choose("QUALIFIED");
      h.ctl.requestChange();
      expect(st(h).draft).toBeNull();
      expect(h.changes).toHaveLength(0);
    }
    const busy = harness();
    busy.ctl.refresh();
    busy.ctl.choose("QUALIFIED");
    expect(st(busy).draft).toBeNull();
  });

  it("a move between statuses of the same kind is sent at once, with the revision of the decision", () => {
    const h = harness();
    h.ctl.choose("QUALIFIED");
    h.ctl.requestChange();
    expect(h.ctl.getState().phase).toBe("changing");
    expect(st(h).confirm).toBeNull(); // no dialog for an ordinary move
    expect(h.changes).toEqual([
      expect.objectContaining({ leadId: "L1", to: "QUALIFIED", expectedRevision: 5 }),
    ]);
  });

  it("a closing and a reopening ask first, send nothing until confirmed, and cancelling sends nothing", () => {
    const h = harness();
    h.ctl.choose("NOT_INTERESTED");
    h.ctl.requestChange();
    expect(st(h).confirm).toEqual({ to: "NOT_INTERESTED", revision: 5 });
    expect(h.changes).toHaveLength(0);
    h.ctl.cancelConfirm();
    expect(st(h).confirm).toBeNull();
    expect(st(h).draft).toEqual({ to: "NOT_INTERESTED", revision: 5 }); // the choice stays; nothing was sent
    expect(h.changes).toHaveLength(0);

    const r = harness(detail("L1", "A", evPage([]), { status: "INVALID" }));
    r.ctl.choose("INTERESTED");
    r.ctl.requestChange();
    expect(st(r).confirm).toMatchObject({ to: "INTERESTED" });
    expect(r.changes).toHaveLength(0);
  });
});

describe("sending a change", () => {
  it("success (changed: true): the answer's status and revision are shown at once, the control stays unavailable until the lead is read, and the history only changes with that read", async () => {
    const h = sending();
    h.changes[0]!.resolve(result(true, "QUALIFIED", 6));
    await h.flush();
    expect(lead(h)).toMatchObject({ status: "QUALIFIED", revision: 6 });
    expect(st(h)).toMatchObject({
      notice: { kind: "changed", to: "QUALIFIED" },
      needsRead: true,
      draft: null,
      confirm: null,
    });
    expect(h.ids()).toEqual(["e3", "e2"]); // nothing is added to the history in the browser
    expect(h.ctl.getState().phase).toBe("refreshing");
    expect(h.details).toHaveLength(1); // the read that follows
    h.ctl.choose("INTERESTED"); // not yet: the state has not been read
    expect(st(h).draft).toBeNull();
    h.details[0]!.resolve(
      detail("L1", "Amaya", evPage(["e4", "e3", "e2"], "C1"), { status: "QUALIFIED", revision: 6 }),
    );
    await h.flush();
    expect(h.ids()).toEqual(["e4", "e3", "e2"]);
    expect(st(h)).toMatchObject({ needsRead: false, notice: { kind: "changed" } });
    h.ctl.choose("INTERESTED");
    expect(st(h).draft).toEqual({ to: "INTERESTED", revision: 6 }); // a fresh decision, on the new revision
    expect(h.changes).toHaveLength(1); // the change was sent exactly once
  });

  it("changed: false is shown as no change, never as a success", async () => {
    const h = sending();
    h.changes[0]!.resolve(result(false, "QUALIFIED", 5));
    await h.flush();
    expect(st(h).notice).toEqual({ kind: "unchanged" });
    h.details[0]!.resolve(detail());
    await h.flush();
    expect(st(h).notice).toEqual({ kind: "unchanged" });
    expect(lead(h).status).toBe("NEW");
  });

  it("the confirmation dialog stays open and stable while the change is on its way, and cannot be dismissed or confirmed twice", async () => {
    const h = harness();
    h.ctl.choose("NOT_INTERESTED");
    h.ctl.requestChange();
    h.ctl.confirm();
    h.ctl.confirm(); // a second click
    h.ctl.confirm();
    expect(h.changes).toHaveLength(1);
    expect(h.ctl.getState().phase).toBe("changing");
    expect(st(h).confirm).not.toBeNull();
    h.ctl.cancelConfirm(); // Escape or Cancel while sending: ignored
    expect(st(h).confirm).not.toBeNull();
    h.changes[0]!.resolve(result(true, "NOT_INTERESTED", 6));
    await h.flush();
    expect(st(h).confirm).toBeNull(); // closed only once the outcome is known
  });

  it("only one change at a time: a refresh, Load older, a new choice and a second request are all refused while one is sent", () => {
    const h = sending();
    h.ctl.refresh();
    h.ctl.loadOlder();
    h.ctl.choose("INTERESTED");
    h.ctl.requestChange();
    expect(h.details).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]!.signal.aborted).toBe(false); // nothing superseded it
  });

  it("a double click on Update sends one request", () => {
    const h = harness();
    h.ctl.choose("QUALIFIED");
    h.ctl.requestChange();
    h.ctl.requestChange();
    h.ctl.requestChange();
    expect(h.changes).toHaveLength(1);
  });
});

describe("refusals by the server: nothing is repeated, the lead is read again, a new decision waits for that read", () => {
  it("STALE_STATE: not retried, read, and the choice is gone", async () => {
    const h = sending();
    h.changes[0]!.reject(new ApiError(409, "STALE_STATE"));
    await h.flush();
    expect(st(h)).toMatchObject({
      notice: { kind: "stale" },
      needsRead: true,
      draft: null,
      confirm: null,
    });
    expect(h.changes).toHaveLength(1);
    expect(h.details).toHaveLength(1);
    h.ctl.choose("INTERESTED");
    expect(st(h).draft).toBeNull(); // not before the read
    h.details[0]!.resolve(detail("L1", "A", evPage(["n1"]), { status: "QUALIFIED", revision: 6 }));
    await h.flush();
    expect(lead(h)).toMatchObject({ status: "QUALIFIED", revision: 6 });
    expect(st(h)).toMatchObject({ needsRead: false, notice: { kind: "stale" } });
    expect(h.changes).toHaveLength(1); // still the single original request
  });

  it("ALREADY_OPEN: not reported as a success; the contact's open lead is looked up with the read, a link only if the API names one", async () => {
    const h = harness(detail("L1", "A", evPage([]), { status: "NOT_INTERESTED", revision: 7 }));
    h.ctl.choose("NEW");
    h.ctl.requestChange();
    h.ctl.confirm();
    h.changes[0]!.reject(new ApiError(409, "ALREADY_OPEN"));
    await h.flush();
    expect(st(h).notice).toEqual({ kind: "already_open" });
    expect(h.contacts).toEqual([expect.objectContaining({ contactId: CONTACT })]);
    h.contacts[0]!.resolve(contactLeads(OTHER_LEAD));
    h.details[0]!.resolve(detail("L1", "A", evPage([]), { status: "NOT_INTERESTED", revision: 7 }));
    await h.flush();
    expect(st(h).notice).toEqual({ kind: "already_open", openLeadId: OTHER_LEAD });
    expect(lead(h).status).toBe("NOT_INTERESTED"); // the lead stayed closed
  });

  it("ALREADY_OPEN: no link when the lookup finds none, names this very lead, or fails", async () => {
    for (const lookup of [
      (c: Held<ContactLeads>) => c.resolve(contactLeads(null)),
      (c: Held<ContactLeads>) => c.resolve(contactLeads("L1")),
      (c: Held<ContactLeads>) => c.resolve(contactLeads("\uD800")), // an id that cannot become a link
      (c: Held<ContactLeads>) => c.reject(new ApiError(500, "INTERNAL_ERROR")),
    ]) {
      const h = harness(detail("L1", "A", evPage([]), { status: "INVALID", revision: 7 }));
      h.ctl.choose("NEW");
      h.ctl.requestChange();
      h.ctl.confirm();
      h.changes[0]!.reject(new ApiError(409, "ALREADY_OPEN"));
      await h.flush();
      lookup(h.contacts[0]!);
      h.details[0]!.resolve(detail("L1", "A", evPage([]), { status: "INVALID", revision: 7 }));
      await h.flush();
      expect(st(h).notice).toEqual({ kind: "already_open", openLeadId: null });
    }
  });

  it("RESERVED_STATUS: not retried, the authoritative state is read, the restriction stays", async () => {
    const h = sending();
    h.changes[0]!.reject(new ApiError(409, "RESERVED_STATUS"));
    await h.flush();
    expect(st(h).notice).toEqual({ kind: "reserved" });
    h.details[0]!.resolve(
      detail("L1", "A", evPage([]), { status: "PAID", readOnly: true, revision: 6 }),
    );
    await h.flush();
    h.ctl.choose("QUALIFIED");
    expect(st(h).draft).toBeNull(); // a read-only lead offers nothing
    expect(h.changes).toHaveLength(1);
  });

  it("403 is a refusal, never a success; the read shows what the account may do now", async () => {
    const h = sending();
    h.changes[0]!.reject(new ApiError(403, "FORBIDDEN"));
    await h.flush();
    expect(st(h).notice).toEqual({ kind: "forbidden" });
    h.details[0]!.resolve(detail("L1", "A", evPage([]), { edit: false }));
    await h.flush();
    h.ctl.choose("QUALIFIED");
    expect(st(h).draft).toBeNull();
  });

  it("401 is reported and nothing more is requested (a read would be refused too)", async () => {
    const h = sending();
    h.changes[0]!.reject(new ApiError(401, "UNAUTHENTICATED"));
    await h.flush();
    expect(st(h).notice).toEqual({ kind: "unauthenticated" });
    expect(h.details).toHaveLength(0);
    expect(lead(h).status).toBe("NEW");
  });

  it("404 hides the lead", async () => {
    const h = sending();
    h.changes[0]!.reject(new ApiError(404, "NOT_FOUND"));
    await h.flush();
    expect(h.ctl.getState().unavailable).toBe(true);
  });
});

describe("unknown outcomes", () => {
  for (const [label, error] of [
    ["a dropped connection or timeout", new ApiError(0, "NETWORK")],
    ["a server error", new ApiError(500, "INTERNAL_ERROR")],
    ["a success that could not be read", new ApiError(200, "BAD_RESPONSE")],
  ] as const)
    it(`${label}: never repeated, said to be unknown, the lead is read, and the control waits for that read`, async () => {
      const h = sending();
      h.changes[0]!.reject(error);
      await h.flush();
      expect(st(h)).toMatchObject({
        notice: { kind: "outcome_unknown", to: "QUALIFIED", revision: 5 },
        needsRead: true,
        draft: null,
        confirm: null,
      });
      expect(lead(h).status).toBe("NEW"); // not shown as changed
      expect(h.changes).toHaveLength(1); // no repeat
      expect(h.details).toHaveLength(1); // a read instead
      h.ctl.choose("QUALIFIED");
      expect(st(h).draft).toBeNull();
      h.details[0]!.resolve(
        detail("L1", "A", evPage(["e4", "e3"]), { status: "QUALIFIED", revision: 6 }),
      );
      await h.flush();
      expect(lead(h)).toMatchObject({ status: "QUALIFIED", revision: 6 });
      expect(st(h)).toMatchObject({ needsRead: false, notice: { kind: "outcome_unknown" } });
      expect(h.changes).toHaveLength(1);
    }, 5000);

  it("if the read fails too the uncertainty stays: the control stays unavailable and only a READ can be retried", async () => {
    const h = sending();
    h.changes[0]!.reject(new ApiError(0, "NETWORK"));
    await h.flush();
    h.details[0]!.reject(new ApiError(0, "NETWORK"));
    await h.flush();
    expect(st(h)).toMatchObject({ needsRead: true, notice: { kind: "outcome_unknown" } });
    expect(h.ctl.getState().error).toMatchObject({ during: "refresh", info: { next: "retry" } });
    h.ctl.choose("INTERESTED");
    expect(st(h).draft).toBeNull();
    h.ctl.retry();
    expect(h.details).toHaveLength(2);
    expect(h.changes).toHaveLength(1); // Retry repeats the read, never the change
    h.details[1]!.resolve(detail());
    await h.flush();
    expect(st(h).needsRead).toBe(false);
  });

  it("a confirmed change whose follow-up read fails is a confirmed change with details that are not verified", async () => {
    const h = sending();
    h.changes[0]!.resolve(result(true, "QUALIFIED", 6));
    await h.flush();
    h.details[0]!.reject(new ApiError(500, "INTERNAL_ERROR"));
    await h.flush();
    expect(st(h)).toMatchObject({ notice: { kind: "changed" }, needsRead: true });
    expect(lead(h)).toMatchObject({ status: "QUALIFIED", revision: 6 }); // the server's own answer
    expect(h.ctl.getState().error?.during).toBe("refresh");
    h.ctl.choose("INTERESTED");
    expect(st(h).draft).toBeNull();
  });
});

describe("a read while a decision is pending", () => {
  it("a read at the same revision keeps the choice", async () => {
    const h = harness();
    h.ctl.choose("QUALIFIED");
    h.ctl.refresh();
    h.details[0]!.resolve(detail());
    await h.flush();
    expect(st(h).draft).toEqual({ to: "QUALIFIED", revision: 5 });
  });

  it("a read at ANOTHER revision clears the choice and says so: it is never sent with the newer revision", async () => {
    const h = harness();
    h.ctl.choose("QUALIFIED");
    h.ctl.refresh();
    h.details[0]!.resolve(detail("L1", "A", evPage([]), { status: "INTERESTED", revision: 6 }));
    await h.flush();
    expect(st(h)).toMatchObject({ draft: null, notice: { kind: "decision_invalidated" } });
    h.ctl.requestChange();
    expect(h.changes).toHaveLength(0);
    expect(lead(h).revision).toBe(6);
  });

  it("a read at another revision closes an open confirmation too, and confirming afterwards sends nothing", async () => {
    const h = harness();
    h.ctl.choose("NOT_INTERESTED");
    h.ctl.requestChange();
    expect(st(h).confirm).not.toBeNull();
    // (the screen refuses a refresh while a dialog is open; the controller must hold even if one arrives)
    h.ctl.refresh();
    h.details[0]!.resolve(detail("L1", "A", evPage([]), { revision: 6 }));
    await h.flush();
    expect(st(h)).toMatchObject({
      confirm: null,
      draft: null,
      notice: { kind: "decision_invalidated" },
    });
    h.ctl.confirm();
    expect(h.changes).toHaveLength(0);
  });

  it("a reading older than what the page already holds is not applied", async () => {
    const h = sending();
    h.changes[0]!.resolve(result(true, "QUALIFIED", 6));
    await h.flush();
    h.details[0]!.resolve(detail("L1", "STALE", evPage([]), { status: "NEW", revision: 5 }));
    await h.flush();
    expect(lead(h)).toMatchObject({ status: "QUALIFIED", revision: 6 });
    expect(h.name()).toBe("Amaya");
    expect(st(h).needsRead).toBe(true); // still not read
  });

  it("a manual refresh clears an old message; a read that is owed keeps it", async () => {
    const h = harness();
    h.ctl.choose("QUALIFIED");
    h.ctl.requestChange();
    h.changes[0]!.resolve(result(true, "QUALIFIED", 6));
    await h.flush();
    h.details[0]!.resolve(detail("L1", "A", evPage([]), { status: "QUALIFIED", revision: 6 }));
    await h.flush();
    expect(st(h).notice).not.toBeNull();
    h.ctl.refresh();
    expect(st(h).notice).toBeNull();
  });
});

describe("the account changes or the page is left while a change is pending", () => {
  it("ACTOR_CHANGED on the change blocks the page: no notice, no read, nothing of the decision survives", async () => {
    const h = sending();
    h.changes[0]!.reject(new ApiError(409, "ACTOR_CHANGED"));
    await h.flush();
    expect(h.ctl.getState()).toMatchObject({ blocked: true, phase: "ready" });
    expect(st(h)).toEqual({ draft: null, confirm: null, notice: null, needsRead: false });
    expect(h.details).toHaveLength(0);
    expect(h.contacts).toHaveLength(0);
  });

  it("blocking while the change is pending: a late success or failure changes nothing and enables nothing", async () => {
    const h = sending();
    h.ctl.block();
    expect(h.changes[0]!.signal.aborted).toBe(true);
    h.changes[0]!.resolve(result(true, "QUALIFIED", 6));
    await h.flush();
    expect(lead(h)).toMatchObject({ status: "NEW", revision: 5 });
    expect(h.ctl.getState()).toMatchObject({ blocked: true, phase: "ready" });
    expect(st(h).notice).toBeNull();
    h.ctl.choose("INTERESTED");
    h.ctl.requestChange();
    h.ctl.confirm();
    h.ctl.refresh();
    expect(h.changes).toHaveLength(1);
    expect(h.details).toHaveLength(0);

    const f = sending();
    f.ctl.block();
    f.changes[0]!.reject(new ApiError(0, "NETWORK"));
    await f.flush();
    expect(st(f).notice).toBeNull();
    expect(f.details).toHaveLength(0);
  });

  it("the sticky flag stops a change before it is sent", () => {
    const h = harness();
    h.ctl.choose("QUALIFIED");
    h.changeActor();
    h.ctl.requestChange();
    expect(h.changes).toHaveLength(0);
    expect(h.ctl.getState().blocked).toBe(true);
  });

  it("leaving the page abandons the change: its answer (either way) is never applied, and nothing is read or assumed", async () => {
    const h = sending();
    h.ctl.cancel();
    expect(h.changes[0]!.signal.aborted).toBe(true);
    h.changes[0]!.resolve(result(true, "QUALIFIED", 6));
    await h.flush();
    expect(lead(h)).toMatchObject({ status: "NEW", revision: 5 });
    expect(h.details).toHaveLength(0);

    const f = sending();
    f.ctl.cancel();
    f.changes[0]!.reject(new ApiError(0, "NETWORK"));
    await f.flush();
    expect(st(f).notice).toBeNull();
    expect(f.details).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------- untrustworthy answers (07D-4 review)
const good = (
  o: Record<string, unknown> = {},
  lead: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...(result(true, "QUALIFIED", 6) as unknown as Record<string, unknown>),
  lead: { ...(result(true, "QUALIFIED", 6).lead as unknown as Record<string, unknown>), ...lead },
  ...o, // last: a test may replace the whole lead (null, a string)
});
const decision = { to: "QUALIFIED", revision: 5 } as const;
const withoutChanged = () => {
  const { changed, ...rest } = good();
  void changed;
  return rest;
};

describe("acceptStatusResult: what an answer must be before it is believed", () => {
  it("accepts the documented envelope, and copies only the fields the page needs", () => {
    const answer = good({}, { contact: null, source: 7, extra: "x" });
    expect(acceptStatusResult(answer, "L1", decision)).toEqual({
      changed: true,
      lead: {
        status: "QUALIFIED",
        revision: 6,
        open: true,
        readOnly: false,
        statusChangedAt: "2026-01-02T00:00:00.000Z",
        cycleStartedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    // nothing was written: the same revision
    expect(
      acceptStatusResult(
        { ...good(), changed: false, lead: { ...(good().lead as object), revision: 5 } },
        "L1",
        decision,
      ),
    ).toMatchObject({ changed: false, lead: { revision: 5 } });
  });

  const bad: [string, unknown][] = [
    ["nothing", undefined],
    ["null", null],
    ["a string", "ok"],
    ["an array", []],
    ["no lead (the reviewed case)", { changed: true }],
    ["a null lead", good({ lead: null })],
    ["a lead that is not an object", good({ lead: "L1" })],
    ["changed missing", withoutChanged()],
    ["changed not a boolean", good({ changed: "yes" })],
    ["another lead", good({}, { id: "OTHER" })],
    ["no lead id", good({}, { id: undefined })],
    ["no status", good({}, { status: undefined })],
    ["an unsupported status", good({}, { status: "BOGUS" })],
    ["a reserved status", good({}, { status: "PAID" })],
    ["a status other than the one asked for", good({}, { status: "INTERESTED" })],
    ["no revision", good({}, { revision: undefined })],
    ["a revision that is a string", good({}, { revision: "6" })],
    ["a revision that is not an integer", good({}, { revision: 5.5 })],
    ["a revision that is NaN", good({}, { revision: Number.NaN })],
    ["a change that did not move the revision", good({}, { revision: 5 })],
    ["a change that moved it backwards", good({}, { revision: 4 })],
    ["no change but a moved revision", good({ changed: false }, { revision: 6 })],
    ["an impossible jump (the reviewed 0 -> 101)", good({}, { revision: 101 })],
    ["a jump of two", good({}, { revision: 7 })],
    ["a negative revision", good({}, { revision: -1 })],
    ["a fractional revision", good({}, { revision: 6.0000001 })],
    ["an infinite revision", good({}, { revision: Number.POSITIVE_INFINITY })],
    ["a revision beyond the integer column", good({}, { revision: 2_147_483_648 })],
    ["an unsafe integer revision", good({}, { revision: Number.MAX_SAFE_INTEGER + 2 })],
    ["no change but a regressed revision", good({ changed: false }, { revision: 4 })],
    ["no change but a far revision", good({ changed: false }, { revision: 105 })],
    ["open missing", good({}, { open: undefined })],
    ["readOnly not a boolean", good({}, { readOnly: "no" })],
    ["a timestamp missing", good({}, { statusChangedAt: undefined })],
    ["a timestamp that is not text", good({}, { cycleStartedAt: 1 })],
  ];
  for (const [label, answer] of bad)
    it(`refuses ${label}`, () => {
      expect(acceptStatusResult(answer, "L1", decision)).toBeNull();
    });
});

describe("an answer that cannot be believed is an unknown outcome, never a failure or a success", () => {
  const cases: [string, unknown][] = [
    ["the reviewed {changed: true}", { changed: true }],
    ["a null lead", good({ lead: null })],
    ["a lead without a revision", good({}, { revision: undefined })],
    ["a revision that went backwards", good({}, { revision: 4 })],
    ["an unsupported status", good({}, { status: "BOGUS" })],
    ["another lead's answer", good({}, { id: "OTHER" })],
    ["a body that is not an object", "ok"],
  ];
  for (const [label, answer] of cases)
    it(`${label}: no repeat, a read, the control waits, the lead on screen is untouched`, async () => {
      const h = sending();
      h.changes[0]!.resolve(answer as StatusChangeResult);
      await h.flush();
      expect(h.ctl.getState().phase).toBe("refreshing"); // not stuck "changing"
      expect(st(h)).toMatchObject({
        notice: { kind: "outcome_unknown", to: "QUALIFIED", revision: 5 },
        needsRead: true,
        draft: null,
        confirm: null,
      });
      expect(lead(h)).toMatchObject({ status: "NEW", revision: 5 }); // nothing of the answer was taken over
      expect(h.name()).toBe("Amaya");
      expect(h.changes).toHaveLength(1);
      expect(h.details).toHaveLength(1);
      h.ctl.choose("INTERESTED");
      expect(st(h).draft).toBeNull(); // not before the read

      // the committed change shows up in the read; the notice stays "unknown" (it was never confirmed)
      h.details[0]!.resolve(
        detail("L1", "Amaya", evPage(["e4", "e3"]), { status: "QUALIFIED", revision: 6 }),
      );
      await h.flush();
      expect(lead(h)).toMatchObject({ status: "QUALIFIED", revision: 6 });
      expect(st(h)).toMatchObject({ needsRead: false, notice: { kind: "outcome_unknown" } });
      expect(h.changes).toHaveLength(1);
      h.ctl.choose("INTERESTED");
      expect(st(h).draft).toEqual({ to: "INTERESTED", revision: 6 }); // a new, explicit decision
    });

  it("when the recovery read fails too, the uncertainty stays and only the read can be repeated", async () => {
    const h = sending();
    h.changes[0]!.resolve({ changed: true } as unknown as StatusChangeResult);
    await h.flush();
    h.details[0]!.reject(new ApiError(0, "NETWORK"));
    await h.flush();
    expect(st(h)).toMatchObject({ needsRead: true, notice: { kind: "outcome_unknown" } });
    h.ctl.choose("INTERESTED");
    expect(st(h).draft).toBeNull();
    h.ctl.retry();
    expect(h.details).toHaveLength(2);
    expect(h.changes).toHaveLength(1);
  });

  it("a defect while applying a believed answer does not leave the page pending: it recovers as an unknown outcome and is reported", async () => {
    const h = sending();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let armed = true;
    h.ctl.subscribe(() => {
      if (armed && st(h).notice?.kind === "changed") {
        armed = false;
        throw new Error("a subscriber failed");
      }
    });
    h.changes[0]!.resolve(result(true, "QUALIFIED", 6));
    await h.flush();
    expect(error).toHaveBeenCalledTimes(1); // reported, not swallowed
    error.mockRestore();
    expect(h.ctl.getState().phase).not.toBe("changing");
    expect(st(h)).toMatchObject({ notice: { kind: "outcome_unknown" }, needsRead: true });
    expect(h.changes).toHaveLength(1);
    expect(h.details.length).toBeGreaterThan(0);
  });

  it("a malformed answer after the page was blocked or left changes nothing", async () => {
    const h = sending();
    h.ctl.block();
    h.changes[0]!.resolve({ changed: true } as unknown as StatusChangeResult);
    await h.flush();
    expect(h.details).toHaveLength(0);
    expect(st(h).notice).toBeNull();
    const g = sending();
    g.ctl.cancel();
    g.changes[0]!.resolve({ changed: true } as unknown as StatusChangeResult);
    await g.flush();
    expect(g.details).toHaveLength(0);
  });
});

describe("a read or a page of history that is not what it should be does not leave the page pending", () => {
  it("a malformed lead read is a failed read, retryable, and keeps what is shown", async () => {
    for (const body of [{}, { lead: null }, { lead: { id: "L1" } }, null, "x"]) {
      const h = harness();
      h.ctl.refresh();
      h.details[0]!.resolve(body as unknown as LeadDetail);
      await h.flush();
      expect(h.ctl.getState().phase).toBe("ready");
      expect(h.ctl.getState().error).toMatchObject({ during: "refresh", info: { next: "retry" } });
      expect(h.name()).toBe("Amaya");
    }
  });

  it("a malformed history page is a failed page, retryable, and keeps the loaded events", async () => {
    const h = harness();
    h.ctl.loadOlder();
    h.events[0]!.resolve({ nextCursor: "X" } as unknown as LeadEventPage);
    await h.flush();
    expect(h.ctl.getState().phase).toBe("ready");
    expect(h.ctl.getState().error).toMatchObject({ during: "older" });
    expect(h.ids()).toEqual(["e3", "e2"]);
  });
});

describe("a confirmed change is a fact about the past; the lead's current state comes from the read", () => {
  it("another person's later change is shown as current, and the notice still says what THIS change was", async () => {
    const h = sending();
    h.changes[0]!.resolve(result(true, "QUALIFIED", 6));
    await h.flush();
    // meanwhile somebody else made it INTERESTED (revision 7)
    h.details[0]!.resolve(
      detail("L1", "Amaya", evPage(["e5", "e4"]), { status: "INTERESTED", revision: 7 }),
    );
    await h.flush();
    expect(lead(h)).toMatchObject({ status: "INTERESTED", revision: 7 });
    expect(st(h).notice).toEqual({ kind: "changed", to: "QUALIFIED" });
  });
});

describe("revision semantics of a status change: +1 when changed, unchanged when not, inside the integer column", () => {
  const at = (from: number, changed: boolean, revision: number) =>
    acceptStatusResult(good({ changed }, { revision }), "L1", { to: "QUALIFIED", revision: from });
  it("accepts exactly decision + 1 for a change and exactly the decision for no change, at the boundaries", () => {
    expect(at(0, true, 1)).not.toBeNull();
    expect(at(0, false, 0)).not.toBeNull();
    expect(at(2_147_483_646, true, 2_147_483_647)).not.toBeNull();
    expect(at(2_147_483_647, false, 2_147_483_647)).not.toBeNull();
  });
  it("refuses everything else", () => {
    expect(at(0, true, 0)).toBeNull();
    expect(at(0, true, 2)).toBeNull();
    expect(at(0, true, 101)).toBeNull();
    expect(at(0, false, 1)).toBeNull();
    expect(at(2_147_483_647, true, 2_147_483_648)).toBeNull(); // the column cannot hold it
  });
});

describe("an impossible revision never poisons the page (the reviewed 0 -> 101)", () => {
  it("is an unknown outcome: not taken over, not repeated, the read at revision 1 is accepted and the control is usable again", async () => {
    const h = sending(harness(detail("L1", "Amaya", evPage(["e0"]), { revision: 0 })));
    expect(h.changes[0]).toMatchObject({ expectedRevision: 0 });
    h.changes[0]!.resolve(result(true, "QUALIFIED", 101));
    await h.flush();
    expect(lead(h)).toMatchObject({ status: "NEW", revision: 0 }); // 101 never held
    expect(st(h)).toMatchObject({ notice: { kind: "outcome_unknown" }, needsRead: true });
    expect(h.details).toHaveLength(1);
    h.details[0]!.resolve(
      detail("L1", "Amaya", evPage(["e1", "e0"]), { status: "QUALIFIED", revision: 1 }),
    );
    await h.flush();
    expect(lead(h)).toMatchObject({ status: "QUALIFIED", revision: 1 });
    expect(h.ctl.getState().error).toBeNull();
    expect(st(h).needsRead).toBe(false);
    h.ctl.choose("INTERESTED");
    expect(st(h).draft).toEqual({ to: "INTERESTED", revision: 1 });
    expect(h.changes).toHaveLength(1);
  });

  it("if the recovery read fails, only the read is retried, and its revision 1 is accepted", async () => {
    const h = sending(harness(detail("L1", "Amaya", evPage(["e0"]), { revision: 0 })));
    h.changes[0]!.resolve(result(true, "QUALIFIED", 101));
    await h.flush();
    h.details[0]!.reject(new ApiError(0, "NETWORK"));
    await h.flush();
    expect(st(h).needsRead).toBe(true);
    h.ctl.retry();
    expect(h.changes).toHaveLength(1);
    h.details[1]!.resolve(
      detail("L1", "Amaya", evPage(["e1"]), { status: "QUALIFIED", revision: 1 }),
    );
    await h.flush();
    expect(lead(h).revision).toBe(1);
    expect(st(h).needsRead).toBe(false);
  });
});

/** A valid lead read with one part replaced (by path), for the malformed-nested-data cases. */
function detailWith(path: string[], value: unknown): unknown {
  const d = structuredClone(detail()) as unknown as Record<string, unknown>;
  let at: Record<string, unknown> = d;
  for (const k of path.slice(0, -1)) at = at[k] as Record<string, unknown>;
  if (value === undefined) delete at[path.at(-1)!];
  else at[path.at(-1)!] = value;
  return d;
}
const touch = {
  id: "T1",
  label: "Meta ad",
  receivedAt: "2026-01-01T00:00:00.000Z",
  receivedKey: "k",
  headline: null,
  body: null,
  sourceId: null,
  sourceLink: null,
  mediaType: null,
  mediaLink: null,
  clickIdTail: null,
  initiating: true,
};

describe("a lead read with malformed nested data is a failed read: rejected before it is held, retryable, what is shown stays", () => {
  const cases: [string, unknown][] = [
    ["contact.label null (the reviewed case)", detailWith(["contact", "label"], null)],
    ["no contact", detailWith(["contact"], undefined)],
    ["a label without its name", detailWith(["contact", "label", "displayName"], undefined)],
    ["a label whose `named` is not a boolean", detailWith(["contact", "label", "named"], "yes")],
    ["an idHint that is an object", detailWith(["contact", "label", "idHint"], {})],
    ["the lead's own contact label null", detailWith(["lead", "contact", "label"], null)],
    ["no contact identity", detailWith(["contact", "identity"], null)],
    ["a phone that is an object", detailWith(["contact", "identity", "lastObservedPhone"], {})],
    ["a first-seen time that is a number", detailWith(["contact", "firstSeenAt"], 1)],
    ["conversations not a list", detailWith(["conversations"], {})],
    ["a null conversation", detailWith(["conversations"], [null])],
    [
      "a conversation without an id",
      detailWith(["conversations"], [{ status: "OPEN", accountLabel: "x", lastMessageAt: "t" }]),
    ],
    [
      "a conversation id that is not a UUID (it becomes the Inbox link)",
      detailWith(
        ["conversations"],
        [{ id: "\uD800", status: "OPEN", accountLabel: "x", lastMessageAt: "t" }],
      ),
    ],
    [
      "a contact id that is not a UUID (the contact lookup path)",
      detailWith(["contact", "id"], "\uD800"),
    ],
    [
      "the lead's own contact id that is not a UUID",
      detailWith(["lead", "contact", "id"], "not-a-uuid"),
    ],
    ["no attribution", detailWith(["attribution"], null)],
    ["an unknown source kind", detailWith(["attribution", "source", "kind"], "__proto__")],
    ["a null linked touch", detailWith(["attribution", "linked"], [null])],
    [
      "a linked touch with a headline object",
      detailWith(["attribution", "linked"], [{ ...touch, headline: {} }]),
    ],
    ["a linked total that is text", detailWith(["attribution", "linkedTotal"], "1")],
    [
      "a latest touch without an id",
      detailWith(["attribution", "latest"], { ...touch, id: undefined }),
    ],
    [
      "other evidence without its attachment",
      detailWith(["attribution", "otherForContact"], [{ ...touch, decision: null }]),
    ],
    [
      "other evidence with a numeric decision",
      detailWith(
        ["attribution", "otherForContact"],
        [{ ...touch, attachment: "UNLINKED", decision: 3 }],
      ),
    ],
    ["a null initial history event", detailWith(["history", "events"], [null])],
    [
      "an initial event without an id",
      detailWith(["history", "events"], [{ ...ev("x"), id: undefined }]),
    ],
    ["an empty history cursor", detailWith(["history", "nextCursor"], "")],
    ["an unknown lead status", detailWith(["lead", "status"], "BOGUS")],
    ["a negative revision", detailWith(["lead", "revision"], -1)],
    ["a revision beyond the column", detailWith(["lead", "revision"], 2_147_483_648)],
    ["a lifecycle time that is not text", detailWith(["lead", "statusChangedAt"], 0)],
    ["a closedAt that is an object", detailWith(["lead", "closedAt"], {})],
    ["no permissions", detailWith(["can"], null)],
  ];
  for (const [label, body] of cases)
    it(label, async () => {
      const h = harness();
      h.ctl.refresh();
      h.details[0]!.resolve(body as LeadDetail);
      await h.flush();
      expect(h.ctl.getState()).toMatchObject({
        phase: "ready",
        error: { during: "refresh", info: { next: "retry" } },
      });
      expect(h.name()).toBe("Amaya");
      expect(h.ids()).toEqual(["e3", "e2"]);
      h.ctl.retry();
      h.details[1]!.resolve(detail("L1", "Kasun"));
      await h.flush();
      expect(h.ctl.getState().error).toBeNull();
      expect(h.name()).toBe("Kasun");
    });

  it("accepts the contract's nullable and optional values", async () => {
    const full = detailWith(["attribution"], {
      source: {
        kind: "META_AD",
        label: "Meta ad",
        adTouches: 1,
        linkedTouches: 1,
        firstReceivedAt: null,
        latestReceivedAt: null,
      },
      linked: [touch],
      linkedTotal: 3,
      first: touch,
      latest: { ...touch, id: "T9", headline: "h", body: "b", clickIdTail: "1234" },
      otherForContact: [
        { ...touch, id: "T2", initiating: false, attachment: "OTHER_LEAD", decision: null },
      ],
      otherTotal: 1,
    }) as Record<string, Record<string, unknown>>;
    full.lead!.closedAt = "2026-01-03T00:00:00.000Z";
    full.lead!.origin = null;
    full.contact!.label = { displayName: "…4821", named: false, idHint: "…4821" };
    full.conversations = [
      {
        id: "00000000-0000-4000-8000-0000000000d1",
        status: "RESOLVED",
        accountLabel: "+94",
        lastMessageAt: "t",
      },
    ] as never;
    full.history = {
      events: [
        {
          ...ev("a"),
          kind: "TOUCH_LINKED",
          actorName: null,
          from: null,
          to: null,
          revision: null,
          touch: { id: "T1", label: "Meta ad" },
        },
        { ...ev("b"), kind: "CREATED", origin: "AD_REFERRAL", from: null, to: null, revision: 0 },
        { ...ev("c"), kind: "FUTURE_KIND" }, // unknown kinds have a documented fallback label
      ],
      nextCursor: "opaque",
    } as never;
    const h = harness();
    h.ctl.refresh();
    h.details[0]!.resolve(full as unknown as LeadDetail);
    await h.flush();
    expect(h.ctl.getState().error).toBeNull();
    expect(h.ids()).toEqual(["a", "b", "c"]);
  });

  it("an older lead read that fails validation does not count as the read a status change waits for", async () => {
    const h = sending();
    h.changes[0]!.resolve(result(true, "QUALIFIED", 6));
    await h.flush();
    h.details[0]!.resolve(detailWith(["contact", "label"], null) as LeadDetail);
    await h.flush();
    expect(st(h).needsRead).toBe(true);
    h.ctl.choose("INTERESTED");
    expect(st(h).draft).toBeNull();
    h.ctl.retry();
    h.details[1]!.resolve(
      detail("L1", "Amaya", evPage(["e4"]), { status: "QUALIFIED", revision: 6 }),
    );
    await h.flush();
    expect(st(h).needsRead).toBe(false);
  });
});

describe("a malformed page of older history is rejected whole: nothing appended, the same cursor retried", () => {
  const cases: [string, unknown][] = [
    ["a null event (the reviewed case)", { events: [null], nextCursor: null }],
    ["an event without an id", { events: [{ ...ev("x"), id: undefined }], nextCursor: null }],
    ["an event with a numeric id", { events: [{ ...ev("x"), id: 7 }], nextCursor: null }],
    ["an event whose time is not text", { events: [{ ...ev("x"), at: null }], nextCursor: null }],
    [
      "an event with an unknown target status",
      { events: [{ ...ev("x"), to: "BOGUS" }], nextCursor: null },
    ],
    [
      "an event whose touch has no label",
      { events: [{ ...ev("x"), touch: { id: "T" } }], nextCursor: null },
    ],
    [
      "an event whose actor is an object",
      { events: [{ ...ev("x"), actorName: {} }], nextCursor: null },
    ],
    ["one bad event among good ones", { events: [ev("e1"), null], nextCursor: null }],
    ["a numeric cursor", { events: [ev("e1")], nextCursor: 5 }],
    ["an empty cursor", { events: [ev("e1")], nextCursor: "" }],
    ["a missing cursor", { events: [ev("e1")] }],
    ["events that are not a list", { events: {}, nextCursor: null }],
  ];
  for (const [label, body] of cases)
    it(label, async () => {
      const h = harness();
      h.ctl.loadOlder();
      h.events[0]!.resolve(body as LeadEventPage);
      await h.flush();
      expect(h.ctl.getState()).toMatchObject({
        phase: "ready",
        error: { during: "older", info: { next: "retry" } },
      });
      expect(h.ids()).toEqual(["e3", "e2"]);
      expect(h.ctl.getState().history.nextCursor).toBe("C1");
      h.ctl.retry();
      expect(h.events[1]).toMatchObject({ cursor: "C1" });
      h.events[1]!.resolve(evPage(["e2", "e1", "e0"], null)); // e2 again: kept once
      await h.flush();
      expect(h.ctl.getState().error).toBeNull();
      expect(h.ids()).toEqual(["e3", "e2", "e1", "e0"]);
    });

  it("accepts an empty page and an opaque string cursor", async () => {
    const h = harness();
    h.ctl.loadOlder();
    h.events[0]!.resolve(evPage(["e1"], "an/opaque+cursor=="));
    await h.flush();
    expect(h.ctl.getState().history.nextCursor).toBe("an/opaque+cursor==");
    h.ctl.loadOlder();
    h.events[1]!.resolve(evPage([], null));
    await h.flush();
    expect(h.ctl.getState()).toMatchObject({ phase: "ready", error: null });
    expect(h.ids()).toEqual(["e3", "e2", "e1"]);
  });
});

describe("a defect while applying a read does not leave the page busy", () => {
  for (const during of ["refresh", "older"] as const)
    it(`${during}: the read ends as a retryable failure and the defect is reported`, async () => {
      const h = harness();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let armed = true;
      h.ctl.subscribe(() => {
        if (armed && h.ctl.getState().phase === "ready") {
          armed = false;
          throw new Error("a subscriber failed");
        }
      });
      if (during === "refresh") h.ctl.refresh();
      else h.ctl.loadOlder();
      if (during === "refresh") h.details[0]!.resolve(detail());
      else h.events[0]!.resolve(evPage(["e1"]));
      await h.flush();
      expect(error).toHaveBeenCalledTimes(1);
      error.mockRestore();
      expect(h.ctl.getState()).toMatchObject({ phase: "ready", error: { during } });
    });

  it("a malformed contact lookup after ALREADY_OPEN is only a missing link, never a stuck read", async () => {
    const h = sending();
    h.changes[0]!.reject(new ApiError(409, "ALREADY_OPEN"));
    await h.flush();
    h.contacts[0]!.resolve(null as unknown as ContactLeads);
    h.details[0]!.resolve(detail());
    await h.flush();
    expect(h.ctl.getState()).toMatchObject({ phase: "ready", error: null });
    expect(st(h)).toMatchObject({
      needsRead: false,
      notice: { kind: "already_open", openLeadId: null },
    });
  });
});
