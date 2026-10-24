import { randomBytes } from "node:crypto";
import type { RuntimeEnv } from "@/modules/bot-runtime";
import { FlowCache } from "@/modules/bot-runtime/flow-cache";
import type { StepDeps } from "@/modules/bot-runtime/outbound";
import { readOutboundConfig } from "@/modules/messaging/config";

// The PRODUCTION composition of the runtime's dependencies (Phase 08E-7; review condition "no test hook in production").
// Exactly four keys: the gates as the enqueue path reads them, the flow cache, a real prompt-token source and real randomness.
// It never sets `hooks`, `readClock` or any other test seam: the decision clock is the database's clock_timestamp(), and a
// static test pins this object's keys and the absence of every test capability in the worker.

/** A fresh prompt token: 16 random bytes, base64url (22 characters), as the engine contract requires. */
export function newPromptToken(): string {
  return randomBytes(16).toString("base64url");
}

export function productionStepDeps(env: RuntimeEnv): StepDeps {
  return {
    config: readOutboundConfig(env),
    flows: new FlowCache(),
    newPromptToken,
    random: Math.random,
  };
}
