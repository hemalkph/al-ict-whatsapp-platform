import { describe, expect, it } from "vitest";
import { STAFF_SETTABLE_STATUSES, statusOptions } from "../lead-labels";
import {
  choiceHint,
  confirmation,
  noticeContent,
  statusOptionLabel,
  type StatusNotice,
} from "./lead-status";

const ctx = { currentRevision: 7, verified: true };

describe("who can choose what", () => {
  it("offers exactly the six staff-settable statuses, never a reserved one, and none to a viewer, a read-only lead or an unknown status", () => {
    const base = { status: "NEW", readOnly: false, canEdit: true };
    expect(statusOptions(base).map((o) => o.value)).toEqual([...STAFF_SETTABLE_STATUSES]);
    for (const reserved of ["REGISTRATION_STARTED", "REGISTERED", "PAID", "CONVERTED"])
      expect(statusOptions(base).map((o) => o.value)).not.toContain(reserved);
    expect(statusOptions({ ...base, canEdit: false })).toEqual([]);
    expect(statusOptions({ ...base, readOnly: true })).toEqual([]);
    expect(statusOptions({ ...base, status: "PAID", readOnly: true })).toEqual([]);
    expect(statusOptions({ ...base, status: "FROM_A_NEWER_SERVER" })).toEqual([]);
  });

  it("marks the current status in the list", () => {
    expect(statusOptionLabel("NEW", true)).toBe("New (current)");
    expect(statusOptionLabel("QUALIFIED", false)).toBe("Qualified");
  });
});

describe("confirmation", () => {
  it("closing says which status, that the cycle ends, that it is an internal record and that nothing is sent", () => {
    const c = confirmation("INTERESTED", "NOT_INTERESTED")!;
    const text = [c.title, ...c.paragraphs].join(" ");
    expect(c.title).toBe("Close this lead as Not interested?");
    expect(text).toMatch(/closes the lead as Not interested/);
    expect(text).toMatch(/current lead cycle will end/);
    expect(text).toMatch(/internal/);
    expect(text).toMatch(/No WhatsApp message will be sent/);
    expect(c.action).toBe("Close as Not interested");
  });

  it("reopening starts a new cycle but is never promised: the server may refuse it", () => {
    const c = confirmation("INVALID", "NEW")!;
    const text = [c.title, ...c.paragraphs].join(" ");
    expect(c.title).toBe("Reopen this lead as New?");
    expect(text).toMatch(/starts a new lead cycle/);
    expect(text).toMatch(/refused if the contact already has another open lead/);
    expect(text).toMatch(/No WhatsApp message will be sent/);
    expect(text).not.toMatch(/will be reopened|guarantee/i);
  });

  it("an ordinary move or no change needs no dialog", () => {
    expect(confirmation("NEW", "QUALIFIED")).toBeNull();
    expect(confirmation("NOT_INTERESTED", "INVALID")).toBeNull();
    expect(confirmation("NEW", "NEW")).toBeNull();
  });

  it("the line under the control describes only a real change", () => {
    expect(choiceHint("NEW", null)).toBeNull();
    expect(choiceHint("NEW", "NEW")).toBeNull();
    expect(choiceHint("NEW", "QUALIFIED")).toBe("The status changes to Qualified.");
    expect(choiceHint("PAID", "QUALIFIED")).toBeNull(); // a reserved current status offers nothing
  });
});

describe("what each outcome says", () => {
  const notices: StatusNotice[] = [
    { kind: "changed", to: "QUALIFIED" },
    { kind: "unchanged" },
    { kind: "stale" },
    { kind: "already_open" },
    { kind: "already_open", openLeadId: "L2" },
    { kind: "reserved" },
    { kind: "forbidden" },
    { kind: "unauthenticated" },
    { kind: "validation" },
    { kind: "outcome_unknown", to: "QUALIFIED", revision: 5 },
    { kind: "decision_invalidated" },
  ];

  it("every outcome has a title and a body, and none claims a message, registration, payment or consent", () => {
    for (const n of notices) {
      const c = noticeContent(n, ctx);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(0);
      expect(`${c.title} ${c.body}`, n.kind).not.toMatch(
        /registered|paid|payment received|consent given|message was sent to the customer/i,
      );
    }
  });

  it("only a server-confirmed change is a success; a refusal or an unknown outcome never is", () => {
    expect(noticeContent({ kind: "changed", to: "NOT_INTERESTED" }, ctx)).toMatchObject({
      tone: "success",
      body: expect.stringContaining("Not interested"),
    });
    expect(noticeContent({ kind: "unchanged" }, ctx).tone).not.toBe("success");
    for (const n of notices.filter(
      (x) => !["changed", "unchanged", "decision_invalidated"].includes(x.kind),
    ))
      expect(noticeContent(n, ctx).tone, n.kind).toBe("error");
  });

  it("a confirmed change describes the request that was saved, never the lead's current state (someone else may have changed it since)", () => {
    const saved = noticeContent({ kind: "changed", to: "QUALIFIED" }, ctx);
    expect(saved.title).toBe("Your change was saved");
    expect(saved.body).toMatch(/^Your change to Qualified was saved\./);
    expect(saved.body).toMatch(/current status is shown in the status control/);
    expect(saved.body).not.toMatch(/\bis now\b|\bnow\b/i);
    // the same text whatever the revision the page holds now (it is a fact about the past, not about the lead)
    expect(
      noticeContent({ kind: "changed", to: "QUALIFIED" }, { currentRevision: 99, verified: true }),
    ).toEqual(saved);
    expect(noticeContent({ kind: "unchanged" }, ctx).body).toMatch(/When your request arrived/);
    // none of the notices says what the lead "is" now
    for (const n of notices)
      expect(noticeContent(n, ctx).body, n.kind).not.toMatch(/\bthe lead is now\b/i);
  });

  it("every refusal says that nothing was saved, and the stale one says to look before choosing again", () => {
    for (const k of [
      "already_open",
      "reserved",
      "forbidden",
      "unauthenticated",
      "validation",
    ] as const)
      expect(noticeContent({ kind: k }, ctx).body, k).toMatch(/Nothing was saved/);
    expect(noticeContent({ kind: "stale" }, ctx).body).toMatch(/not saved/);
    expect(noticeContent({ kind: "stale" }, ctx).body).toMatch(/choose again/);
  });

  it("an unknown outcome never says the change failed or succeeded, says it was not repeated, and tells what the read showed", () => {
    const n: StatusNotice = { kind: "outcome_unknown", to: "QUALIFIED", revision: 5 };
    for (const c of [
      noticeContent(n, { currentRevision: 5, verified: false }),
      noticeContent(n, { currentRevision: 5, verified: true }),
      noticeContent(n, { currentRevision: 6, verified: true }),
    ]) {
      expect(c.title).toBe("We could not confirm whether the change was saved");
      expect(c.body).toMatch(/may or may not have been applied/);
      expect(c.body).toMatch(/not repeated/);
      expect(c.body).not.toMatch(/failed|did not work|was saved\./i);
    }
    expect(noticeContent(n, { currentRevision: 5, verified: false }).body).toMatch(
      /has to be checked/,
    );
    expect(noticeContent(n, { currentRevision: 5, verified: true }).body).toMatch(
      /shows the lead unchanged, but a slow request could still complete/,
    );
    expect(noticeContent(n, { currentRevision: 6, verified: true }).body).toMatch(
      /has changed since you opened it/,
    );
  });
});
