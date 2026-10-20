import {
  step,
  type EngineEvent,
  type InputOutcome,
  type RequestState,
  type SendEffect,
  type StepOutcome,
  type StepResult,
  type TraceEntry,
} from "./engine";
import { formatReplyId, isPromptToken } from "./reply-id";
import type { Awaiting, BotSession, SessionState } from "./session";
import type { Diagnostic, FlowConfig, Literal } from "./types";
import { validateFlow } from "./validate";

// The offline simulator (Phase 08B): runs a flow against a scripted conversation with the real engine, and returns a
// structured transcript for tests and the future Bot Studio preview (Phase 09). Pure and deterministic: no database, no
// WhatsApp call, no clock, no randomness. Outbound acceptance is simulated; prompt tokens are a fixed, recognisable sequence
// (or the scenario's own); time starts at `startMs` and moves only with `wait` steps.

export type ScenarioStep =
  /** The student types a message. */
  | { readonly type: "text"; readonly text: string }
  /** The student taps an option of the pending BUTTONS / LIST prompt (the reply id is built from its token). */
  | { readonly type: "tap"; readonly optionKey: string }
  /** A raw interactive reply, for stale, duplicate, malformed or mismatched replies. */
  | {
      readonly type: "reply";
      readonly replyId: string;
      readonly subtype: "button_reply" | "list_reply";
      readonly contextMismatch?: boolean;
    }
  /** A message that is not text or a reply (an image, a sticker, ...). */
  | { readonly type: "other" }
  /** The latest request is accepted (only needed when `autoAccept` is false). */
  | { readonly type: "accept" }
  /** The latest request reaches another state (QUEUED / SENDING are reported but change nothing). */
  | { readonly type: "send_result"; readonly state: RequestState }
  | { readonly type: "wait"; readonly ms: number }
  | { readonly type: "idle_expired"; readonly deliveryFailed?: boolean };

export type Scenario = {
  readonly steps: readonly ScenarioStep[];
  /** Accept every outbound request as soon as it is produced (default true). */
  readonly autoAccept?: boolean;
  /** Simulated start time, epoch milliseconds (default 0). */
  readonly startMs?: number;
  /** Prompt tokens to hand out in order (default: `simulatorToken(1)`, `simulatorToken(2)`, ...). */
  readonly tokens?: readonly string[];
};

export type TranscriptEntry = {
  readonly index: number;
  /** `scenario`: a scripted step; `auto`: the start or an automatic acceptance. */
  readonly source: "scenario" | "auto";
  readonly event: EngineEvent | ScenarioStep;
  readonly nowMs: number;
  readonly outcome: StepOutcome | "WAITED" | "SCENARIO_ERROR";
  readonly reason?: string;
  readonly input?: InputOutcome;
  readonly error?: string;
  readonly noticeSkipped?: string;
  readonly renderFailures: StepResult["renderFailures"];
  readonly effects: readonly SendEffect[];
  readonly trace: readonly TraceEntry[];
  /** Session snapshot after the entry. */
  readonly state: SessionState | null;
  readonly nodeId: string | null;
  readonly variables: Readonly<Record<string, Literal>>;
  readonly awaiting: Awaiting | null;
};

export type SimulationResult =
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly ok: true;
      readonly transcript: readonly TranscriptEntry[];
      /** Every send effect, in order. */
      readonly outbound: readonly SendEffect[];
      readonly session: BotSession | null;
      /** True when the engine-call cap stopped the simulation. */
      readonly truncated: boolean;
    };

/** At most this many engine calls per simulation (the session budgets end any real flow far earlier). */
export const SIMULATOR_MAX_CALLS = 1000;

/** A deterministic, obviously synthetic prompt token: `sim` + the number, zero-padded to 22 characters. */
export function simulatorToken(n: number): string {
  return `sim${String(n).padStart(19, "0")}`;
}

/** Validates `flow` and runs `scenario` against it. An invalid flow returns its diagnostics and runs nothing. */
export function simulate(flow: unknown, scenario: Scenario): SimulationResult {
  const validation = validateFlow(flow);
  if (!validation.ok || !validation.config)
    return { ok: false, diagnostics: validation.diagnostics };
  return new Simulation(validation.config, scenario).run();
}

class Simulation {
  private session: BotSession | null = null;
  private nowMs: number;
  private latest: RequestState | null = null;
  private tokenIndex = 0;
  private calls = 0;
  private readonly transcript: TranscriptEntry[] = [];
  private readonly outbound: SendEffect[] = [];
  private readonly autoAccept: boolean;

