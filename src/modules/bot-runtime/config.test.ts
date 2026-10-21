import { describe, expect, it } from "vitest";
import { readOutboundConfig } from "@/modules/messaging/config";
import {
  evaluateBotWorkerStart,
  gateBehaviour,
  outboundWorkerCanStart,
  outboundWorkerClaimsBotRows,
  readRuntimeGates,
  triggerCaptureEnabled,
  type RuntimeEnv,
} from "./config";

const ON = "true";

describe("every gate is exactly the string true", () => {
  it("an empty environment is everything OFF", () => {
    expect(readRuntimeGates({})).toEqual({
      botsRuntimeEnabled: false,
      outboundEnabled: false,
      liveSendEnabled: false,
    });
    expect(triggerCaptureEnabled({})).toBe(false);
    expect(evaluateBotWorkerStart({}).kind).toBe("refused");
    expect(outboundWorkerCanStart({})).toBe(false);
    expect(outboundWorkerClaimsBotRows({})).toBe(false);
  });

  it.each(["TRUE", "True", "1", "yes", "on", " true", "true ", "false", "", "tru"])(
    "%j is off",
    (value) => {
      expect(readRuntimeGates({ BOTS_RUNTIME_ENABLED: value }).botsRuntimeEnabled).toBe(false);
      expect(triggerCaptureEnabled({ BOTS_RUNTIME_ENABLED: value })).toBe(false);
      expect(readRuntimeGates({ WHATSAPP_OUTBOUND_ENABLED: value }).outboundEnabled).toBe(false);
      expect(readRuntimeGates({ WHATSAPP_LIVE_SEND_ENABLED: value }).liveSendEnabled).toBe(false);
    },
  );

  it("only the exact string true turns a gate on", () => {
    expect(readRuntimeGates({ BOTS_RUNTIME_ENABLED: ON }).botsRuntimeEnabled).toBe(true);
    expect(triggerCaptureEnabled({ BOTS_RUNTIME_ENABLED: ON })).toBe(true);
  });

  it("agrees with the messaging module's own reading of the shared gates", () => {
    for (const value of [undefined, "true", "TRUE", "1", ""]) {
      const env: RuntimeEnv = {
        BOTS_RUNTIME_ENABLED: value,
        WHATSAPP_OUTBOUND_ENABLED: value,
        WHATSAPP_LIVE_SEND_ENABLED: value,
      };
      const messaging = readOutboundConfig(env);
      const ours = readRuntimeGates(env);
      expect(ours.botsRuntimeEnabled).toBe(messaging.botsRuntimeEnabled);
      expect(ours.outboundEnabled).toBe(messaging.outboundEnabled);
      expect(ours.liveSendEnabled).toBe(messaging.liveSendEnabled);
    }
  });

  it("reads only the three gate names: no token, secret or other variable is ever consulted", () => {
    const read: string[] = [];
    const env = new Proxy({} as Record<string, string | undefined>, {
      get: (_t, key) => {
        read.push(String(key));
        return undefined;
      },
    });
    readRuntimeGates(env);
    triggerCaptureEnabled(env);
    evaluateBotWorkerStart(env);
    outboundWorkerCanStart(env);
    outboundWorkerClaimsBotRows(env);
    gateBehaviour({ webhookWorker: env, botWorker: env, outboundWorker: env });
    expect(new Set(read)).toEqual(
      new Set(["BOTS_RUNTIME_ENABLED", "WHATSAPP_OUTBOUND_ENABLED", "WHATSAPP_LIVE_SEND_ENABLED"]),
    );
  });
});

describe("the bot worker's start decision", () => {
  it("needs BOTS_RUNTIME_ENABLED and WHATSAPP_OUTBOUND_ENABLED, and names exactly what is missing", () => {
    expect(
      evaluateBotWorkerStart({ BOTS_RUNTIME_ENABLED: ON, WHATSAPP_OUTBOUND_ENABLED: ON }),
    ).toEqual({
      kind: "ready",
    });
    expect(evaluateBotWorkerStart({ BOTS_RUNTIME_ENABLED: ON })).toEqual({
      kind: "refused",
      problems: ["WHATSAPP_OUTBOUND_ENABLED (must be exactly true)"],
    });
    expect(evaluateBotWorkerStart({ WHATSAPP_OUTBOUND_ENABLED: ON })).toEqual({
      kind: "refused",
      problems: ["BOTS_RUNTIME_ENABLED (must be exactly true)"],
    });
    expect(evaluateBotWorkerStart({})).toEqual({
      kind: "refused",
      problems: [
        "BOTS_RUNTIME_ENABLED (must be exactly true)",
        "WHATSAPP_OUTBOUND_ENABLED (must be exactly true)",
      ],
    });
  });

  it("neither needs nor is affected by the live-send gate: the bot worker never sends", () => {
    const base = { BOTS_RUNTIME_ENABLED: ON, WHATSAPP_OUTBOUND_ENABLED: ON };
    expect(evaluateBotWorkerStart({ ...base, WHATSAPP_LIVE_SEND_ENABLED: ON }).kind).toBe("ready");
    expect(evaluateBotWorkerStart({ ...base, WHATSAPP_LIVE_SEND_ENABLED: "false" }).kind).toBe(
      "ready",
    );
  });
});

