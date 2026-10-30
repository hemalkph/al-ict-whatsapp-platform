import { canonicalSizeBytes, checkJsonShape } from "./canonical";
import { Collector } from "./diagnostics";
import { analyzeGraph, isTerminalNode, nodeEdges } from "./graph";
import {
  ANSWER_KINDS,
  CONDITION_COMBINATORS,
  CONDITION_LEAF_OPERATORS,
  DEFAULT_SETTINGS,
  FLOW_LIMITS as L,
  HANDOVER_REASON_CODES,
  ID_PATTERN,
  NODE_TYPES,
  SCHEMA_VERSION,
  SUPPLEMENTARY_LIMITS as S,
  TERMINAL_NODE_TYPES,
  TRIGGER_KINDS,
} from "./limits";
import {
  buttonsNodeSchema,
  conditionNodeSchema,
  endNodeSchema,
  firstMessageTriggerSchema,
  handoverNodeSchema,
  identifier,
  keywordTriggerSchema,
  layoutSchema,
  listNodeSchema,
  literalString,
  messageNodeSchema,
  nameSchema,
  questionNodeSchema,
  referralSourceTriggerSchema,
  setVariableNodeSchema,
  settingsSchema,
  variableSchema,
} from "./schemas";
import { analyzeInterpolation, comparisonKey, placeholderWidth } from "./text";
import type {
  Answer,
  Condition,
  ConfigPath,
  FlowConfig,
  FlowNode,
  HandoverReasonCode,
  Literal,
  Trigger,
  ValidationResult,
  VariableDecl,
} from "./types";
import { scanUrls } from "./urls";
import { isRecord, parseWith, safeName } from "./zod-diagnostics";

// The flow validator (Phase 08A). A PURE function of its input: no database, no network, no clock, no randomness, no
// environment, no filesystem. The same input always gives the same, identically ordered result.
//
// Phases: (1) the input is plain JSON of a sane size and depth; (2) the structure of every part, strictly; (3) the meaning of
// every node (declared variables, types, interpolation, URLs); (4) destinations; (5) automatic cycles; (6) checks that need
// the whole graph and are therefore only made when nothing above failed (reachability, termination, unused variables).

type Ctx = {
  readonly c: Collector;
  readonly root: unknown;
  /** Every identifier-shaped key of `variables`, whether or not its declaration parsed. */
  readonly declared: Set<string>;
  /** The declarations that parsed. */
  readonly vars: Map<string, VariableDecl>;
  readonly referenced: Set<string>;
  readonly assigned: Set<string>;
};

const ROOT_KEYS = new Set([
  "schemaVersion",
  "name",
  "startNodeId",
  "errorNodeId",
  "triggers",
  "settings",
  "variables",
  "nodes",
  "layout",
]);
const TRANSITION_FIELDS = ["next", "onInvalid", "else", "options", "branches"] as const;

export function validateFlow(input: unknown): ValidationResult {
  const c = new Collector();
  let config: FlowConfig | null = null;
  try {
    config = run(input, c);
  } catch {
    c.add("VALIDATOR_INTERNAL_ERROR", []);
  }
  const diagnostics = c.finish();
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const ok = errorCount === 0 && config !== null;
  return {
    ok,
    config: ok ? config : null,
    diagnostics,
    errorCount,
    warningCount: diagnostics.length - errorCount,
  };
}