  constructor(
    private readonly flow: FlowConfig,
    private readonly scenario: Scenario,
  ) {
    this.nowMs = scenario.startMs ?? 0;
    this.autoAccept = scenario.autoAccept ?? true;
  }

  run(): SimulationResult {
    this.call({ type: "start" }, "auto");
    for (const scripted of this.scenario.steps) {
      if (this.calls >= SIMULATOR_MAX_CALLS) break;
      this.apply(scripted);
    }
    return {
      ok: true,
      transcript: this.transcript,
      outbound: this.outbound,
      session: this.session,
      truncated: this.calls >= SIMULATOR_MAX_CALLS,
    };
  }

  private token(): string {
    const supplied = this.scenario.tokens;
    return supplied ? (supplied[this.tokenIndex] ?? "") : simulatorToken(this.tokenIndex + 1);
  }

  private apply(scripted: ScenarioStep): void {
    switch (scripted.type) {
      case "wait":
        this.nowMs += Math.max(0, Math.trunc(scripted.ms));
        return this.record(scripted, "scenario", "WAITED");
      case "accept":
        return this.call(
          { type: "send_result", stepSeq: this.session?.stepSeq ?? 0, state: "ACCEPTED" },
          "scenario",
        );
      case "send_result":
        return this.call(
          { type: "send_result", stepSeq: this.session?.stepSeq ?? 0, state: scripted.state },
          "scenario",
        );
      case "idle_expired":
        return this.call(
          { type: "idle_expired", ...(scripted.deliveryFailed ? { deliveryFailed: true } : {}) },
          "scenario",
        );
      case "text":
        return this.input({ kind: "text", text: scripted.text });
      case "other":
        return this.input({ kind: "other" });
      case "reply":
        return this.input({
          kind: "interactive",
          subtype: scripted.subtype,
          replyId: scripted.replyId,
          ...(scripted.contextMismatch ? { contextMismatch: true } : {}),
        });
      case "tap": {
        const s = this.session;
        const replyId = s?.awaitingToken
          ? formatReplyId(s.awaitingToken, scripted.optionKey)
          : null;
        if (!s || !replyId)
          return this.record(scripted, "scenario", "SCENARIO_ERROR", "no_pending_prompt");
        const subtype = s.awaiting?.kind === "LIST" ? "list_reply" : "button_reply";
        return this.input({ kind: "interactive", subtype, replyId });
      }
    }
  }

  private input(input: Extract<EngineEvent, { type: "student_input" }>["input"]): void {
    this.call(
      { type: "student_input", input, ...(this.latest ? { latestRequestState: this.latest } : {}) },
      "scenario",
    );
  }

  private call(event: EngineEvent, source: TranscriptEntry["source"]): void {
    if (this.calls >= SIMULATOR_MAX_CALLS) return;
    this.calls += 1;
    const token = this.token();
    const result = step(this.flow, this.session, event, {
      nowMs: this.nowMs,
      ...(isPromptToken(token) ? { promptToken: token } : {}),
    });
    if (result.changed) this.session = result.session;
    if (result.session?.awaitingToken === token && token !== "") this.tokenIndex += 1;
    if (event.type === "send_result" && result.changed) this.latest = event.state;
    for (const effect of result.effects) {
      this.outbound.push(effect);
      this.latest = "QUEUED";
    }
    this.record(event, source, result.outcome, result.reason, result);
    if (this.autoAccept && result.changed && this.session?.state === "WAITING_FOR_SEND")
      this.call({ type: "send_result", stepSeq: this.session.stepSeq, state: "ACCEPTED" }, "auto");
  }

  private record(
    event: TranscriptEntry["event"],
    source: TranscriptEntry["source"],
    outcome: TranscriptEntry["outcome"],
    reason?: string,
    result?: StepResult,
  ): void {
    const s = this.session;
    this.transcript.push({
      index: this.transcript.length,
      source,
      event,
      nowMs: this.nowMs,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(result?.input ? { input: result.input } : {}),
      ...(result?.error ? { error: result.error } : {}),
      ...(result?.noticeSkipped ? { noticeSkipped: result.noticeSkipped } : {}),
      renderFailures: result?.renderFailures ?? [],
      effects: result?.effects ?? [],
      trace: result?.trace ?? [],
      state: s?.state ?? null,
      nodeId: s?.currentNodeId ?? null,
      variables: s?.variables ?? {},
      awaiting: s?.awaiting ?? null,
    });
  }
}
