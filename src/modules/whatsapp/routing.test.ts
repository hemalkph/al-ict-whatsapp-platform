import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "./normalize";
import { decideRouting, type AccountRow } from "./routing";

const WABA = "200000000000001";
const PN = "100000000000001";
const account = (o: Partial<AccountRow> = {}): AccountRow => ({
  id: "acc-1",
  organizationId: "org-1",
  wabaId: WABA,
  phoneNumberId: PN,
  status: "ACTIVE",
  archivedAt: null,
  ...o,
});
const event = (o: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  eventType: "MESSAGE",
  wabaId: WABA,
  phoneNumberId: PN,
  idempotencyKey: "k",
  providerObjectId: "w",
  payload: {},
  intrinsic: { kind: "queue" },
  pairing: "wa_id",
  ...o,
});
const accounts = (a?: AccountRow) => new Map(a ? [[a.phoneNumberId, a]] : []);

describe("decideRouting (organization comes only from the account row)", () => {
  it("routes to an ACTIVE account as PENDING", () => {
    expect(decideRouting(event(), accounts(account()))).toEqual({
      status: "PENDING",
      organizationId: "org-1",
      whatsappAccountId: "acc-1",
      reason: null,
    });
  });

  it.each([
    [
      "a PENDING account is held WITH its tenant provenance",
      account({ status: "PENDING" }),
      "UNROUTABLE",
      "account_pending",
      true,
    ],
    [
      "a DISABLED account is ignored",
      account({ status: "DISABLED" }),
      "IGNORED",
      "account_disabled",
      true,
    ],
    [
      "an archived account is ignored",
      account({ archivedAt: new Date() }),
      "IGNORED",
      "account_archived",
      true,
    ],
    [
      "an archived ACTIVE account is ignored",
      account({ status: "ACTIVE", archivedAt: new Date() }),
      "IGNORED",
      "account_archived",
      true,
    ],
  ])("%s", (_name, acc, status, reason, routed) => {
    const decision = decideRouting(event(), accounts(acc));
    expect(decision.status).toBe(status);
    expect(decision.reason).toBe(reason);
    expect(decision.organizationId).toBe(routed ? "org-1" : null);
    expect(decision.whatsappAccountId).toBe(routed ? "acc-1" : null);
  });

  it("holds an unknown phone_number_id as UNROUTABLE with no routing", () => {
    expect(decideRouting(event(), accounts())).toEqual({
      status: "UNROUTABLE",
      organizationId: null,
      whatsappAccountId: null,
      reason: "unknown_account",
    });
  });

  it("holds an event with no phone_number_id as UNROUTABLE", () => {
    expect(decideRouting(event({ phoneNumberId: null }), accounts(account()))).toMatchObject({
      status: "UNROUTABLE",
      reason: "missing_phone_number_id",
    });
  });

  it("treats a WABA mismatch conservatively (a hold, not a drop, not a route) even for an ACTIVE account", () => {
    for (const waba of ["200000000000999", null]) {
      expect(decideRouting(event({ wabaId: waba }), accounts(account()))).toEqual({
        status: "UNROUTABLE",
        organizationId: null,
        whatsappAccountId: null,
        reason: "waba_mismatch",
      });
    }
  });

  it("does not look at anything but the phone_number_id to find the account (payload claims are ignored)", () => {
    const sneaky = event({ payload: { organization_id: "org-evil", organizationId: "org-evil" } });
    expect(decideRouting(sneaky, accounts(account())).organizationId).toBe("org-1");
  });

  it("keeps an ignorable event IGNORED with its own reason, routed only when the account is known and consistent", () => {
    const ignorable = event({ intrinsic: { kind: "ignored", reason: "status_not_mirrored" } });
    expect(decideRouting(ignorable, accounts(account()))).toEqual({
      status: "IGNORED",
      organizationId: "org-1",
      whatsappAccountId: "acc-1",
      reason: "status_not_mirrored",
    });
    expect(decideRouting(ignorable, accounts())).toEqual({
      status: "IGNORED",
      organizationId: null,
      whatsappAccountId: null,
      reason: "status_not_mirrored",
    });
    expect(
      decideRouting(ignorable, accounts(account({ wabaId: "other" }))).organizationId,
    ).toBeNull();
  });

  it("marks a malformed element DEAD without routing", () => {
    expect(
      decideRouting(
        event({ intrinsic: { kind: "dead", reason: "malformed_event" } }),
        accounts(account()),
      ),
    ).toEqual({
      status: "DEAD",
      organizationId: null,
      whatsappAccountId: null,
      reason: "malformed_event",
    });
  });
});