function run(input: unknown, c: Collector): FlowConfig | null {
  // (1) plain JSON, bounded
  const shape = checkJsonShape(input);
  if (shape !== "ok") {
    c.add(
      shape,
      [],
      shape === "CONFIG_TOO_DEEP"
        ? { max: S.jsonDepthMax }
        : shape === "CONFIG_TOO_LARGE"
          ? { max: L.configBytesMax }
          : undefined,
    );
    return null;
  }
  if (canonicalSizeBytes(input) > L.configBytesMax) {
    c.add("CONFIG_TOO_LARGE", [], { max: L.configBytesMax });
    return null;
  }
  if (!isRecord(input)) {
    c.add("FIELD_TYPE_INVALID", [], { expected: "object" });
    return null;
  }

  // (2) structure
  for (const key of Object.keys(input)) {
    if (!ROOT_KEYS.has(key)) c.add("FIELD_UNKNOWN", [key], { field: safeName(key) });
  }
  const version = input.schemaVersion;
  if (version === undefined) c.add("FIELD_REQUIRED", ["schemaVersion"]);
  else if (version !== SCHEMA_VERSION) {
    if (typeof version === "number") {
      // The rest of the document cannot be judged against an unknown contract.
      c.add("SCHEMA_VERSION_UNSUPPORTED", ["schemaVersion"], {
        found: Number.isFinite(version) ? version : 0,
        supported: SCHEMA_VERSION,
      });
      return null;
    }
    c.add("FIELD_TYPE_INVALID", ["schemaVersion"], { expected: "number" });
  }

  const name = parseWith(nameSchema, input.name, ["name"], input, c);
  const startNodeId = parseWith(identifier, input.startNodeId, ["startNodeId"], input, c);
  const errorNodeId = parseWith(identifier, input.errorNodeId, ["errorNodeId"], input, c);
  const triggers = readTriggers(input.triggers, input, c);
  const settings = readSettings(input.settings, input, c);

  const ctx: Ctx = {
    c,
    root: input,
    declared: new Set(),
    vars: new Map(),
    referenced: new Set(),
    assigned: new Set(),
  };
  const variables = readVariables(input.variables, ctx);
  const { nodes, nodeIds } = readNodes(input.nodes, ctx);
  readLayout(input.layout, nodeIds, ctx);

  // (4) destinations
  if (startNodeId !== undefined && !nodeIds.has(startNodeId))
    c.add("START_NODE_MISSING", ["startNodeId"], { target: startNodeId });
  if (errorNodeId !== undefined) {
    if (!nodeIds.has(errorNodeId))
      c.add("ERROR_NODE_MISSING", ["errorNodeId"], { target: errorNodeId });
    else {
      const errorNode = nodes.get(errorNodeId);
      if (errorNode && !isTerminalNode(errorNode))
        c.add("ERROR_NODE_NOT_TERMINAL", ["errorNodeId"], {
          target: errorNodeId,
          type: errorNode.type,
        });
    }
  }
  for (const [id, node] of nodes) {
    for (const edge of nodeEdges(id, node)) {
      if (!nodeIds.has(edge.to)) c.add("REFERENCE_MISSING", edge.path, { target: edge.to });
    }
  }
  if (startNodeId !== undefined) {
    const start = nodes.get(startNodeId);
    if (start?.type === "END" && start.message === undefined)
      c.add("START_NODE_END_WITHOUT_MESSAGE", ["startNodeId"]);
  }

  // (5) automatic cycles: real whatever else is wrong, so reported even when other errors exist
  const completeBefore = c.errorCount === 0;
  if (startNodeId !== undefined && errorNodeId !== undefined) {
    const graph = analyzeGraph({ startNodeId, errorNodeId, nodes });
    for (const group of graph.automaticCycles) {
      c.add("AUTOMATIC_CYCLE", ["nodes", group[0]!], { nodes: group });
    }

    // (6) whole-graph checks: only when every node parsed and every destination exists
    if (completeBefore) {
      for (const id of [...nodes.keys()].sort()) {
        if (!graph.reachable.has(id)) c.add("NODE_UNREACHABLE", ["nodes", id]);
        else if (graph.reachableFromStart.has(id) && !graph.canReachTerminal.has(id))
          c.add("NODE_CANNOT_REACH_TERMINAL", ["nodes", id]);
      }
      checkVariableUse(ctx);
    }
  }

  if (c.errorCount > 0) return null;
  if (
    name === undefined ||
    startNodeId === undefined ||
    errorNodeId === undefined ||
    triggers === undefined ||
    variables === undefined
  )
    return null;
  const config: FlowConfig = {
    schemaVersion: SCHEMA_VERSION,
    name,
    startNodeId,
    errorNodeId,
    triggers,
    settings,
    variables,
    nodes: Object.fromEntries(nodes),
    layout: readLayoutOutput(input.layout),
  };
  // The limit applies to what is published: defaults can push an input that fit over it.
  if (canonicalSizeBytes(config) > L.configBytesMax) {
    c.add("CONFIG_TOO_LARGE", [], { max: L.configBytesMax });
    return null;
  }
  return config;
}

// ------------------------------------------------------------------------------------------------------------ helpers

function checkKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: ConfigPath,
  c: Collector,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) c.add("FIELD_UNKNOWN", [...path, key], { field: safeName(key) });
  }
}

