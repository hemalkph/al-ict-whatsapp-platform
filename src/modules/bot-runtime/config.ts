// Runtime gates, read from an EXPLICIT environment object (never process.env here), in the pattern of messaging/config.ts:
// every gate is "exactly the string true"; anything else (unset, "TRUE", "1", "yes") is off. NOTHING defaults on, and this
// file reads no token or secret. (Phase 08E-1; plan section M.)
//
// Three processes read the same variable names independently: the webhook worker (trigger capture), the bot worker and the
// outbound worker. Each decision below takes ONE process's environment, so a mixed configuration can be modelled and tested.

export type RuntimeEnv = Readonly<Record<string, string | undefined>>;

const flag = (env: RuntimeEnv, name: string): boolean => env[name] === "true";

export type RuntimeGates = {
  readonly botsRuntimeEnabled: boolean;
  readonly outboundEnabled: boolean;
  readonly liveSendEnabled: boolean;
};

export function readRuntimeGates(env: RuntimeEnv): RuntimeGates {
  return {
    botsRuntimeEnabled: flag(env, "BOTS_RUNTIME_ENABLED"),
    outboundEnabled: flag(env, "WHATSAPP_OUTBOUND_ENABLED"),
    liveSendEnabled: flag(env, "WHATSAPP_LIVE_SEND_ENABLED"),
  };
}

/** P-W: the webhook worker builds the (dormant) trigger-capture dependency only when its own BOTS_RUNTIME_ENABLED is on. */
export function triggerCaptureEnabled(env: RuntimeEnv): boolean {
  return readRuntimeGates(env).botsRuntimeEnabled;
}

export type WorkerStartDecision =
  { readonly kind: "ready" } | { readonly kind: "refused"; readonly problems: readonly string[] };

/**
 * P-B: the bot worker starts only with BOTS_RUNTIME_ENABLED and WHATSAPP_OUTBOUND_ENABLED both exactly "true" (enqueue refuses
 * without either). It does NOT need, read or depend on the live-send gate: the bot worker never sends.
 */
export function evaluateBotWorkerStart(env: RuntimeEnv): WorkerStartDecision {
  const g = readRuntimeGates(env);
  const problems: string[] = [];
  if (!g.botsRuntimeEnabled) problems.push("BOTS_RUNTIME_ENABLED (must be exactly true)");
  if (!g.outboundEnabled) problems.push("WHATSAPP_OUTBOUND_ENABLED (must be exactly true)");
  return problems.length === 0 ? { kind: "ready" } : { kind: "refused", problems };
}

/** P-D (unchanged from Phase 05/08D): the outbound worker starts only with the outbound and live-send gates both on. */
export function outboundWorkerCanStart(env: RuntimeEnv): boolean {
  const g = readRuntimeGates(env);
  return g.outboundEnabled && g.liveSendEnabled;
}

/** P-D: whether the outbound worker will claim origin-BOT rows at all (08D: only with BOTS_RUNTIME_ENABLED). */
export function outboundWorkerClaimsBotRows(env: RuntimeEnv): boolean {
  return outboundWorkerCanStart(env) && readRuntimeGates(env).botsRuntimeEnabled;
}

export type ProcessEnvs = {
  readonly webhookWorker: RuntimeEnv;
  readonly botWorker: RuntimeEnv;
  readonly outboundWorker: RuntimeEnv;
};

export type GateBehaviour = {
  /** The webhook worker writes bot triggers into the inbound transaction. */
  readonly capturesTriggers: boolean;
  /** The bot worker would start (and so could create sessions and BOT requests). */
  readonly botWorkerStarts: boolean;
  /** The outbound worker would start. */
  readonly outboundWorkerStarts: boolean;
  /** The outbound worker would claim BOT rows. */
  readonly claimsBotRows: boolean;
  /**
   * A NEW bot message could reach Meta end to end: captured, processed, queued AND claimed by a started outbound worker.
   * (Plan section M, row 8, the activation scenario. Leftover rows from an earlier run are not modelled here.)
   */
  readonly newBotMessagesCanReachMeta: boolean;
};

/** Models the three-process gate matrix of plan section M for explicit per-process environments. */
export function gateBehaviour(envs: ProcessEnvs): GateBehaviour {
  const capturesTriggers = triggerCaptureEnabled(envs.webhookWorker);
  const botWorkerStarts = evaluateBotWorkerStart(envs.botWorker).kind === "ready";
  const outboundWorkerStarts = outboundWorkerCanStart(envs.outboundWorker);
  const claimsBotRows = outboundWorkerClaimsBotRows(envs.outboundWorker);
  return {
    capturesTriggers,
    botWorkerStarts,
    outboundWorkerStarts,
    claimsBotRows,
    newBotMessagesCanReachMeta: capturesTriggers && botWorkerStarts && claimsBotRows,
  };
}