describe("the three-process gate matrix of plan section M", () => {
  const off: RuntimeEnv = {};
  const bots: RuntimeEnv = { BOTS_RUNTIME_ENABLED: ON };
  const botWorker: RuntimeEnv = { BOTS_RUNTIME_ENABLED: ON, WHATSAPP_OUTBOUND_ENABLED: ON };
  const outboundAll: RuntimeEnv = {
    WHATSAPP_OUTBOUND_ENABLED: ON,
    WHATSAPP_LIVE_SEND_ENABLED: ON,
    BOTS_RUNTIME_ENABLED: ON,
  };
  const outboundNoBots: RuntimeEnv = {
    WHATSAPP_OUTBOUND_ENABLED: ON,
    WHATSAPP_LIVE_SEND_ENABLED: ON,
  };

  const row = (webhookWorker: RuntimeEnv, bot: RuntimeEnv, outboundWorker: RuntimeEnv) =>
    gateBehaviour({ webhookWorker, botWorker: bot, outboundWorker });

  it("1: everything off (the default): nothing happens and nothing can reach Meta", () => {
    expect(row(off, off, off)).toEqual({
      capturesTriggers: false,
      botWorkerStarts: false,
      outboundWorkerStarts: false,
      claimsBotRows: false,
      newBotMessagesCanReachMeta: false,
    });
  });

  it("2: capture alone writes triggers but nothing processes them", () => {
    expect(row(bots, off, off)).toMatchObject({
      capturesTriggers: true,
      botWorkerStarts: false,
      newBotMessagesCanReachMeta: false,
    });
  });

  it("3: the bot worker alone finds nothing to claim", () => {
    expect(row(off, botWorker, off)).toMatchObject({
      capturesTriggers: false,
      botWorkerStarts: true,
      newBotMessagesCanReachMeta: false,
    });
  });

  it("4: capture and the bot worker without a dispatcher: sessions start, nothing is sent", () => {
    expect(row(bots, botWorker, off)).toMatchObject({
      capturesTriggers: true,
      botWorkerStarts: true,
      outboundWorkerStarts: false,
      newBotMessagesCanReachMeta: false,
    });
  });

  it("5: a dispatcher without BOTS_RUNTIME_ENABLED claims staff rows only", () => {
    expect(row(bots, botWorker, outboundNoBots)).toMatchObject({
      outboundWorkerStarts: true,
      claimsBotRows: false,
      newBotMessagesCanReachMeta: false,
    });
  });

  it("6: a dispatcher alone may start but no new bot message exists to claim", () => {
    expect(row(off, off, outboundAll)).toMatchObject({
      outboundWorkerStarts: true,
      claimsBotRows: true,
      newBotMessagesCanReachMeta: false,
    });
  });

  it("7: the bot worker refuses to start without the outbound gate", () => {
    expect(row(bots, bots, outboundAll).botWorkerStarts).toBe(false);
    expect(row(bots, bots, outboundAll).newBotMessagesCanReachMeta).toBe(false);
  });

  it("8: only all three processes on is the activation scenario (NOT authorized by this plan)", () => {
    expect(row(bots, botWorker, outboundAll)).toEqual({
      capturesTriggers: true,
      botWorkerStarts: true,
      outboundWorkerStarts: true,
      claimsBotRows: true,
      newBotMessagesCanReachMeta: true,
    });
  });

  it("a dispatcher missing its live-send gate cannot start, so a bot message cannot reach Meta", () => {
    const noLive: RuntimeEnv = { WHATSAPP_OUTBOUND_ENABLED: ON, BOTS_RUNTIME_ENABLED: ON };
    expect(row(bots, botWorker, noLive)).toMatchObject({
      outboundWorkerStarts: false,
      claimsBotRows: false,
      newBotMessagesCanReachMeta: false,
    });
  });

  it("every single-process or two-process combination short of all three keeps new bot messages from Meta", () => {
    const envs = [off, bots, botWorker, outboundNoBots, outboundAll];
    for (const w of envs)
      for (const b of envs)
        for (const o of envs) {
          const r = row(w, b, o);
          const allThree =
            r.capturesTriggers && r.botWorkerStarts && r.outboundWorkerStarts && r.claimsBotRows;
          expect(r.newBotMessagesCanReachMeta).toBe(allThree);
        }
  });
});
