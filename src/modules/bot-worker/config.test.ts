import { describe, expect, it } from "vitest";
import { gateBehaviour } from "@/modules/bot-runtime";
import { readBotWorkerConfig } from "./config";
import {
  MAX_CONCURRENCY,
  MIN_SERVER_VERSION_NUM,
  poolSize,
  SESSION_SETTINGS,
  SHUTDOWN_GRACE_MS,
} from "./policy";

// E-GATE (Phase 08E-7; plan M, N.2): the bot worker's startup decision from explicit environment objects (never process.env).

const URL_ = "postgres://worker:SECRETPW@127.0.0.1:55432/al_ict_test_x";
const ON = { BOTS_RUNTIME_ENABLED: "true", WHATSAPP_OUTBOUND_ENABLED: "true", DATABASE_URL: URL_ };
const NOT_EXACT = [
  undefined,
  "",
  "false",
  "TRUE",
  "True",
  "1",
  "yes",
  "on",
  " true",
  "true ",
  "tru",
];

describe("bot worker startup gates (E-GATE)", () => {
  it("both gates exactly 'true' with a valid database URL: ready (live-send neither required nor consulted)", () => {
    for (const live of [undefined, "true", "false"])
      expect(readBotWorkerConfig({ ...ON, WHATSAPP_LIVE_SEND_ENABLED: live })).toEqual({
        kind: "ready",
        config: { databaseUrl: URL_, concurrency: 4 },
      });
  });

  for (const gate of ["BOTS_RUNTIME_ENABLED", "WHATSAPP_OUTBOUND_ENABLED"] as const)
    it(`${gate} not exactly 'true' -> refused (every non-exact value), before any other check`, () => {
      for (const value of NOT_EXACT) {
        const r = readBotWorkerConfig({ ...ON, [gate]: value, DATABASE_URL: "not a url" });
        expect(r.kind, String(value)).toBe("refused"); // refused, not "invalid": the gates come first
        if (r.kind === "refused") expect(r.problems.join(" ")).toContain(gate);
      }
    });

  it("both gates off (the default, an empty environment) -> refused naming both keys and no value", () => {
    const r = readBotWorkerConfig({});
    expect(r).toEqual({
      kind: "refused",
      problems: [
        "BOTS_RUNTIME_ENABLED (must be exactly true)",
        "WHATSAPP_OUTBOUND_ENABLED (must be exactly true)",
      ],
    });
  });

  it("invalid database URL or lane count -> invalid, naming the key only (never the password)", () => {
    for (const url of [undefined, "", "mysql://x@h/db", "postgres://", "not a url"]) {
      const r = readBotWorkerConfig({ ...ON, DATABASE_URL: url });
      expect(r.kind).toBe("invalid");
    }
    for (const c of ["0", "17", "-1", "1.5", "a", "100"]) {
      const r = readBotWorkerConfig({ ...ON, BOTS_WORKER_CONCURRENCY: c });
      expect(r.kind, c).toBe("invalid");
      expect(JSON.stringify(r)).not.toContain("SECRETPW");
    }
    expect(
      readBotWorkerConfig({ ...ON, BOTS_WORKER_CONCURRENCY: String(MAX_CONCURRENCY) }),
    ).toMatchObject({
      kind: "ready",
      config: { concurrency: MAX_CONCURRENCY },
    });
  });

  it("the three-process matrix of plan M: only row 8 lets a NEW bot message reach Meta; the bot worker alone never does", () => {
    const off = {};
    const pb = { BOTS_RUNTIME_ENABLED: "true", WHATSAPP_OUTBOUND_ENABLED: "true" };
    const pw = { BOTS_RUNTIME_ENABLED: "true" };
    const pdAll = {
      WHATSAPP_OUTBOUND_ENABLED: "true",
      WHATSAPP_LIVE_SEND_ENABLED: "true",
      BOTS_RUNTIME_ENABLED: "true",
    };
    const pdNoBots = { WHATSAPP_OUTBOUND_ENABLED: "true", WHATSAPP_LIVE_SEND_ENABLED: "true" };
    const rows = [
      [off, off, off, false, false, false],
      [pw, off, off, true, false, false],
      [off, pb, off, false, true, false],
      [pw, pb, off, true, true, false],
      [pw, pb, pdNoBots, true, true, false],
      [off, off, pdAll, false, false, false],
      [pw, { BOTS_RUNTIME_ENABLED: "true" }, off, true, false, false],
      [pw, pb, pdAll, true, true, true],
    ] as const;
    for (const [i, [w, b, d, captures, starts, reaches]] of rows.entries()) {
      const g = gateBehaviour({ webhookWorker: w, botWorker: b, outboundWorker: d });
      expect(
        [g.capturesTriggers, g.botWorkerStarts, g.newBotMessagesCanReachMeta],
        `row ${i + 1}`,
      ).toEqual([captures, starts, reaches]);
      expect(
        readBotWorkerConfig({ ...b, DATABASE_URL: URL_ }).kind === "ready",
        `row ${i + 1}`,
      ).toBe(starts);
    }
  });
});

describe("bot worker policy (J.6)", () => {
  it("the pool's session settings are the approved bounds; the shutdown grace covers the transaction bound plus a margin", () => {
    expect(SESSION_SETTINGS).toEqual({
      transaction_timeout: "25s",
      idle_in_transaction_session_timeout: "10s",
      statement_timeout: "15s",
    });
    expect(MIN_SERVER_VERSION_NUM).toBe(170_000);
    expect(SHUTDOWN_GRACE_MS).toBe(35_000);
    expect(poolSize(4)).toBe(7);
  });
});
