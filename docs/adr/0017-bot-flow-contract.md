# ADR 0017: Bot flow contract and validator (Phase 08A)

Status: Accepted for Phase 08A (implemented; awaiting independent code and test review, not approved). Builds on [ADR 0007](0007-deterministic-bot.md) (deterministic bot, no arbitrary code), [ADR 0011](0011-database-foundation-conventions.md) and [ADR 0014](0014-whatsapp-outbound-messaging.md). The architecture it implements is the Phase 08-0 V3.2 proposal, section E (the flow contract), with the checkpoint order of its section P.

## Context

Administrators will eventually design complete WhatsApp conversation flows in a visual Bot Studio (Phase 09). Until then flows are JSON documents. Nothing in the runtime may hard-code student-facing wording, class names, menu options or branches: all of it is configuration, and configuration must be checked before it can be published, because a published version is immutable (ADR 0007) and every later checkpoint (the engine, the simulator, sessions, the dispatcher) trusts what it reads.

Checkpoint 08A is therefore a **pure contract and validator**. It does not run a bot.

## Decisions

### 1. Scope: a pure, standalone module

`src/modules/bots` contains the flow contract, a validator, static graph analysis and the reply-identifier syntax. It performs no database operation, no network or Meta call, no filesystem access, no timing, no randomness and reads no environment. Given the same configuration it returns an equivalent, identically ordered result (a test freezes the input, reverses its key order, and stubs the clock and `Math.random` to throw). Nothing else in the application imports it yet (a test pins that). It has no migration, no table, no worker and no route; migrations `0000`–`0006` are untouched.

Not in 08A: the engine and simulator (08B), tables and publishing (08C), outbound and dispatch safety (08D), sessions, triggers at run time, prompt-token generation and reply evaluation (08E), the Inbox indicator and retention (08F), the visual editor (Phase 09). The terminal-notice effects of END / HANDOVER belong to 08B; 08A only validates the nodes.

### 2. The configuration document (schema version 1)

Plain JSON, validated with strict zod objects: **an unknown field is an error**, never dropped. Top level:

| Field           | Required          | Meaning                                                                                 |
| --------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `schemaVersion` | yes               | Must be `1`. Another number is `SCHEMA_VERSION_UNSUPPORTED` and nothing else is judged. |
| `name`          | yes               | 1–80 characters, no outer whitespace.                                                   |
| `startNodeId`   | yes               | The node a session begins at. START is not a node type.                                 |
| `errorNodeId`   | yes               | Where the engine routes failures; must be a HANDOVER or END node.                       |
| `triggers`      | yes               | How the bot may start (section 4). An empty list is valid and warns.                    |
| `settings`      | no                | `idleTimeoutMinutes` (default 30, 1–1440), `maxInvalidAttempts` (default 2, 1–5).       |
| `variables`     | no (default `{}`) | Declared variables (section 5).                                                         |
| `nodes`         | yes               | Map of node id to node; 1–200 nodes.                                                    |
| `layout`        | no (default `{}`) | `{ nodeId: { x, y } }` for the editor; ignored by the runtime.                          |

`validateFlow(input)` returns the **normalized** configuration (defaults applied, `sensitive` and string `maxLength` filled in) only when there is no error. The size limit applies to that normalized configuration, so every returned configuration validates again unchanged (`validateFlow(result.config)` is valid and canonically identical). `canonicalFlowJson(config)` is its RFC 8785 canonical text, using the project's one canonicalizer (`src/shared/canonical-json.ts`); hashing and storing it is the publishing service's job (08C).

Identifiers (node ids, option keys, variable names) match `^[a-z][a-z0-9_]{0,31}$`. Look nodes and variables up with `getNode` / `getVariable` (own properties only): ids such as `constructor` are legal.

### 3. Node types