function objectAt(
  value: unknown,
  path: ConfigPath,
  c: Collector,
  options: { required: boolean },
): Record<string, unknown> | undefined {
  if (value === undefined) {
    if (options.required) c.add("FIELD_REQUIRED", path);
    return undefined;
  }
  if (!isRecord(value)) {
    c.add("FIELD_TYPE_INVALID", path, { expected: "object" });
    return undefined;
  }
  return value;
}

// ------------------------------------------------------------------------------------------------------------ triggers

function readTriggers(raw: unknown, root: unknown, c: Collector): Trigger[] | undefined {
  if (raw === undefined) {
    c.add("FIELD_REQUIRED", ["triggers"]);
    return undefined;
  }
  if (!Array.isArray(raw)) {
    c.add("FIELD_TYPE_INVALID", ["triggers"], { expected: "array" });
    return undefined;
  }
  if (raw.length > S.triggersMax) c.add("LIST_TOO_LONG", ["triggers"], { max: S.triggersMax });
  if (raw.length === 0) c.add("TRIGGERS_EMPTY", ["triggers"]);

  const out: Trigger[] = [];
  const kindsSeen = new Set<string>();
  let failed = false;
  raw.forEach((item, i) => {
    const path: ConfigPath = ["triggers", i];
    if (!isRecord(item)) {
      c.add("FIELD_TYPE_INVALID", path, { expected: "object" });
      failed = true;
      return;
    }
    const kind = item.kind;
    if (kind === undefined) {
      c.add("FIELD_REQUIRED", [...path, "kind"]);
      failed = true;
      return;
    }
    if (typeof kind !== "string") {
      c.add("FIELD_TYPE_INVALID", [...path, "kind"], { expected: "string" });
      failed = true;
      return;
    }
    if (!(TRIGGER_KINDS as readonly string[]).includes(kind)) {
      c.add("TRIGGER_KIND_UNSUPPORTED", [...path, "kind"], { found: safeName(kind) });
      failed = true;
      return;
    }
    const schema =
      kind === "keyword"
        ? keywordTriggerSchema
        : kind === "first_message"
          ? firstMessageTriggerSchema
          : referralSourceTriggerSchema;
    const trigger = parseWith(schema, item, path, root, c);
    if (!trigger) {
      failed = true;
      return;
    }
    if (trigger.kind === "keyword") {
      const words = new Set<string>();
      trigger.words.forEach((word, j) => {
        const key = comparisonKey(word);
        if (words.has(key)) c.add("KEYWORD_DUPLICATE", [...path, "words", j]);
        words.add(key);
      });
    } else if (kindsSeen.has(trigger.kind)) {
      c.add("TRIGGER_DUPLICATE", path);
    }
    kindsSeen.add(trigger.kind);
    out.push(trigger as Trigger);
  });
  return failed ? undefined : out;
}

// ------------------------------------------------------------------------------------------------------------ settings

function readSettings(raw: unknown, root: unknown, c: Collector): FlowConfig["settings"] {
  const defaults = { ...DEFAULT_SETTINGS };
  if (raw === undefined) return defaults;
  const parsed = parseWith(settingsSchema, raw, ["settings"], root, c);
  return {
    idleTimeoutMinutes: parsed?.idleTimeoutMinutes ?? defaults.idleTimeoutMinutes,
    maxInvalidAttempts: parsed?.maxInvalidAttempts ?? defaults.maxInvalidAttempts,
  };
}

// ----------------------------------------------------------------------------------------------------------- variables

function readVariables(raw: unknown, ctx: Ctx): Record<string, VariableDecl> | undefined {
  const { c } = ctx;
  const out: Record<string, VariableDecl> = {};
  if (raw === undefined) return out;
  const object = objectAt(raw, ["variables"], c, { required: false });
  if (!object) return undefined;
  const names = Object.keys(object);
  if (names.length > L.variablesMax)
    c.add("VARIABLE_COUNT_EXCEEDED", ["variables"], { max: L.variablesMax });
  let failed = false;
  for (const name of names) {
    const path: ConfigPath = ["variables", name];
    if (!ID_PATTERN.test(name)) {
      c.add("IDENTIFIER_INVALID", path);
      failed = true;
      continue;
    }
    ctx.declared.add(name);
    const decl = parseWith(variableSchema, object[name], path, ctx.root, c);
    if (!decl) {
      failed = true;
      continue;
    }
    if (decl.type !== "string" && decl.maxLength !== undefined) {
      c.add("VARIABLE_MAXLENGTH_NOT_ALLOWED", [...path, "maxLength"]);
      failed = true;
      continue;
    }
    const normalized: VariableDecl = {
      type: decl.type,
      sensitive: decl.sensitive ?? false,
      ...(decl.type === "string" ? { maxLength: decl.maxLength ?? L.variableValueMax } : {}),
    };
    ctx.vars.set(name, normalized);
    out[name] = normalized;
  }
  return failed ? undefined : out;
}

