# ADR 0018: Pure bot execution engine and offline simulator (Phase 08B)

Status: Accepted for Phase 08B (implemented; independent review corrections applied, awaiting re-review, not approved). Builds on [ADR 0017](0017-bot-flow-contract.md) (the flow contract and validator, independently approved), [ADR 0007](0007-deterministic-bot.md) and [ADR 0014](0014-whatsapp-outbound-messaging.md). It implements the 08B checkpoint of the Phase 08-0 V3.2 proposal (section P), following its session state machine (section G) and terminal-notice design (section I.5).

## Context

A validated flow (ADR 0017) must be executable before sessions are stored (08C), sends are dispatched (08D) or inbound messages drive a runtime (08E). The engine must be testable offline, deterministic and free of side effects, so that every later checkpoint wraps it in transactions instead of re-implementing it, and the Bot Studio (Phase 09) can preview flows with the same code.

## Decisions

### 1. Scope: pure functions in `src/modules/bots`

`step(flow, session, event, context)` advances one session by one event and returns a `StepResult`; `simulate(flow, scenario)` runs a scripted conversation with it. Neither touches a database, the network, Meta, the filesystem, the clock, randomness or the environment (boundary tests pin this). Time (`context.nowMs`) and the prompt token (`context.promptToken`) are injected; the engine never generates a token. Nothing outside the module imports it yet. No migration, table, worker, route or dispatcher change.

### 2. Session model

`BotSession` holds what the pure engine needs, as plain JSON (V3.2 G.5 subset): `state` (`WAITING_FOR_SEND`, `WAITING_FOR_INPUT`, `COMPLETED`, `HANDED_OVER`, `FAILED`), `currentNodeId`, `variables`, `awaiting` (`nodeId`, `kind`, `phase` `QUEUED` / `SENT`, `optionKeys`), `awaitingToken`, `lastConsumedToken`, `stepSeq`, `transitionCount`, `sendCount`, `invalidAttempts`, `expiresAt`, `endReason`, `handoverReason`, `terminalNoticeStepSeq`. Organization, conversation, deployment, request and control-sequence fields are the runtime's (08C/08E). A live session handed back is checked against the flow (exact keys, known node, typed and bounded variables, consistent `awaiting` and tokens); an inconsistent one is never repaired: its variables are discarded and it goes to the error node (`SESSION_INVALID`). A terminal session ignores every event.

### 3. One send per step, and the send/wait boundary

At most one request per session is ever in flight (V3.2 G.1), so a step returns **at most one** `SEND` effect (`stepSeq`, `nodeId`, `terminalNotice`, `message`). The message is declarative: `text`, `buttons` (body, optional footer, `{id, title}`) or `list` (body, button label, optional footer, rows with optional description). The runtime decides whether it becomes an outbound request.