The first runtime milestone has eight node types. ACTION, ADD_TAG, REMOVE_TAG, ASSIGN_TEAM, WHATSAPP_FLOW and SUBFLOW are deferred and rejected (`NODE_TYPE_UNSUPPORTED`).

| Node         | Fields                                                                                                     | Transitions                       | Kind          |
| ------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------- |
| MESSAGE      | `text`                                                                                                     | `next`                            | automatic     |
| BUTTONS      | `body`, optional `footer`, `options` (1–3: `key`, `title`, `next`)                                         | each option's `next`, `onInvalid` | input-waiting |
| LIST         | `body`, `buttonLabel`, optional `footer`, `options` (1–10: `key`, `title`, optional `description`, `next`) | each option's `next`, `onInvalid` | input-waiting |
| QUESTION     | `text`, `variable`, `answer`, `next`, `onInvalid`                                                          | `next`, `onInvalid`               | input-waiting |
| CONDITION    | `branches` (1–20: `when`, `next`), `else`                                                                  | each branch's `next`, `else`      | automatic     |
| SET_VARIABLE | `variable`, literal `value`, `next`                                                                        | `next`                            | automatic     |
| HANDOVER     | optional `message`, `reason`                                                                               | none                              | terminal      |
| END          | optional `message`                                                                                         | none                              | terminal      |