// -------------------------------------------------------------------------------------------------------------- nodes

function readNodes(raw: unknown, ctx: Ctx): { nodes: Map<string, FlowNode>; nodeIds: Set<string> } {
  const { c } = ctx;
  const nodes = new Map<string, FlowNode>();
  const nodeIds = new Set<string>();
  const object = objectAt(raw, ["nodes"], c, { required: true });
  if (!object) return { nodes, nodeIds };
  const ids = Object.keys(object);
  if (ids.length === 0) c.add("LIST_TOO_SHORT", ["nodes"], { min: 1 });
  if (ids.length > L.nodesMax) c.add("NODE_COUNT_EXCEEDED", ["nodes"], { max: L.nodesMax });
  for (const id of ids) {
    if (!ID_PATTERN.test(id)) {
      c.add("IDENTIFIER_INVALID", ["nodes", id]);
      continue;
    }
    nodeIds.add(id);
    const node = readNode(id, object[id], ctx);
    if (node) nodes.set(id, node);
  }
  return { nodes, nodeIds };
}

function readNode(id: string, raw: unknown, ctx: Ctx): FlowNode | undefined {
  const { c } = ctx;
  const path: ConfigPath = ["nodes", id];
  if (!isRecord(raw)) {
    c.add("FIELD_TYPE_INVALID", path, { expected: "object" });
    return undefined;
  }
  const type = raw.type;
  if (type === undefined) {
    c.add("FIELD_REQUIRED", [...path, "type"]);
    return undefined;
  }
  if (typeof type !== "string") {
    c.add("FIELD_TYPE_INVALID", [...path, "type"], { expected: "string" });
    return undefined;
  }
  if (!(NODE_TYPES as readonly string[]).includes(type)) {
    c.add("NODE_TYPE_UNSUPPORTED", [...path, "type"], { found: safeName(type) });
    return undefined;
  }

  let body: Record<string, unknown> = raw;
  if ((TERMINAL_NODE_TYPES as readonly string[]).includes(type)) {
    body = { ...raw };
    for (const field of TRANSITION_FIELDS) {
      if (Object.hasOwn(raw, field)) {
        c.add("TERMINAL_NODE_HAS_TRANSITION", [...path, field], { type, field });
        delete body[field];
      }
    }
  }

  switch (type) {
    case "MESSAGE": {
      const node = parseWith(messageNodeSchema, body, path, ctx.root, c);
      if (!node) return undefined;
      checkTexts(
        id,
        [{ rel: ["text"], value: node.text, max: L.textMax, interpolates: true }],
        ctx,
      );
      return node;
    }
    case "BUTTONS": {
      const node = parseWith(buttonsNodeSchema, body, path, ctx.root, c);
      if (!node) return undefined;
      checkOptions(id, node.options, ctx);
      checkTexts(
        id,
        [
          { rel: ["body"], value: node.body, max: L.textMax, interpolates: true },
          ...(node.footer === undefined
            ? []
            : [{ rel: ["footer"], value: node.footer, max: L.footerMax, interpolates: true }]),
          ...node.options.map((o, i) => ({
            rel: ["options", i, "title"] as ConfigPath,
            value: o.title,
            max: L.buttonTitleMax,
            interpolates: false,
          })),
        ],
        ctx,
      );
      return node;
    }
    case "LIST": {
      const node = parseWith(listNodeSchema, body, path, ctx.root, c);
      if (!node) return undefined;
      checkOptions(id, node.options, ctx);
      checkTexts(
        id,
        [
          { rel: ["body"], value: node.body, max: L.textMax, interpolates: true },
          {
            rel: ["buttonLabel"],
            value: node.buttonLabel,
            max: L.listButtonLabelMax,
            interpolates: false,
          },
          ...(node.footer === undefined
            ? []
            : [{ rel: ["footer"], value: node.footer, max: L.footerMax, interpolates: true }]),
          ...node.options.flatMap((o, i) => [
            {
              rel: ["options", i, "title"] as ConfigPath,
              value: o.title,
              max: L.listRowTitleMax,
              interpolates: false,
            },
            ...(o.description === undefined
              ? []
              : [
                  {
                    rel: ["options", i, "description"] as ConfigPath,
                    value: o.description,
                    max: L.listRowDescriptionMax,
                    interpolates: false,
                  },
                ]),
          ]),
        ],
        ctx,
      );
      return node;
    }
    case "QUESTION": {
      const node = parseWith(questionNodeSchema, body, path, ctx.root, c);
      if (!node) return undefined;
      checkTexts(
        id,
        [{ rel: ["text"], value: node.text, max: L.textMax, interpolates: true }],
        ctx,
      );
      const answer = checkQuestion(id, node, ctx);
      if (!answer) return undefined;
      return { ...node, answer };
    }
    case "CONDITION": {
      const node = parseWith(conditionNodeSchema, body, path, ctx.root, c);
      if (!node) return undefined;
      const branches: { when: Condition; next: string }[] = [];
      let failed = false;
      node.branches.forEach((branch, i) => {
        const when = readCondition(branch.when, [...path, "branches", i, "when"], 0, ctx);
        if (when) branches.push({ when, next: branch.next });
        else failed = true;
      });
      return failed ? undefined : { type: "CONDITION", branches, else: node.else };
    }
    case "SET_VARIABLE": {
      const node = parseWith(setVariableNodeSchema, body, path, ctx.root, c);
      if (!node) return undefined;
      return checkSetVariable(id, node, ctx) ? node : undefined;
    }
    case "HANDOVER": {
      const node = parseWith(handoverNodeSchema, body, path, ctx.root, c);
      if (!node) return undefined;
      if (!(HANDOVER_REASON_CODES as readonly string[]).includes(node.reason)) {
        c.add("HANDOVER_REASON_UNSUPPORTED", [...path, "reason"]);
        return undefined;
      }
      if (node.message !== undefined)
        checkTexts(
          id,
          [{ rel: ["message"], value: node.message, max: L.textMax, interpolates: true }],
          ctx,
        );
      return { ...node, reason: node.reason as HandoverReasonCode };
    }
    default: {
      const node = parseWith(endNodeSchema, body, path, ctx.root, c);
      if (!node) return undefined;
      if (node.message !== undefined)
        checkTexts(
          id,
          [{ rel: ["message"], value: node.message, max: L.textMax, interpolates: true }],
          ctx,
        );
      return node;
    }
  }
}

