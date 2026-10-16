import { describe, expect, it } from "vitest";
import type { LeadEventView, LeadStatus } from "@/modules/leads";
import {
  LEAD_STATUSES,
  RESERVED_STATUSES,
  SOURCE_EXPLANATION,
  SOURCE_LABEL,
  STAFF_SETTABLE_STATUSES,
  STATUS_LABEL,
  eventText,
  isReservedStatus,
  needsConfirmation,
  originLabel,
  otherEvidenceLabel,
  sourceLabel,
  stateLabel,
  statusLabel,
  statusOptions,
  transitionDescription,
  transitionKind,
} from "./lead-labels";

// (The match with the server's enums and planTransition is in src/modules/leads/ui-contract.test.ts.)

describe("status labels and options", () => {
  it("every status has a non-empty, distinct label", () => {
    const labels = LEAD_STATUSES.map((s) => STATUS_LABEL[s]);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(LEAD_STATUSES.length);
  });

  it("an unknown value is labelled as unknown, not guessed", () => {
    expect(statusLabel("ARCHIVED")).toBe("Unknown status");
    expect(statusLabel("")).toBe("Unknown status");
    expect(statusLabel("NEW")).toBe("New");
  });

  it("staff options are exactly the six settable statuses, current one marked, never a reserved one", () => {
    const opts = statusOptions({ status: "QUALIFIED", readOnly: false, canEdit: true });
    expect(opts.map((o) => o.value)).toEqual([...STAFF_SETTABLE_STATUSES]);
    expect(opts.filter((o) => o.current).map((o) => o.value)).toEqual(["QUALIFIED"]);
    for (const r of RESERVED_STATUSES) expect(opts.map((o) => o.value)).not.toContain(r);
  });

  it("no options for a read-only lead, a reserved or unknown status, or a viewer who cannot edit", () => {
    expect(statusOptions({ status: "NEW", readOnly: true, canEdit: true })).toEqual([]);
    expect(statusOptions({ status: "NEW", readOnly: false, canEdit: false })).toEqual([]);
    for (const r of RESERVED_STATUSES)
      expect(statusOptions({ status: r, readOnly: false, canEdit: true }), r).toEqual([]);
    expect(statusOptions({ status: "SOMETHING_NEW", readOnly: false, canEdit: true })).toEqual([]);
    expect(isReservedStatus("PAID")).toBe(true);
    expect(isReservedStatus("NEW")).toBe(false);
  });

  it("state labels", () => {
    expect([stateLabel(true), stateLabel(false)]).toEqual(["Open", "Closed"]);
  });
});

describe("transitions", () => {
  it("close, reopen, move and none, and only close/reopen need confirmation", () => {
    expect(transitionKind("NEW", "NOT_INTERESTED")).toBe("close");
    expect(transitionKind("INVALID", "QUALIFIED")).toBe("reopen");
    expect(transitionKind("NEW", "INTERESTED")).toBe("move");
    expect(transitionKind("NO_RESPONSE", "INVALID")).toBe("move");
    expect(transitionKind("NEW", "NEW")).toBe("none");
    expect([needsConfirmation("close"), needsConfirmation("reopen")]).toEqual([true, true]);
    expect([needsConfirmation("move"), needsConfirmation("none")]).toEqual([false, false]);
  });

  it("descriptions say what happens to the lifecycle, and that reopening can be refused", () => {
    expect(transitionDescription("NEW", "NOT_INTERESTED")).toMatch(
      /closes the lead as Not interested/,
    );
    expect(transitionDescription("INVALID", "NEW")).toMatch(/new lead cycle.*another open lead/);
    expect(transitionDescription("NEW", "QUALIFIED")).toBe("The status changes to Qualified.");
    expect(transitionDescription("NEW", "NEW")).toBe("The lead is already New.");
  });
});