- **MESSAGE** queues its rendered text and waits (`WAITING_FOR_SEND`, `awaiting.kind = MESSAGE`). When the runtime reports the request `ACCEPTED`, the engine continues with `next` in a new step.
- **BUTTONS / LIST / QUESTION** need a fresh injected token (not the pending one, not the last consumed one; otherwise `PROMPT_TOKEN_INVALID`). Reply ids are `b1.<token>.<optionKey>`. On `ACCEPTED` the session waits for input (`awaiting.phase = SENT`) and `expiresAt = nowMs + idleTimeoutMinutes`. A QUESTION is sent as plain text; its token is never shown but keeps single-use semantics uniform.
- **CONDITION** and **SET_VARIABLE** run automatically within the step.
- **END / HANDOVER** reached by the flow end the session (`flow_end` / `flow_handover`, the HANDOVER's configured reason). A configured final message becomes the one send effect marked `terminalNotice: true`, and `terminalNoticeStepSeq` equals that step (V3.2 I.5). A start node may be END or HANDOVER: the session ends in the first step. This holds for the error node too when an ordinary edge leads to it. A final message that fails to render follows `errorNodeId` (section 7); one that no send budget is left for is skipped and the flow transition stands (`noticeSkipped = SEND_BUDGET`).

### 4. Request states are facts supplied by the runtime

The engine reads `QUEUED`, `SENDING`, `ACCEPTED`, `HELD`, `REJECTED`, `UNKNOWN_OUTCOME`; it never writes one and never infers acceptance from a student reply.

- `send_result` for the latest request (matched by `stepSeq`): `ACCEPTED` as above; `QUEUED` / `SENDING` change nothing; `HELD`, `REJECTED`, `UNKNOWN_OUTCOME` hand over with `send_held`, `send_rejected`, `send_outcome_unknown` (system reasons, no notice).
- A student input while `WAITING_FOR_SEND` must carry `latestRequestState` (V3.2 G.3 step 3). `QUEUED` / `SENDING`: `DEFERRED`, nothing changes, nothing is counted; `promptInteraction` reports a tap carrying the pending token. `ACCEPTED`: the acceptance is applied, then the input is evaluated. A failed state hands over. An input that arrives while the bot was sending a MESSAGE answers no MESSAGE, but it is **not dropped**: the acceptance is applied and, when the flow goes on to another send, the input stays `deferred` behind that request (the step is committed, `changed = true`; the runtime keeps the trigger and replays it once the new request is accepted). This is exactly what happens when reconciliation records the acceptance first and the input arrives afterwards, so the processing order never decides whether an input is consumed. Only when the continuation ended the session is the input `not_awaited` (the same as `session_ended` in the other order). A deferred input is never evaluated, counted or charged while a request is in flight.

### 5. Reply evaluation (`evaluateReply`, V3.2 G.3 step 4)

For BUTTONS / LIST only an interactive reply of the matching subtype can answer: malformed id → `malformed_reply`; token equal to `lastConsumedToken` → **duplicate** (ignored, uncounted, nothing changes); any other token than the pending one → `stale_prompt`; wrong subtype or a reply to a QUESTION → `wrong_kind`; a present, mismatched context → `context_mismatch` (a missing context changes nothing); an option key not offered → `unknown_option`. Text, media and other inputs are `wrong_kind`. Acceptance consumes the token (single use). For QUESTION only text answers:

- `text`: trimmed, NFC-normalized, sendable, no bidirectional overrides, `min ?? 1` to `max` UTF-16 code units;
- `integer`: ASCII `-?[0-9]{1,16}`, a safe integer within `min` / `max` (`-0` stored as `0`);
- `yes_no`: `yes` / `y` → true, `no` / `n` → false, case-insensitive.

Each invalid input increments `invalidAttempts`; below `maxInvalidAttempts` the prompt is re-sent with a new token (the old token then reads as stale); at the limit the flow follows `onInvalid`. A valid input resets the count. An input at or after `expiresAt` is not evaluated (`expired`): the session completes with `idle_timeout`. The runtime's idle sweep (`idle_expired`) does the same, or hands over with `delivery_failed` when the prompt's delivery failed.

### 6. Variables and conditions

Variables hold exactly their declared type: string, safe integer or boolean; nothing is coerced (`"5"` is not an integer). **Missing variables are strict (owner decision):** a placeholder for an unset variable is a render failure, never empty text, `undefined` or `[object Object]`; in conditions only `is_set` sees an unset variable, and `equals`, `not_equals`, `in`, `lt`, `gt` are all false for it. Values of different types never compare equal. String equality is exact after NFC normalization (case-sensitive). Integers render in decimal, booleans as `true` / `false`. Substitution is single-pass: a value containing `{{x}}` is not re-expanded. `all` / `any` evaluate their children; no expression is ever evaluated.

### 7. Mandatory validation of fully rendered text

Every rendered text (MESSAGE text, prompt body and footer, QUESTION text, final message) is checked **after** interpolation with the 08A rules, reusing their code (`textProblem`, `scanUrls`, `severityOf`): sendable Unicode, no bidirectional overrides, not blank, within its limit (1,024 for texts and bodies, 60 for footers) and the same URL policy (any URL finding the validator treats as an error refuses the text; https links pass). Nothing is truncated or repaired. **A failed render routes to `errorNodeId` (owner decision)**, wherever it happens, including the final message of an ordinary END or HANDOVER: no send effect is produced for the refused text, `error = RENDER_REJECTED`, and `renderFailures` names the node, field and reason (`VARIABLE_MISSING`, `TEXT_INVALID`, `TEXT_TOO_LONG`, `URL_POLICY`). The error termination renders nothing (section 9), so it cannot fail again or recurse: a failing final message on the error node itself, reached by an ordinary edge, ends the session at that node once, as an error. Option titles, list labels and descriptions take no placeholders (ADR 0017) and are sent as validated.

### 8. Execution budgets

From V3.2 section E (`ENGINE_BUDGETS`): at most 20 nodes entered per step, 200 per session, 60 sends per session (prompts, re-prompts, messages and the terminal notice), one send per step, and 4,096 UTF-16 code units of variable values in total. Exceeding one routes to the error node (`STEP_TRANSITION_BUDGET`, `SESSION_TRANSITION_BUDGET`, `SEND_BUDGET`, `VARIABLE_STORAGE_BUDGET`); entering the error node is not charged, and a notice that no send budget is left for is skipped (`noticeSkipped = SEND_BUDGET`). A student-driven menu loop ends each step at an input-waiting node, so it never meets the per-step budget; it is limited only by the session budgets. Automatic loops are refused by the validator and, should one reach the engine, stopped by the per-step budget. The hourly per-conversation cap needs shared state and stays with the runtime (08D/08E).

### 9. Errors and safety

`step` never throws and never mutates its arguments. An invalid clock or a missing `latestRequestState` is refused without change (`CONTEXT_INVALID`); a flow whose error node is not terminal is refused (`FLOW_INVALID`). Engine errors that leave a usable flow go to the error node (V3.2 G.4: `RENDER_REJECTED`, `PROMPT_TOKEN_INVALID`, `SESSION_INVALID`, `NODE_MISSING`, `VARIABLE_INVALID` and the budgets). **An error termination keeps its provenance and never carries a terminal notice** (V3.2 G.4 terminal-row rule: only `flow_end` and `flow_handover` may): the session ends at the error node (`COMPLETED` for an END, `HANDED_OVER` for a HANDOVER) with `endReason = error`, `handoverReason = engine_error` for a HANDOVER, `terminalNoticeStepSeq` null and no send effect; the error node's configured message is not produced (`noticeSkipped = ENGINE_ERROR`). That message is sent only when the flow reaches the node through an ordinary edge. An unexpected exception fails closed: no effect, the session ends `FAILED` (`ENGINE_INTERNAL`). Diagnostics name codes, nodes and fields, never student values.

### 10. Simulator

`simulate(flow, scenario)` validates the flow (an invalid flow returns its diagnostics and runs nothing), starts a session and applies scripted steps: `text`, `tap` (built from the pending token), raw `reply`, `other`, `accept`, `send_result`, `wait`, `idle_expired`. Sends are accepted automatically unless `autoAccept: false`. Tokens are `simulatorToken(n)` (`sim` + zero-padded number) or the scenario's own; time starts at `startMs` and moves only with `wait`. The result has every send effect in order and a transcript entry per engine call (event, time, outcome, input result, error, render failures, effects, nodes entered, and a snapshot of state, node, variables and pending prompt) for the Bot Studio preview. At most 1,000 engine calls. The simulator does not retain or replay deferred inputs: a scenario that wants a deferred input answered repeats it after the acceptance (with `autoAccept: false`). It is no evidence of the runtime's durable trigger buffering (08E).

## Interpretations recorded for review

1. `yes_no` accepts the ASCII words above only; localized words would need a contract field (decision B keeps wording out of code).
2. An input that arrives while a MESSAGE is being sent stays deferred until a prompt can evaluate it (corrected after independent review; the earlier `not_awaited` reading made the outcome depend on processing order).
3. A rendered https link supplied by a variable passes (the policy refuses schemes, not hosts); it reaches only the conversation it came from.
4. `stepSeq` advances when nodes run, a prompt is re-sent or the session ends; recording the acceptance of a prompt alone does not advance it.
5. An error-driven termination (any `EngineErrorCode` routed to `errorNodeId`, including `SESSION_INVALID`) renders no final message and produces no terminal notice: the error node's configured message is skipped (`noticeSkipped = ENGINE_ERROR`), `terminalNoticeStepSeq` stays null, and the session keeps its error provenance (`endReason = error`; `handoverReason = engine_error`, a system reason, when the error node is a HANDOVER). A session found inconsistent is never repaired and its values are never used: its variables are discarded as it ends.

## Open production blocker: acceptance-recording versus Stop suppression (P2)

The acceptance-recording versus Stop suppression concurrency finding (the dispatcher's `ACCEPTED` record against the Stop's suppression of `QUEUED` BOT requests) is **OPEN**. It is an owner-accepted exception for development only. It MUST be resolved, and proven with disposable PostgreSQL concurrency tests, before production sign-off and before any live WhatsApp automation. Phase 08B does not touch the dispatcher, request states or any transaction and does not resolve it; its green tests say nothing about it.

## Consequences

- 08C stores `BotSession` and the effects' `stepSeq`; 08D turns a `SEND` effect into a BOT request; 08E supplies request states, inputs, tokens and time inside its transactions and commits a result only when `changed` is true. It keeps (defers) the trigger whenever `input.result` is `deferred`, also when the same result is committed (`changed` true after a MESSAGE acceptance).
- The Bot Studio can preview any flow offline with the production engine.
- Tests cover every node type, reply case, condition rule, render rule and budget, with deterministic and mutation checks.