// ------------------------------------------------------------------------------------------- text, URLs, placeholders

type TextField = {
  readonly rel: ConfigPath;
  readonly value: string;
  readonly max: number;
  /** `{{variable}}` placeholders are allowed (bodies, texts, footers, final messages) or not (titles, labels, descriptions). */
  readonly interpolates: boolean;
};

function checkTexts(id: string, fields: readonly TextField[], ctx: Ctx): void {
  const { c } = ctx;
  for (const field of fields) {
    const path: ConfigPath = ["nodes", id, ...field.rel];
    const parts = analyzeInterpolation(field.value);

    if (!field.interpolates) {
      if (parts.names.length > 0 || parts.malformed) c.add("INTERPOLATION_NOT_ALLOWED", path);
    } else {
      if (parts.malformed) c.add("INTERPOLATION_MALFORMED", path);
      if (parts.names.length > L.placeholdersPerTextMax)
        c.add("INTERPOLATION_TOO_MANY", path, { max: L.placeholdersPerTextMax });
      let widths = 0;
      let allDeclared = true;
      for (const name of parts.names) {
        ctx.referenced.add(name);
        if (!ctx.declared.has(name)) {
          allDeclared = false;
          c.add("INTERPOLATION_UNDECLARED", path, { variable: name });
        } else widths += placeholderWidth(ctx.vars.get(name));
      }
      if (
        allDeclared &&
        !parts.malformed &&
        parts.names.length > 0 &&
        parts.literal.length + widths > field.max
      )
        c.add("INTERPOLATED_TEXT_MAY_EXCEED_LIMIT", path, { max: field.max });
    }
    reportUrls(field.value, path, c);
  }
}

function reportUrls(value: string, path: ConfigPath, c: Collector): void {
  for (const finding of scanUrls(value)) c.add(finding.code, path, finding.context);
}