describe("attribution wording stays honest", () => {
  it("the three source kinds stay distinct; NONE is never 'organic'; none claims registration, payment or consent", () => {
    expect(new Set(Object.values(SOURCE_LABEL)).size).toBe(3);
    expect(SOURCE_LABEL.OTHER_REFERRAL).toMatch(/not a confirmed Meta ad/);
    expect(SOURCE_LABEL.NONE).toBe("No referral recorded");
    for (const text of [...Object.values(SOURCE_LABEL), ...Object.values(SOURCE_EXPLANATION)]) {
      expect(text).not.toMatch(/organic/i);
      expect(text).not.toMatch(/\b(registered|paid|purchased|consented|converted)\b/i);
    }
    expect(SOURCE_EXPLANATION.META_AD).toMatch(
      /not a confirmed registration, payment or marketing consent/,
    );
    expect(SOURCE_EXPLANATION.NONE).toMatch(/does not mean/);
  });

  it("an unknown source kind is not folded into a known one", () => {
    expect(sourceLabel({ kind: "FUTURE_KIND" as "NONE" })).toBe("Unknown referral information");
    expect(sourceLabel({ kind: "META_AD" })).toBe("Meta ad referral recorded");
  });

  it("origin and contact-level evidence", () => {
    expect(originLabel("MANUAL")).toBe("Created by staff");
    expect(originLabel("AD_REFERRAL")).toMatch(/Meta ad referral/);
    expect(originLabel(null)).toMatch(/Not recorded/);
    expect(otherEvidenceLabel({ attachment: "OTHER_LEAD", decision: null })).toMatch(
      /another lead/,
    );
    expect(otherEvidenceLabel({ attachment: "UNLINKED", decision: null })).toBe(
      "Not linked to any lead yet",
    );
    expect(otherEvidenceLabel({ attachment: "UNLINKED", decision: "SKIPPED_STALE" })).toMatch(
      /too old/,
    );
    expect(otherEvidenceLabel({ attachment: "UNLINKED", decision: "PARKED" })).toMatch(/stopped/);
  });

  it("SKIPPED_BEFORE_CYCLE says the evidence belongs to an earlier cycle, which stays true for a delayed delivery", () => {
    // The documented case (07D-1 review): the current cycle began at 11:00; the provider says the message was sent at 10:00; it
    // reached us at 12:00. The reconciler dates evidence by the EARLIER of the two times (ADR 0016), i.e. 10:00, so the evidence
    // belongs to the earlier cycle although it ARRIVED after the new cycle began. The label must not say "received before".
    const cycleStart = Date.parse("2026-03-01T11:00:00Z");
    const providerTime = Date.parse("2026-03-01T10:00:00Z");
    const receivedAt = Date.parse("2026-03-01T12:00:00Z");
    expect(receivedAt).toBeGreaterThan(cycleStart); // it arrived after the cycle began...
    expect(Math.min(providerTime, receivedAt)).toBeLessThan(cycleStart); // ...yet it dates from before it
    const label = otherEvidenceLabel({ attachment: "UNLINKED", decision: "SKIPPED_BEFORE_CYCLE" });
    expect(label).toBe("Not linked: evidence belongs to an earlier lead cycle");
    expect(label).not.toMatch(/receiv|arriv|deliver/i);
    expect(otherEvidenceLabel({ attachment: "UNLINKED", decision: "SOMETHING_NEW" })).toBe(
      "Not linked",
    );
  });
});

describe("history wording follows only what the event records", () => {
  const ev = (over: Partial<LeadEventView>): LeadEventView => ({
    id: "e",
    kind: "STATUS",
    at: "2026-01-01T00:00:00.000Z",
    atKey: "2026-01-01T00:00:00.000000Z",
    actorName: "Amara",
    origin: null,
    from: null,
    to: null,
    revision: 1,
    touch: null,
    ...over,
  });

  it("created, status and linked evidence", () => {
    expect(eventText(ev({ kind: "CREATED", origin: "MANUAL" }))).toBe("Amara created the lead");
    expect(eventText(ev({ kind: "CREATED", origin: "AD_REFERRAL", actorName: null }))).toBe(
      "Lead created automatically from a Meta ad referral",
    );
    expect(eventText(ev({ kind: "CREATED", origin: null, actorName: null }))).toBe("Lead created");
    expect(eventText(ev({ from: "NEW", to: "QUALIFIED" }))).toBe(
      "Amara changed the status from New to Qualified",
    );
    expect(eventText(ev({ actorName: null, from: "NEW", to: "INVALID" }))).toMatch(
      /^The system changed/,
    );
    expect(
      eventText(
        ev({ kind: "TOUCH_LINKED", actorName: null, touch: { id: "t", label: "Meta ad" } }),
      ),
    ).toBe("Referral evidence linked (Meta ad)");
    expect(eventText(ev({ kind: "OTHER" as "STATUS" }))).toBe("Recorded change");
    expect(eventText(ev({ from: "NEW", to: "BOGUS" as LeadStatus }))).toMatch(/Unknown status/);
  });

  it("no history line claims a click, registration, payment or consent", () => {
    const lines = [
      eventText(ev({ kind: "CREATED", origin: "AD_REFERRAL" })),
      eventText(ev({ kind: "TOUCH_LINKED", touch: { id: "t", label: "Meta ad" } })),
    ];
    for (const l of lines) expect(l).not.toMatch(/click|registered|paid|consent/i);
  });
});
