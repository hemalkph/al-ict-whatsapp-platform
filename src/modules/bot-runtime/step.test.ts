import { describe, expect, it } from "vitest";
import { step, validateFlow, type FlowConfig } from "@/modules/bots";
import type { DbExecutor } from "@/db/ops/executor";
import {
  combineFirstEligibleFact,
  deriveFirstEligibleFact,
  evaluateHourlyCap,
  RUNTIME_POLICY,
} from "./index";
import { FlowCache } from "./flow-cache";
import { endFirstFlow, handoverFirstFlow, menuFlow, messageFlow } from "./testing";

describe("08E-4 test flows are valid published flows", () => {
  for (const [name, flow] of Object.entries({
    menu: menuFlow(),
    endFirst: endFirstFlow("Bye"),
    endFirstSilent: endFirstFlow(),
    handoverFirst: handoverFirstFlow(),
    message: messageFlow(),
    messageFirst: messageFlow({ kind: "first_message" }),
  }))
    it(name, () => {
      const r = validateFlow(flow);
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(r.ok).toBe(true);
    });
});

describe("combineFirstEligibleFact (D.4a) is the one rule", () => {
  it("is true only when all three facts hold and no defect exists", () => {
    const ok = {
      candidateEligible: true,
      firstInRecordHistory: true,
      noPreviousSessionStart: true,
      evidenceDefect: false,
    };
    expect(combineFirstEligibleFact(ok).firstEligible).toBe(true);
    for (const k of [
      "candidateEligible",
      "firstInRecordHistory",
      "noPreviousSessionStart",
    ] as const)
      expect(combineFirstEligibleFact({ ...ok, [k]: false }).firstEligible, k).toBe(false);
    expect(combineFirstEligibleFact({ ...ok, evidenceDefect: true }).firstEligible).toBe(false);
  });
  it("the history-based derivation agrees with it", () => {
    const a = { id: "a", createdAt: 1, direction: "INBOUND" as const, type: "TEXT" };
    const b = { id: "b", createdAt: 2, direction: "INBOUND" as const, type: "TEXT" };
    expect(
      deriveFirstEligibleFact({ candidate: b, history: [a, b], priorSessionStarts: [] })
        .firstEligible,
    ).toBe(false);
    expect(
      deriveFirstEligibleFact({ candidate: a, history: [a, b], priorSessionStarts: [] })
        .firstEligible,
    ).toBe(true);
    expect(
      deriveFirstEligibleFact({
        candidate: a,
        history: [a],
        priorSessionStarts: [{ startMessage: null }],
      }).firstEligible,
    ).toBe(false);
  });
});

describe("hourly cap (C-4)", () => {
  it("refuses a new request at 30, exempts a replay, allows 29", () => {
    expect(evaluateHourlyCap({ recentCount: 29, stepAlreadyHasRequest: false }).decision).toBe(
      "allow",
    );
    expect(evaluateHourlyCap({ recentCount: 30, stepAlreadyHasRequest: false })).toEqual({
      decision: "refuse",
      code: "bot_hourly_cap",
    });
    expect(evaluateHourlyCap({ recentCount: 99, stepAlreadyHasRequest: true }).decision).toBe(
      "replay",
    );
    expect(RUNTIME_POLICY.hourlyBotRequestCap).toBe(30);
  });
});

describe("FlowCache", () => {
  const stub = (config: unknown, sha = "a".repeat(64)) => {
    let reads = 0;
    const tx = {
      execute: async () => {
        reads++;
        return { rows: config === null ? [] : [{ config, config_sha256: sha }] };
      },
    } as unknown as DbExecutor;
    return { tx, reads: () => reads };
  };
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ] as const;

  it("validates a version once per (version, sha) and reports missing and invalid versions without repairing", async () => {
    const cache = new FlowCache();
    const good = stub(menuFlow());
    expect((await cache.load(good.tx, ids[0], ids[1], ids[2])).ok).toBe(true);
    expect((await cache.load(good.tx, ids[0], ids[1], ids[2])).ok).toBe(true);
    expect(cache.size).toBe(1);
    expect(await cache.load(stub(null).tx, ids[0], ids[1], ids[2])).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(
      await cache.load(stub({ schemaVersion: 1 }, "b".repeat(64)).tx, ids[0], ids[1], ids[2]),
    ).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("engine step sequencing (R2): one step per committed event that runs nodes", () => {
  const flow = validateFlow(menuFlow()).config as FlowConfig;
  const T1 = "AAAAAAAAAAAAAAAAAAAAAA";
  const T2 = "BBBBBBBBBBBBBBBBBBBBBB";

  it("start is step 1; accepting the prompt does not start a step; the accepted reply is step 2 and its next prompt is sent at step 2", () => {
    const started = step(flow, null, { type: "start" }, { nowMs: 1_000, promptToken: T1 });
    expect(started.session?.stepSeq).toBe(1);
    expect(started.effects[0]?.stepSeq).toBe(1);
    const reply = {
      kind: "interactive" as const,
      subtype: "button_reply" as const,
      replyId: `b1.${T1}.a`,
    };
    const deferred = step(
      flow,
      started.session,
      { type: "student_input", input: reply, latestRequestState: "SENDING" },
      { nowMs: 2_000, promptToken: T2 },
    );
    expect(deferred).toMatchObject({ changed: false, outcome: "DEFERRED" });
    const applied = step(
      flow,
      started.session,
      { type: "student_input", input: reply, latestRequestState: "ACCEPTED" },
      { nowMs: 3_000, promptToken: T2 },
    );
    expect(applied.input?.result).toBe("accepted");
    expect(applied.session?.stepSeq).toBe(2);
    expect(applied.effects[0]?.stepSeq).toBe(2);
  });
});