function checkOptions(
  id: string,
  options: readonly { key: string; title: string }[],
  ctx: Ctx,
): void {
  const keys = new Set<string>();
  const titles = new Set<string>();
  options.forEach((option, i) => {
    if (keys.has(option.key))
      ctx.c.add("OPTION_KEY_DUPLICATE", ["nodes", id, "options", i, "key"], { key: option.key });
    keys.add(option.key);
    const title = comparisonKey(option.title);
    if (titles.has(title))
      ctx.c.add("OPTION_TITLE_DUPLICATE", ["nodes", id, "options", i, "title"]);
    titles.add(title);
  });
}

// ------------------------------------------------------------------------------------------------ QUESTION / SET_VARIABLE

const ANSWER_VARIABLE_TYPE = { text: "string", integer: "integer", yes_no: "boolean" } as const;

function checkQuestion(
  id: string,
  node: {
    variable: string;
    answer: {
      kind: (typeof ANSWER_KINDS)[number];
      min?: number;
      max?: number;
      rejectLinks?: boolean;
    };
  },
  ctx: Ctx,
): Answer | undefined {
  const { c } = ctx;
  const base: ConfigPath = ["nodes", id];
  const { kind, min, max, rejectLinks } = node.answer;
  let ok = true;

  if (!ctx.declared.has(node.variable)) {
    c.add("VARIABLE_UNDECLARED", [...base, "variable"], { variable: node.variable });
    ok = false;
  }
  ctx.assigned.add(node.variable);
  const decl = ctx.vars.get(node.variable);
  if (decl && decl.type !== ANSWER_VARIABLE_TYPE[kind]) {
    c.add("VARIABLE_TYPE_MISMATCH", [...base, "answer", "kind"], {
      variable: node.variable,
      variableType: decl.type,
    });
    ok = false;
  }

  if (rejectLinks !== undefined && kind !== "text") {
    c.add("ANSWER_FIELD_NOT_ALLOWED", [...base, "answer", "rejectLinks"], {
      field: "rejectLinks",
      kind,
    });
    ok = false;
  }

  const wholeNumber = (value: number | undefined, field: "min" | "max"): boolean => {
    if (value === undefined) return true;
    if (!Number.isSafeInteger(value)) {
      c.add("NUMBER_NOT_INTEGER", [...base, "answer", field]);
      return false;
    }
    return true;
  };

  if (kind === "yes_no") {
    for (const field of ["min", "max"] as const) {
      if (node.answer[field] !== undefined) {
        c.add("ANSWER_FIELD_NOT_ALLOWED", [...base, "answer", field], { field, kind });
        ok = false;
      }
    }
    return ok ? { kind } : undefined;
  }

  if (!wholeNumber(min, "min") || !wholeNumber(max, "max")) return undefined;
  if (kind === "text") {
    if (max === undefined) {
      c.add("FIELD_REQUIRED", [...base, "answer", "max"]);
      return undefined;
    }
    // An empty answer is never accepted: the effective minimum is 1 whether or not `min` is written, so `max` must be >= 1.
    for (const [field, value] of [
      ["min", min],
      ["max", max],
    ] as const) {
      if (value !== undefined && value < 1) {
        c.add("NUMBER_TOO_SMALL", [...base, "answer", field], { min: 1 });
        ok = false;
      }
    }
    if (decl?.type === "string" && decl.maxLength !== undefined && max > decl.maxLength) {
      c.add("ANSWER_EXCEEDS_VARIABLE", [...base, "answer", "max"], {
        variable: node.variable,
        max: decl.maxLength,
      });
      ok = false;
    }
  }
  if (min !== undefined && max !== undefined && min > max) {
    c.add("ANSWER_RANGE_INVALID", [...base, "answer"]);
    ok = false;
  }
  if (!ok) return undefined;
  return kind === "text"
    ? {
        kind,
        ...(min === undefined ? {} : { min }),
        max: max!,
        ...(rejectLinks ? { rejectLinks: true as const } : {}),
      }
    : { kind, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
}

function checkSetVariable(
  id: string,
  node: { variable: string; value: Literal },
  ctx: Ctx,
): boolean {
  const { c } = ctx;
  const base: ConfigPath = ["nodes", id];
  let ok = true;
  if (!ctx.declared.has(node.variable)) {
    c.add("VARIABLE_UNDECLARED", [...base, "variable"], { variable: node.variable });
    ok = false;
  }
  ctx.assigned.add(node.variable);
  const decl = ctx.vars.get(node.variable);
  const value = readLiteral(node.value, [...base, "value"], node.variable, decl, ctx);
  if (value === undefined) return false;
  if (typeof value === "string") {
    reportUrls(value, [...base, "value"], c);
    if (decl?.type === "string" && decl.maxLength !== undefined && value.length > decl.maxLength) {
      c.add("VALUE_EXCEEDS_VARIABLE", [...base, "value"], {
        variable: node.variable,
        max: decl.maxLength,
      });
      ok = false;
    }
  }
  return ok;
}

/** Checks one literal against the variable's declared type (when the declaration is known). */
function readLiteral(
  value: unknown,
  path: ConfigPath,
  variable: string,
  decl: VariableDecl | undefined,
  ctx: Ctx,
): Literal | undefined {
  const { c } = ctx;
  const mismatch = () => {
    c.add("VARIABLE_TYPE_MISMATCH", path, { variable, variableType: decl?.type ?? "unknown" });
    return undefined;
  };
  if (typeof value === "string") {
    const parsed = parseWith(literalString, value, path, ctx.root, c);
    if (parsed === undefined) return undefined;
    return decl && decl.type !== "string" ? mismatch() : parsed;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      c.add("NUMBER_NOT_INTEGER", path);
      return undefined;
    }
    return decl && decl.type !== "integer" ? mismatch() : value;
  }
  if (typeof value === "boolean") return decl && decl.type !== "boolean" ? mismatch() : value;
  if (value === undefined) c.add("FIELD_REQUIRED", path);
  else c.add("FIELD_TYPE_INVALID", path, { expected: "string, number or boolean" });
  return undefined;
}

