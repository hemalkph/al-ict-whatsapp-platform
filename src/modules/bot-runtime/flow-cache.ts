import { readVersion } from "@/db/ops/bot-step";
import type { DbExecutor } from "@/db/ops/executor";
import { validateFlow, type FlowConfig } from "@/modules/bots";

// Loads a session's (or a deployment's) PINNED bot version and validates it (Phase 08E-4; plan sections E.1, J.5, R-3).
// A published version is immutable (database guard), so a validated flow is cached by (version id, config SHA-256): the
// ~1k-line validator runs once per version, not once per step. A version that is missing or fails validation is reported, never
// repaired: the caller hands the session over (bot_error) and finishes the trigger, because a retry cannot fix an immutable row.

export type FlowLoad =
  | { readonly ok: true; readonly flow: FlowConfig }
  | { readonly ok: false; readonly reason: "missing" | "invalid" };

const MAX_ENTRIES = 256;

export class FlowCache {
  private readonly entries = new Map<string, FlowConfig | "invalid">();

  get size(): number {
    return this.entries.size;
  }

  async load(tx: DbExecutor, org: string, botId: string, versionId: string): Promise<FlowLoad> {
    const row = await readVersion(tx, org, botId, versionId);
    if (!row) return { ok: false, reason: "missing" };
    const key = `${versionId}:${row.sha256}`;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      const validated = validateFlow(row.config);
      entry = validated.ok && validated.config ? validated.config : "invalid";
      if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
      this.entries.set(key, entry);
    }
    return entry === "invalid" ? { ok: false, reason: "invalid" } : { ok: true, flow: entry };
  }
}