`answer` is `{kind: "text", min?, max}` (string variable; `max` required; an empty answer is never accepted, so the effective minimum is 1 whether or not `min` is written: `1 ≤ min ≤ max ≤` the variable's `maxLength`, and `max` below 1 is `NUMBER_TOO_SMALL`; an omitted `min` stays omitted in the normalized configuration and means 1; nothing is clamped), `{kind: "integer", min?, max?}` (integer variable; any safe integers, `ANSWER_RANGE_INVALID` only when both are written and `min > max`) or `{kind: "yes_no"}` (boolean variable, no other field). A HANDOVER or END node may be the start node. An END start node without a message is valid and warns (`START_NODE_END_WITHOUT_MESSAGE`). A terminal node that has `next`, `onInvalid`, `else`, `options` or `branches` is `TERMINAL_NODE_HAS_TRANSITION`. The final `message` of HANDOVER and END is the future _terminal notice_ (V3.2 I.5); 08A only validates its text.

HANDOVER `reason` must be one of `student_requested`, `needs_staff`, `out_of_scope`, `invalid_input`, `error_fallback`, `other`. The list is content-free and disjoint from the reasons the runtime itself writes (`staff_assigned`, `staff_replied`, `staff_status_changed`, `conversation_resolved`, `operator_stop`, `deployment_stopped`, `bot_error`, `delivery_failed`, `idle_timeout`, `flow_handover`, `send_*`); a test pins the disjointness.

### 4. Trigger kinds

Exactly three (owner decision A): `keyword` (`words`: 1–50 trimmed words of at most 40 characters, no duplicates ignoring case), `first_message`, `referral_source` (no other fields). Any other kind is `TRIGGER_KIND_UNSUPPORTED`; regular expressions and fuzzy matching are deliberately absent. `first_message` and `referral_source` may each appear once. At most 10 triggers. _How_ a keyword matches an incoming message is a run-time rule (08B/08E), not part of the contract.

### 5. Variables, conditions and interpolation

Variables are declared in `variables`: `{type: "string" | "integer" | "boolean", sensitive?, maxLength?}`. `maxLength` (1–500, default 500) applies to strings only. Every variable a node names must be declared (`VARIABLE_UNDECLARED`); types must fit (`VARIABLE_TYPE_MISMATCH`). A declared but never used variable, and a variable read but never assigned by any node, only warn. The runtime enforces the 4 KiB total of values; the validator warns when the declarations could exceed it. A path-sensitive "assigned before read" analysis is not attempted.

Conditions are **structured data**, never an expression: every condition has an `op`. Leaf operators: `equals`, `not_equals` (a literal of the variable's type), `in` (1–50 literals), `is_set`, `lt`, `gt` (integer variables and integer values). Combinators `all` / `any` take 1–10 `conditions` and may nest **at most two levels** (`CONDITION_TOO_DEEP`). There is no script, SQL, regular expression or free expression anywhere in the contract (a test scans the module source for `eval`, `Function`, dynamic import and regular expressions built from input).

Interpolation is `{{variable}}`, `variable` an identifier of a declared variable, in **body-like fields only**: MESSAGE `text`, BUTTONS / LIST `body` and `footer`, QUESTION `text`, and the `message` of HANDOVER and END. It is refused (`INTERPOLATION_NOT_ALLOWED`) in titles, the list `buttonLabel` and descriptions, because those must be static for the uniqueness and length checks. At most 10 placeholders per text. A `{{` or `}}` that is not part of a well-formed placeholder is `INTERPOLATION_MALFORMED` (a literal `{{` cannot be written). With the longest allowed values a text could outgrow its limit: that is a warning; the runtime re-validates the result and never truncates.

### 6. Limits

Text lengths are **UTF-16 code units** (`String.length`; an emoji counts 2, a Sinhala or Tamil letter or vowel sign 1). zod's own `.max()` counts code points, so the contract measures length itself; the unit is the conservative one against Meta's character-based limits. Configuration size is the **UTF-8 byte length of the canonical JSON** (a Sinhala letter is 3 bytes), checked after a bounded, iterative pre-scan that refuses non-JSON values, absurd depth, and size, before any recursive code runs, and checked again on the **normalized** configuration before it is returned (defaults can push an input that fit over the limit). The pre-scan's work is bounded by 100,000 values: each value is counted when it is queued, and an array or object wider than the remaining budget is refused from its length or key count before any element is read, so a dense or sparse array of any length costs one step.

Published in V3.2 section E (`FLOW_LIMITS`): configuration 64 KiB; 200 nodes; 50 variables; a variable value 500; MESSAGE text, bodies, QUESTION text and final messages 1024; footer 60; BUTTONS title 20; LIST row title 24, row description 72, button label 20; 3 button options; 10 list rows; 10 placeholders per text; condition nesting 2; name 80.

**Supplementary bounds** the V3.2 text leaves unstated (`SUPPLEMENTARY_LIMITS`), proposed in 08A so that every list in the contract is bounded, and flagged for owner confirmation: 10 triggers; 50 keyword words of 40 characters; 20 condition branches; 10 children per `all` / `any`; 50 values per `in`; idle timeout 1–1440 minutes; invalid attempts 1–5; layout coordinates within ±1,000,000; JSON nesting 32; at most 200 diagnostics returned.

### 7. Text rules

Student-facing text must be well-formed Unicode with no NUL or control character other than newline, carriage return and tab (the same predicate as `isSendableText` in the messaging module, which a test pins; it is repeated rather than imported so the pure module does not pull in the database and transport), must not be blank, and must not contain a bidirectional override or isolate (U+202A–202E, U+2066–2069), which can disguise link text. **Zero-width joiners and non-joiners are allowed**: Sinhala and Tamil need them. Titles, labels and keywords must also carry no leading or trailing whitespace. Language is plain Unicode strings (owner decision B): per-language behaviour is expressed with CONDITION branches; there is no localized string map.

### 8. URL policy

Owner decision C: **https only**. Any other scheme is an error (`URL_SCHEME_UNSUPPORTED`), including `http`, `ftp`, `file`, `javascript`, `data`, `vbscript`, `mailto`, `tel`, `sms`, `intent`, `ws`, `blob` and any `scheme://`. Plain `Time:10:30` or `Note: …` is not mistaken for a URL: a scheme is recognised only before `//` or from a list of schemes that act without it. An https URL is parsed (`new URL`, no I/O) after prose punctuation is trimmed (a closing bracket only when it has no opener in the URL, so `https://[2001:db8::1]` keeps its bracket); embedded credentials are an error; scheme-like text in the query or fragment of a recognised https URL (`?next=tel:123`) is part of that URL, while a scheme anywhere else, adjacent or not, is still checked; every https URL produces a **review warning** with its host; an IP address, `localhost`, an internationalised (`xn--`) host or a custom port produces a further warning; a bare `www.` link produces a warning. The check covers every student-facing field and string literals. Diagnostics name the scheme or host only, never the path or query.

**No interpolated URLs.** A placeholder may not form any part of a URL: a `{{…}}` (or a stray `{{` / `}}`) in the same run of non-space characters as `//` or `www.` is `URL_INTERPOLATION_NOT_ALLOWED`, which covers an interpolated scheme (`{{scheme}}://example.org`), host (`https://{{host}}`), path, query and fragment, a scheme-relative `{{prefix}}//…` and `www.{{domain}}`. A placeholder elsewhere in the same text, separated by a space from a static https URL, is ordinary interpolation.

**Run-time requirement (Phase 08B).** Static validation cannot know the values a placeholder will receive: a variable filled from a student's answer, or set to `https://…` as a whole, can still produce a link. Phase 08B MUST therefore validate the **fully rendered** outbound text against this same URL policy (and the same text rules) before producing a send effect; if the rendered text violates the policy the engine must fail safely (no send effect; the run goes to the error path) rather than send prohibited content. This is a requirement on the future engine; 08A does not implement it.

### 9. Static graph validation

Edges are `next`, every option's `next`, `onInvalid`, every branch's `next` and `else`. Checked: the start and error nodes exist; the error node is terminal; every destination exists; identifiers and option keys/titles are unique per prompt (JSON object keys cannot duplicate once parsed, so duplicate node ids are not detectable in parsed data; an editor builds the object).

**Cycle rule.** A node is _input-waiting_ (BUTTONS, LIST, QUESTION: the step stops and waits for the student; every edge leaving it is taken only after the student answers), _automatic_ (MESSAGE, CONDITION, SET_VARIABLE) or _terminal_. A cycle made **only of automatic nodes** never waits and never ends: `AUTOMATIC_CYCLE` (an error, reported once per strongly connected group, with the member ids). A cycle containing an input-waiting node is a menu and stays valid, including a menu that returns to itself on invalid input.

Checks that need the whole graph — a node unreachable from the start or error node (`NODE_UNREACHABLE`, a **warning**), a reachable node with no path to a terminal node (`NODE_CANNOT_REACH_TERMINAL`, an error), unused variables — are made only when nothing else failed, so a half-parsed node cannot produce a false report. Automatic cycles are always reported.

### 10. Diagnostics

`validateFlow` never throws and returns `{ ok, config, diagnostics, errorCount, warningCount }`. Each diagnostic is `{ severity, code, path, nodeId?, message, context? }`:

- `severity`: `error` blocks publishing; `warning` does not.
- `code`: stable and machine-readable; severity and meaning never change for a code. Editors key behaviour on the code.
- `path`: the configuration path as an array (`["nodes", "welcome", "options", 0, "next"]`); an empty path is the whole document. `nodeId` is set when the path is inside `nodes.<id>`, so a canvas can highlight the node, and the path locates the field or connection.
- `message`: a **fixed template** filled only from `context` (identifiers, limits, counts, a scheme or host). Configured text is never copied into a diagnostic (a test seeds a marker into many invalid fields and searches the output). Structural names (keys, node ids, types) may appear, because they are not student data.
- Errors first, then warnings, each ordered by path then code; identical findings are reported once; at most 200 are returned, with `TOO_MANY_DIAGNOSTICS` first when truncated.

`DIAGNOSTIC_CODES`, `severityOf` and `templateOf` are exported so an editor can render its own wording.

Diagnostic codes (generated from `diagnostics.ts`; a test checks that every code is listed here):

| Code                                 | Severity | Message template                                                                                                              |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CONFIG_NOT_JSON`                    | error    | The configuration must be plain JSON data (objects, arrays, strings, finite numbers, booleans, null).                         |
| `CONFIG_TOO_DEEP`                    | error    | The configuration is nested deeper than {max} levels.                                                                         |
| `CONFIG_TOO_LARGE`                   | error    | The configuration is larger than the limit of {max} bytes.                                                                    |
| `TOO_MANY_DIAGNOSTICS`               | error    | More than {max} problems were found; only the first {max} are reported.                                                       |
| `VALIDATOR_INTERNAL_ERROR`           | error    | The validator could not complete. This is a defect in the validator, not in the flow.                                         |
| `FIELD_REQUIRED`                     | error    | This field is required.                                                                                                       |
| `FIELD_UNKNOWN`                      | error    | Unknown field '{field}'. Unknown fields are not accepted.                                                                     |
| `FIELD_TYPE_INVALID`                 | error    | This field has the wrong type; expected {expected}.                                                                           |
| `FIELD_INVALID`                      | error    | This value is not valid.                                                                                                      |
| `VALUE_NOT_ALLOWED`                  | error    | This value is not one of the allowed values.                                                                                  |
| `TEXT_TOO_SHORT`                     | error    | This text is shorter than the minimum of {min}.                                                                               |
| `TEXT_TOO_LONG`                      | error    | This text is longer than the maximum of {max} characters.                                                                     |
| `LIST_TOO_SHORT`                     | error    | This list needs at least {min} item(s).                                                                                       |
| `LIST_TOO_LONG`                      | error    | This list allows at most {max} item(s).                                                                                       |
| `NUMBER_TOO_SMALL`                   | error    | This number is below the minimum of {min}.                                                                                    |
| `NUMBER_TOO_LARGE`                   | error    | This number is above the maximum of {max}.                                                                                    |
| `NUMBER_NOT_INTEGER`                 | error    | This number must be a whole number within the safe integer range.                                                             |
| `TEXT_BLANK`                         | error    | This text must not be blank.                                                                                                  |
| `TEXT_INVALID_CHARACTERS`            | error    | This text contains control characters or malformed Unicode.                                                                   |
| `TEXT_BIDI_OVERRIDE`                 | error    | This text contains a bidirectional override character, which can disguise links.                                              |
| `TEXT_UNTRIMMED`                     | error    | This text must not start or end with whitespace.                                                                              |
| `IDENTIFIER_INVALID`                 | error    | Identifiers start with a lowercase letter and contain only lowercase letters, digits and underscores (at most 32 characters). |
| `SCHEMA_VERSION_UNSUPPORTED`         | error    | Schema version {found} is not supported; this validator supports version {supported}.                                         |
| `NODE_COUNT_EXCEEDED`                | error    | A flow may have at most {max} nodes.                                                                                          |
| `VARIABLE_COUNT_EXCEEDED`            | error    | A flow may declare at most {max} variables.                                                                                   |
| `NODE_TYPE_UNSUPPORTED`              | error    | Node type '{found}' is not supported.                                                                                         |
| `TRIGGER_KIND_UNSUPPORTED`           | error    | Trigger kind '{found}' is not supported.                                                                                      |
| `TRIGGER_DUPLICATE`                  | error    | This trigger kind appears more than once.                                                                                     |
| `KEYWORD_DUPLICATE`                  | error    | This keyword appears more than once in the trigger.                                                                           |
| `TERMINAL_NODE_HAS_TRANSITION`       | error    | A {type} node ends the session and must not have an outgoing transition ('{field}').                                          |
| `OPTION_KEY_DUPLICATE`               | error    | Option key '{key}' is used more than once in this node.                                                                       |
| `OPTION_TITLE_DUPLICATE`             | error    | Two options in this node have the same title.                                                                                 |
| `HANDOVER_REASON_UNSUPPORTED`        | error    | This handover reason is not on the allowed list.                                                                              |
| `START_NODE_MISSING`                 | error    | The start node '{target}' does not exist.                                                                                     |
| `ERROR_NODE_MISSING`                 | error    | The error node '{target}' does not exist.                                                                                     |
| `ERROR_NODE_NOT_TERMINAL`            | error    | The error node must be a HANDOVER or END node; '{target}' is a {type} node.                                                   |
| `REFERENCE_MISSING`                  | error    | The destination node '{target}' does not exist.                                                                               |
| `VARIABLE_UNDECLARED`                | error    | Variable '{variable}' is not declared in 'variables'.                                                                         |
| `VARIABLE_TYPE_MISMATCH`             | error    | This does not fit variable '{variable}', which is a {variableType}.                                                           |
| `VARIABLE_MAXLENGTH_NOT_ALLOWED`     | error    | 'maxLength' applies to string variables only.                                                                                 |
| `VALUE_EXCEEDS_VARIABLE`             | error    | This value is longer than variable '{variable}' allows ({max}).                                                               |
| `ANSWER_FIELD_NOT_ALLOWED`           | error    | Field '{field}' is not valid for a {kind} answer.                                                                             |
| `ANSWER_RANGE_INVALID`               | error    | The minimum must not be greater than the maximum.                                                                             |
| `ANSWER_EXCEEDS_VARIABLE`            | error    | The answer may be longer than variable '{variable}' can hold ({max}).                                                         |
| `VARIABLE_UNUSED`                    | warning  | Variable '{variable}' is declared but never used.                                                                             |
| `VARIABLE_NEVER_ASSIGNED`            | warning  | Variable '{variable}' is read but no node ever assigns it.                                                                    |
| `VARIABLES_MAY_EXCEED_TOTAL`         | warning  | The declared variables could together hold more than {max} characters; the runtime enforces this limit.                       |
| `CONDITION_TOO_DEEP`                 | error    | Conditions may nest 'all' / 'any' at most {max} levels deep.                                                                  |
| `CONDITION_OPERATOR_UNSUPPORTED`     | error    | Operator '{found}' is not supported.                                                                                          |
| `INTERPOLATION_MALFORMED`            | error    | A '{{' or '}}' here is not part of a well-formed {{variable}} placeholder.                                                    |
| `INTERPOLATION_UNDECLARED`           | error    | Placeholder '{variable}' refers to a variable that is not declared.                                                           |
| `INTERPOLATION_NOT_ALLOWED`          | error    | Placeholders are allowed in message text only, not in titles, labels, keys or descriptions.                                   |
| `INTERPOLATION_TOO_MANY`             | error    | A text may contain at most {max} placeholders.                                                                                |
| `INTERPOLATED_TEXT_MAY_EXCEED_LIMIT` | warning  | With the longest allowed variable values this text could exceed {max} characters; the run would end in the error node.        |
| `URL_SCHEME_UNSUPPORTED`             | error    | URL scheme '{scheme}' is not supported; only https links are allowed.                                                         |
| `URL_MALFORMED`                      | error    | This does not parse as an https URL.                                                                                          |
| `URL_CREDENTIALS_NOT_ALLOWED`        | error    | URLs must not contain a user name or password.                                                                                |
| `URL_INTERPOLATION_NOT_ALLOWED`      | error    | A URL must not contain a {{variable}} placeholder.                                                                            |
| `URL_REVIEW_RECOMMENDED`             | warning  | This text links to {host}. Check that the link is correct and trusted before publishing.                                      |
| `URL_HOST_UNUSUAL`                   | warning  | The link host {host} is an IP address, a local name, an internationalised name or uses a custom port; check it carefully.     |
| `URL_SCHEME_MISSING`                 | warning  | A link written as 'www.' without 'https://' may be shown as a link; write the full https:// address.                          |
| `AUTOMATIC_CYCLE`                    | error    | These nodes run one after another without waiting for the student, forever: {nodes}.                                          |
| `NODE_UNREACHABLE`                   | warning  | This node can never be reached from the start node or the error node.                                                         |
| `NODE_CANNOT_REACH_TERMINAL`         | error    | From this node no path leads to a HANDOVER or END node.                                                                       |
| `START_NODE_END_WITHOUT_MESSAGE`     | warning  | The start node is an END without a message, so this bot ends at once and sends nothing.                                       |
| `TRIGGERS_EMPTY`                     | warning  | No triggers are configured, so no incoming message can start this bot.                                                        |
| `LAYOUT_UNKNOWN_NODE`                | warning  | This layout entry names a node that does not exist.                                                                           |

### 11. Interactive reply identifiers

Syntax of the V3.2 contract, `b1.<promptToken>.<optionKey>`: `^b1\.[A-Za-z0-9_-]{22}\.[a-z][a-z0-9_]{0,31}$`, at most 58 characters (within the 64 we set and Meta's 256 / 200). The token is generated by the runtime in 08E (128 random bits in base64url); the validator and `formatReplyId` never create one. Every option key the contract accepts forms a valid identifier. `isReplyId`, `parseReplyId` and `formatReplyId` check syntax only; nothing assumes Meta supplies reply context, and reply evaluation is 08B.

### 12. Schema evolution and Bot Studio compatibility

`schemaVersion` is an integer. A later version is a new contract with a pure `vN → vN+1` migration of **drafts**; a published version is never rewritten (ADR 0007). The validator rejects versions it does not know instead of guessing. The document is editor-shaped: a flat node map, explicit transition fields (ports), `layout` kept separate, path-addressed diagnostics with stable codes, and a validator that can run on every keystroke because it is pure and bounded. Studio and the publishing service call the same `validateFlow`.

## Owner decisions confirmed for 08A

|     | Decision                                                                       | Confirmed |
| --- | ------------------------------------------------------------------------------ | --------- |
| A   | Triggers: `keyword`, `first_message`, `referral_source`                        | yes       |
| B   | Language: plain Unicode strings; behaviour through branches; no localized maps | yes       |
| C   | URLs: https only; other schemes are errors; https links get a review warning   | yes       |

## Interpretations of V3.2 recorded for review

1. Text length unit is UTF-16 code units, measured explicitly (section 6).
2. The condition grammar (`op`, `variable`, `value` / `values`, `conditions`), variable types and answer kinds are defined here; V3.2 named the operators and the nesting rule only.
3. Interpolation is limited to body-like fields (section 5).
4. The supplementary bounds in section 6.
5. The HANDOVER reason list (section 3).
6. Bidirectional overrides are refused, and the https review warning is emitted for every https link.

## Open production blocker: acceptance-recording concurrency (P2)

The independent review of the V3.2 architecture left one **P2 concurrency finding** on the path that records an outbound request's acceptance (the dispatcher's `ACCEPTED` record interacting with other transactions on the same conversation). It was explicitly **deferred from development approval and MUST be resolved before production sign-off.** It is **OPEN**. Phase 08A does not touch the dispatcher or any outbound code and does not resolve it; passing 08A tests says nothing about it. V3.2 specifies acceptance-recording concurrency tests (R3-L) for checkpoints 08D and 08E; they are necessary but this ADR does not claim they are sufficient to close the finding. It must not be treated as closed by any green test suite.

## Consequences

- Every later checkpoint reads a configuration that has passed one strict, deterministic gate; the engine can assume the invariants listed above.
- The contract is fixed by tests: about 250 cases cover each node type, every rejection path, Unicode text, the URL policy, determinism and the module's purity.
- The supplementary bounds and interpretations above may change before 08B depends on them; changing a published limit afterwards is a schema change.