// ----------------------------------------------------------------------------------------------------------- conditions

const COMBINATORS = new Set<string>(CONDITION_COMBINATORS);
const LEAF_OPERATORS = new Set<string>(CONDITION_LEAF_OPERATORS);
const LEAF_KEYS: Record<string, ReadonlySet<string>> = {
  equals: new Set(["op", "variable", "value"]),
  not_equals: new Set(["op", "variable", "value"]),
  in: new Set(["op", "variable", "values"]),
  is_set: new Set(["op", "variable"]),
  lt: new Set(["op", "variable", "value"]),
  gt: new Set(["op", "variable", "value"]),
};

/** Structured conditions only: data, never an expression. `all` / `any` nest at most `conditionDepthMax` levels. */
function readCondition(
  raw: unknown,
  path: ConfigPath,
  depth: number,
  ctx: Ctx,
): Condition | undefined {
  const { c } = ctx;
  if (raw === undefined) {
    c.add("FIELD_REQUIRED", path);
    return undefined;
  }
  if (!isRecord(raw)) {
    c.add("FIELD_TYPE_INVALID", path, { expected: "object" });
    return undefined;
  }
  const op = raw.op;
  if (op === undefined) {
    c.add("FIELD_REQUIRED", [...path, "op"]);
    return undefined;
  }
  if (typeof op !== "string") {
    c.add("FIELD_TYPE_INVALID", [...path, "op"], { expected: "string" });
    return undefined;
  }

  if (COMBINATORS.has(op)) {
    if (depth >= L.conditionDepthMax) {
      c.add("CONDITION_TOO_DEEP", path, { max: L.conditionDepthMax });
      return undefined;
    }
    checkKeys(raw, new Set(["op", "conditions"]), path, c);
    const children = raw.conditions;
    if (children === undefined) {
      c.add("FIELD_REQUIRED", [...path, "conditions"]);
      return undefined;
    }
    if (!Array.isArray(children)) {
      c.add("FIELD_TYPE_INVALID", [...path, "conditions"], { expected: "array" });
      return undefined;
    }
    if (children.length < 1) {
      c.add("LIST_TOO_SHORT", [...path, "conditions"], { min: 1 });
      return undefined;
    }
    if (children.length > S.conditionChildrenMax) {
      c.add("LIST_TOO_LONG", [...path, "conditions"], { max: S.conditionChildrenMax });
      return undefined;
    }
    const parsed = children.map((child, i) =>
      readCondition(child, [...path, "conditions", i], depth + 1, ctx),
    );
    if (parsed.some((p) => p === undefined)) return undefined;
    return { op: op as "all" | "any", conditions: parsed as Condition[] };
  }

  if (!LEAF_OPERATORS.has(op)) {
    c.add("CONDITION_OPERATOR_UNSUPPORTED", [...path, "op"], { found: safeName(op) });
    return undefined;
  }
  checkKeys(raw, LEAF_KEYS[op]!, path, c);

  // the variable
  const rawName = raw.variable;
  if (rawName === undefined) {
    c.add("FIELD_REQUIRED", [...path, "variable"]);
    return undefined;
  }
  const name = parseWith(identifier, rawName, [...path, "variable"], ctx.root, c);
  if (name === undefined) return undefined;
  ctx.referenced.add(name);
  if (!ctx.declared.has(name)) {
    c.add("VARIABLE_UNDECLARED", [...path, "variable"], { variable: name });
    return undefined;
  }
  const decl = ctx.vars.get(name);

  switch (op) {
    case "is_set":
      return { op, variable: name };
    case "equals":
    case "not_equals": {
      const value = readLiteral(raw.value, [...path, "value"], name, decl, ctx);
      return value === undefined ? undefined : { op, variable: name, value };
    }
    case "lt":
    case "gt": {
      if (decl && decl.type !== "integer") {
        c.add("VARIABLE_TYPE_MISMATCH", [...path, "variable"], {
          variable: name,
          variableType: decl.type,
        });
        return undefined;
      }
      const value = raw.value;
      if (value === undefined) {
        c.add("FIELD_REQUIRED", [...path, "value"]);
        return undefined;
      }
      if (typeof value !== "number") {
        c.add("FIELD_TYPE_INVALID", [...path, "value"], { expected: "number" });
        return undefined;
      }
      if (!Number.isSafeInteger(value)) {
        c.add("NUMBER_NOT_INTEGER", [...path, "value"]);
        return undefined;
      }
      return { op, variable: name, value };
    }
    default: {
      // "in"
      const values = raw.values;
      if (values === undefined) {
        c.add("FIELD_REQUIRED", [...path, "values"]);
        return undefined;
      }
      if (!Array.isArray(values)) {
        c.add("FIELD_TYPE_INVALID", [...path, "values"], { expected: "array" });
        return undefined;
      }
      if (values.length < 1) {
        c.add("LIST_TOO_SHORT", [...path, "values"], { min: 1 });
        return undefined;
      }
      if (values.length > S.conditionInValuesMax) {
        c.add("LIST_TOO_LONG", [...path, "values"], { max: S.conditionInValuesMax });
        return undefined;
      }
      const parsed = values.map((v, i) => readLiteral(v, [...path, "values", i], name, decl, ctx));
      return parsed.some((p) => p === undefined)
        ? undefined
        : { op: "in", variable: name, values: parsed as Literal[] };
    }
  }
}

