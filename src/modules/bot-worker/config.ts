import { evaluateBotWorkerStart, type RuntimeEnv } from "@/modules/bot-runtime";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "./policy";

// Bot worker configuration (Phase 08E-7; plan M, P-B), read from an EXPLICIT environment object (the script passes
// process.env; nothing here reads it). FAIL CLOSED, in this order:
//   1. the approved gate decision of the runtime: BOTS_RUNTIME_ENABLED and WHATSAPP_OUTBOUND_ENABLED both exactly "true";
//      anything else ("TRUE", "1", "yes", "", unset) refuses, before any other check, connection or side effect;
//   2. DATABASE_URL (a postgres URL) and an optional lane count.
// Problems name the KEY only, never a value (a database URL contains a password). No token is read: the worker never sends.
// WHATSAPP_LIVE_SEND_ENABLED is neither required nor consulted: it belongs to the outbound worker alone.

export type BotWorkerConfig = { readonly databaseUrl: string; readonly concurrency: number };

export type BotWorkerConfigResult =
  | { readonly kind: "refused"; readonly problems: readonly string[] }
  | { readonly kind: "invalid"; readonly problems: readonly string[] }
  | { readonly kind: "ready"; readonly config: BotWorkerConfig };

function isPostgresUrl(raw: string | undefined): raw is string {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname !== "" &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

export function readBotWorkerConfig(env: RuntimeEnv): BotWorkerConfigResult {
  const gates = evaluateBotWorkerStart(env);
  if (gates.kind === "refused") return { kind: "refused", problems: gates.problems };

  const problems: string[] = [];
  if (!isPostgresUrl(env.DATABASE_URL))
    problems.push("DATABASE_URL (missing or not a postgres connection URL)");
  let concurrency = DEFAULT_CONCURRENCY;
  const raw = env.BOTS_WORKER_CONCURRENCY;
  if (raw !== undefined && raw !== "") {
    const n = /^[0-9]{1,2}$/.test(raw) ? Number(raw) : NaN;
    if (n >= 1 && n <= MAX_CONCURRENCY) concurrency = n;
    else problems.push(`BOTS_WORKER_CONCURRENCY (integer 1 to ${MAX_CONCURRENCY})`);
  }
  if (problems.length > 0) return { kind: "invalid", problems };
  return { kind: "ready", config: { databaseUrl: env.DATABASE_URL as string, concurrency } };
}