// ----------------------------------------------------------------------------------------- variable use (whole graph)

function checkVariableUse(ctx: Ctx): void {
  const { c } = ctx;
  let total = 0;
  for (const name of [...ctx.vars.keys()].sort()) {
    const decl = ctx.vars.get(name)!;
    total += placeholderWidth(decl);
    const read = ctx.referenced.has(name);
    const written = ctx.assigned.has(name);
    if (!read && !written) c.add("VARIABLE_UNUSED", ["variables", name], { variable: name });
    else if (read && !written)
      c.add("VARIABLE_NEVER_ASSIGNED", ["variables", name], { variable: name });
  }
  if (total > L.variablesTotalMax)
    c.add("VARIABLES_MAY_EXCEED_TOTAL", ["variables"], { max: L.variablesTotalMax });
}

// -------------------------------------------------------------------------------------------------------------- layout

function readLayout(raw: unknown, nodeIds: ReadonlySet<string>, ctx: Ctx): void {
  const object = objectAt(raw, ["layout"], ctx.c, { required: false });
  if (!object) return;
  for (const key of Object.keys(object)) {
    const path: ConfigPath = ["layout", key];
    if (!ID_PATTERN.test(key)) {
      ctx.c.add("IDENTIFIER_INVALID", path);
      continue;
    }
    parseWith(layoutSchema, object[key], path, ctx.root, ctx.c);
    if (!nodeIds.has(key)) ctx.c.add("LAYOUT_UNKNOWN_NODE", path);
  }
}

/** The layout of an input that has no errors (so every entry is valid), in input order. */
function readLayoutOutput(raw: unknown): FlowConfig["layout"] {
  if (!isRecord(raw)) return {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const key of Object.keys(raw)) {
    const entry = raw[key];
    if (isRecord(entry) && typeof entry.x === "number" && typeof entry.y === "number")
      out[key] = { x: entry.x, y: entry.y };
  }
  return out;
}
