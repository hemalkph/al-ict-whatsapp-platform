import { describe, expect, it } from "vitest";
import { canonicalFlowJson, FLOW_LIMITS, SUPPLEMENTARY_LIMITS, validateFlow } from "./index";
import type { FlowConfig } from "./index";
import { checkJsonShape } from "./canonical";
import {
  codesOf,
  reverseKeys,
  enquiryFlow,
  flowWith,
  flowWithNodeCount,
  hitsOf,
  minimalFlow,
  nodesOf,
  pathsOf,
  type Json,
  flowOfNormalizedSize,
} from "./testing";
import type { DiagnosticCode } from "./diagnostics";

// Negative fixtures: references, identifiers, strictness, node types, triggers, limits and size.

function rejects(flow: unknown, code: DiagnosticCode, path?: readonly (string | number)[]) {
  const result = validateFlow(flow);
  expect(result.ok, `expected ${code}`).toBe(false);
  expect(result.config).toBeNull();
  const hits = hitsOf(result, code);
  expect(hits.length, `expected ${code}, got ${codesOf(result).join(",")}`).toBeGreaterThan(0);
  if (path) expect(hits.map((h) => h.path)).toContainEqual(path);
  return result;
}

describe("references", () => {
  it("K. a missing destination is reported at the field that names it", () => {
    const next = minimalFlow();
    nodesOf(next).welcome!.next = "nowhere";
    const r = rejects(next, "REFERENCE_MISSING", ["nodes", "welcome", "next"]);
    expect(r.diagnostics.find((d) => d.code === "REFERENCE_MISSING")).toMatchObject({
      nodeId: "welcome",
      severity: "error",
      context: { target: "nowhere" },
    });

    const option = flowWith(
      {
        m: {
          type: "BUTTONS",
          body: "b",
          options: [{ key: "a", title: "A", next: "gone" }],
          onInvalid: "to_staff",
        },
      },
      "m",
    );
    rejects(option, "REFERENCE_MISSING", ["nodes", "m", "options", 0, "next"]);

    const invalid = flowWith(
      {
        m: {
          type: "BUTTONS",
          body: "b",
          options: [{ key: "a", title: "A", next: "done" }],
          onInvalid: "gone",
        },
      },
      "m",
    );
    rejects(invalid, "REFERENCE_MISSING", ["nodes", "m", "onInvalid"]);

    const branch = flowWith(
      {
        c: {
          type: "CONDITION",
          branches: [{ when: { op: "is_set", variable: "v" }, next: "gone" }],
          else: "gone2",
        },
      },
      "c",
    );
    branch.variables = { v: { type: "string" } };
    const r2 = rejects(branch, "REFERENCE_MISSING", ["nodes", "c", "branches", 0, "next"]);
    expect(pathsOf(r2, "REFERENCE_MISSING")).toContainEqual(["nodes", "c", "else"]);
  });

  it("L. a start node that does not exist", () => {
    const flow = minimalFlow();
    flow.startNodeId = "ghost";
    rejects(flow, "START_NODE_MISSING", ["startNodeId"]);
  });

  it("M. the error node must exist and be a HANDOVER or END node", () => {
    const missing = minimalFlow();
    missing.errorNodeId = "ghost";
    rejects(missing, "ERROR_NODE_MISSING", ["errorNodeId"]);

    const wrongType = minimalFlow();
    wrongType.errorNodeId = "welcome";
    const r = rejects(wrongType, "ERROR_NODE_NOT_TERMINAL", ["errorNodeId"]);
    expect(r.diagnostics.find((d) => d.code === "ERROR_NODE_NOT_TERMINAL")?.context).toMatchObject({
      type: "MESSAGE",
    });

    const absent = minimalFlow();
    delete absent.errorNodeId;
    rejects(absent, "FIELD_REQUIRED", ["errorNodeId"]);

    const asEnd = minimalFlow();
    asEnd.errorNodeId = "done";
    expect(validateFlow(asEnd).ok).toBe(true);
  });
});

describe("identifiers and duplicates", () => {
  it("N. duplicate option keys and titles in one node (titles compared ignoring case)", () => {
    const keys = flowWith(
      {
        m: {
          type: "BUTTONS",
          body: "b",
          options: [
            { key: "a", title: "One", next: "done" },
            { key: "a", title: "Two", next: "done" },
          ],
          onInvalid: "to_staff",
        },
      },
      "m",
    );
    rejects(keys, "OPTION_KEY_DUPLICATE", ["nodes", "m", "options", 1, "key"]);

    const titles = flowWith(
      {
        l: {
          type: "LIST",
          body: "b",
          buttonLabel: "Open",
          options: [
            { key: "a", title: "Yes", next: "done" },
            { key: "b", title: "yes", next: "done" },
          ],
          onInvalid: "to_staff",
        },
      },
      "l",
    );
    rejects(titles, "OPTION_TITLE_DUPLICATE", ["nodes", "l", "options", 1, "title"]);

    const acrossNodes = flowWith(
      {
        m1: {
          type: "BUTTONS",
          body: "b",
          options: [{ key: "a", title: "Same", next: "m2" }],
          onInvalid: "to_staff",
        },
        m2: {
          type: "BUTTONS",
          body: "b",
          options: [{ key: "a", title: "Same", next: "done" }],
          onInvalid: "to_staff",
        },
      },
      "m1",
    );
    expect(validateFlow(acrossNodes).ok).toBe(true); // unique per prompt, not per flow
  });

  it.each(["Welcome", "1abc", "a-b", "has space", "x".repeat(33), "ünï", "_x", "a.b"])(
    "O. node id %j is invalid",
    (id) => {
      const flow = minimalFlow();
      nodesOf(flow)[id] = { type: "END" };
      rejects(flow, "IDENTIFIER_INVALID", ["nodes", id]);
    },
  );

  it("O. invalid option keys, variable names, layout keys and start ids", () => {
    const option = flowWith(
      {
        m: {
          type: "BUTTONS",
          body: "b",
          options: [{ key: "Bad Key", title: "A", next: "done" }],
          onInvalid: "to_staff",
        },
      },
      "m",
    );
    rejects(option, "IDENTIFIER_INVALID", ["nodes", "m", "options", 0, "key"]);

    const variable = minimalFlow();
    variable.variables = { "Bad-Name": { type: "string" } };
    rejects(variable, "IDENTIFIER_INVALID", ["variables", "Bad-Name"]);

    const layout = minimalFlow();
    layout.layout = { "Bad-Node": { x: 0, y: 0 } };
    rejects(layout, "IDENTIFIER_INVALID", ["layout", "Bad-Node"]);

    const start = minimalFlow();
    start.startNodeId = "Welcome";
    rejects(start, "IDENTIFIER_INVALID", ["startNodeId"]);
  });

  it("O. a JSON key named __proto__ is just an invalid identifier, never a prototype assignment", () => {
    const flow = JSON.parse(
      '{"schemaVersion":1,"name":"x","startNodeId":"a","errorNodeId":"a","triggers":[],"nodes":{"__proto__":{"type":"END"},"a":{"type":"END"}}}',
    ) as Json;
    rejects(flow, "IDENTIFIER_INVALID", ["nodes", "__proto__"]);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
  });
});

describe("node types and strict fields", () => {
  it.each([
    "ACTION",
    "SUBFLOW",
    "WHATSAPP_FLOW",
    "ADD_TAG",
    "REMOVE_TAG",
    "ASSIGN_TEAM",
    "START",
    "message",
    "FOO",
  ])("P. node type %j is not supported", (type) => {
    const flow = flowWith({ x: { type } });
    rejects(flow, "NODE_TYPE_UNSUPPORTED", ["nodes", "x", "type"]);
  });

  it("P. a missing or non-string node type", () => {
    rejects(flowWith({ x: { text: "hi" } }), "FIELD_REQUIRED", ["nodes", "x", "type"]);
    rejects(flowWith({ x: { type: 42 } }), "FIELD_TYPE_INVALID", ["nodes", "x", "type"]);
    rejects(flowWith({ x: "MESSAGE" as unknown as Json }), "FIELD_TYPE_INVALID", ["nodes", "x"]);
  });

  it("Q. unknown fields are rejected at every level", () => {
    const root = minimalFlow();
    root.extra = 1;
    rejects(root, "FIELD_UNKNOWN", ["extra"]);

    const node = minimalFlow();
    nodesOf(node).welcome!.color = "red";
    rejects(node, "FIELD_UNKNOWN", ["nodes", "welcome", "color"]);

    const option = flowWith(
      {
        m: {
          type: "BUTTONS",
          body: "b",
          options: [{ key: "a", title: "A", next: "done", icon: "x" }],
          onInvalid: "to_staff",
        },
      },
      "m",
    );
    rejects(option, "FIELD_UNKNOWN", ["nodes", "m", "options", 0, "icon"]);

    const trigger = minimalFlow();
    trigger.triggers = [{ kind: "first_message", words: ["hi"] }];
    rejects(trigger, "FIELD_UNKNOWN", ["triggers", 0, "words"]);

    const settings = minimalFlow();
    settings.settings = { idleTimeoutMinutes: 30, retries: 3 };
    rejects(settings, "FIELD_UNKNOWN", ["settings", "retries"]);

    const decl = minimalFlow();
    decl.variables = { v: { type: "string", default: "x" } };
    rejects(decl, "FIELD_UNKNOWN", ["variables", "v", "default"]);

    const answer = flowWith(
      {
        q: {
          type: "QUESTION",
          text: "q",
          variable: "v",
          answer: { kind: "text", max: 5, regex: "." },
          next: "done",
          onInvalid: "to_staff",
        },
      },
      "q",
    );
    answer.variables = { v: { type: "string" } };
    rejects(answer, "FIELD_UNKNOWN", ["nodes", "q", "answer", "regex"]);

    const layout = minimalFlow();
    layout.layout = { welcome: { x: 1, y: 2, z: 3 } };
    rejects(layout, "FIELD_UNKNOWN", ["layout", "welcome", "z"]);

    const condition = flowWith(
      {
        c: {
          type: "CONDITION",
          branches: [{ when: { op: "is_set", variable: "v", value: 1 }, next: "done" }],
          else: "done",
        },
      },
      "c",
    );
    condition.variables = { v: { type: "string" } };
    rejects(condition, "FIELD_UNKNOWN", ["nodes", "c", "branches", 0, "when", "value"]);
  });

  it("Q. HANDOVER and END cannot have an outgoing transition", () => {
    for (const type of ["HANDOVER", "END"] as const) {
      const flow = minimalFlow();
      nodesOf(flow).t = {
        type,
        ...(type === "HANDOVER" ? { reason: "other" } : {}),
        next: "done",
        onInvalid: "done",
      };
      const r = rejects(flow, "TERMINAL_NODE_HAS_TRANSITION", ["nodes", "t", "next"]);
      expect(pathsOf(r, "TERMINAL_NODE_HAS_TRANSITION")).toContainEqual([
        "nodes",
        "t",
        "onInvalid",
      ]);
      expect(codesOf(r)).not.toContain("FIELD_UNKNOWN"); // one clear diagnostic, not two
    }
  });

  it("a HANDOVER reason must be on the allowed list and is required", () => {
    rejects(
      flowWith({ h: { type: "HANDOVER", reason: "bot_error" } }),
      "HANDOVER_REASON_UNSUPPORTED",
      ["nodes", "h", "reason"],
    );
    rejects(
      flowWith({ h: { type: "HANDOVER", reason: "staff_assigned" } }),
      "HANDOVER_REASON_UNSUPPORTED",
    );
    rejects(flowWith({ h: { type: "HANDOVER" } }), "FIELD_REQUIRED", ["nodes", "h", "reason"]);
  });

  it("required fields and wrong types are reported at their path", () => {
    const flow = minimalFlow();
    delete flow.name;
    delete flow.nodes;
    rejects(flow, "FIELD_REQUIRED", ["name"]);
    rejects(flow, "FIELD_REQUIRED", ["nodes"]);
    rejects({ ...minimalFlow(), triggers: "first_message" }, "FIELD_TYPE_INVALID", ["triggers"]);
    rejects({ ...minimalFlow(), nodes: [] }, "FIELD_TYPE_INVALID", ["nodes"]);
    rejects({ ...minimalFlow(), settings: [] }, "FIELD_TYPE_INVALID", ["settings"]);
    rejects(flowWith({ m: { type: "MESSAGE", text: 5, next: "done" } }), "FIELD_TYPE_INVALID", [
      "nodes",
      "m",
      "text",
    ]);
  });

  it("rejects the document when it is not an object or its schema version is unknown", () => {
    for (const bad of [null, [], "flow", 7, true]) {
      const r = validateFlow(bad);
      expect(r.ok).toBe(false);
      expect(codesOf(r)).toContain(
        bad === null || typeof bad !== "object" || Array.isArray(bad) ? codesOf(r)[0]! : "x",
      );
    }
    rejects({ ...minimalFlow(), schemaVersion: 2 }, "SCHEMA_VERSION_UNSUPPORTED", [
      "schemaVersion",
    ]);
    rejects({ ...minimalFlow(), schemaVersion: "1" }, "FIELD_TYPE_INVALID", ["schemaVersion"]);
    const missing = minimalFlow();
    delete missing.schemaVersion;
    rejects(missing, "FIELD_REQUIRED", ["schemaVersion"]);
  });

  it("settings are bounded", () => {
    rejects({ ...minimalFlow(), settings: { idleTimeoutMinutes: 0 } }, "NUMBER_TOO_SMALL", [
      "settings",
      "idleTimeoutMinutes",
    ]);
    rejects({ ...minimalFlow(), settings: { idleTimeoutMinutes: 1441 } }, "NUMBER_TOO_LARGE", [
      "settings",
      "idleTimeoutMinutes",
    ]);
    rejects({ ...minimalFlow(), settings: { maxInvalidAttempts: 6 } }, "NUMBER_TOO_LARGE", [
      "settings",
      "maxInvalidAttempts",
    ]);
    rejects({ ...minimalFlow(), settings: { maxInvalidAttempts: 1.5 } }, "NUMBER_NOT_INTEGER", [
      "settings",
      "maxInvalidAttempts",
    ]);
    expect(
      validateFlow({ ...minimalFlow(), settings: { maxInvalidAttempts: 5 } }).config?.settings,
    ).toEqual({ idleTimeoutMinutes: 30, maxInvalidAttempts: 5 });
  });

  it("layout coordinates must be finite numbers in range; an entry for a missing node only warns", () => {
    rejects({ ...minimalFlow(), layout: { welcome: { x: 2_000_000, y: 0 } } }, "NUMBER_TOO_LARGE", [
      "layout",
      "welcome",
      "x",
    ]);
    rejects({ ...minimalFlow(), layout: { welcome: { x: "1", y: 0 } } }, "FIELD_TYPE_INVALID", [
      "layout",
      "welcome",
      "x",
    ]);
    const orphan = validateFlow({ ...minimalFlow(), layout: { ghost: { x: 0, y: 0 } } });
    expect(orphan.ok).toBe(true);
    expect(hitsOf(orphan, "LAYOUT_UNKNOWN_NODE")).toHaveLength(1);
  });
});

describe("triggers", () => {
  it.each(["regex", "fuzzy", "contains", "any", "referral", "KEYWORD", ""])(
    "AE. trigger kind %j is not supported",
    (kind) => {
      rejects({ ...minimalFlow(), triggers: [{ kind }] }, "TRIGGER_KIND_UNSUPPORTED", [
        "triggers",
        0,
        "kind",
      ]);
    },
  );

  it("AE. a trigger without a kind, with a non-string kind, or that is not an object", () => {
    rejects({ ...minimalFlow(), triggers: [{}] }, "FIELD_REQUIRED", ["triggers", 0, "kind"]);
    rejects({ ...minimalFlow(), triggers: [{ kind: 5 }] }, "FIELD_TYPE_INVALID", [
      "triggers",
      0,
      "kind",
    ]);
    rejects({ ...minimalFlow(), triggers: ["keyword"] }, "FIELD_TYPE_INVALID", ["triggers", 0]);
  });

  it("supports exactly keyword, first_message and referral_source", () => {
    const flow = {
      ...minimalFlow(),
      triggers: [
        { kind: "keyword", words: ["hi"] },
        { kind: "first_message" },
        { kind: "referral_source" },
      ],
    };
    expect(validateFlow(flow).ok).toBe(true);
  });

  it("keyword triggers need 1-50 trimmed words of at most 40 characters, without duplicates", () => {
    rejects({ ...minimalFlow(), triggers: [{ kind: "keyword", words: [] }] }, "LIST_TOO_SHORT", [
      "triggers",
      0,
      "words",
    ]);
    rejects({ ...minimalFlow(), triggers: [{ kind: "keyword" }] }, "FIELD_REQUIRED", [
      "triggers",
      0,
      "words",
    ]);
    rejects(
      { ...minimalFlow(), triggers: [{ kind: "keyword", words: ["x".repeat(41)] }] },
      "TEXT_TOO_LONG",
      ["triggers", 0, "words", 0],
    );
    rejects(
      { ...minimalFlow(), triggers: [{ kind: "keyword", words: [" hi"] }] },
      "TEXT_UNTRIMMED",
      ["triggers", 0, "words", 0],
    );
    rejects({ ...minimalFlow(), triggers: [{ kind: "keyword", words: ["   "] }] }, "TEXT_BLANK", [
      "triggers",
      0,
      "words",
      0,
    ]);
    rejects(
      { ...minimalFlow(), triggers: [{ kind: "keyword", words: ["Hi", "hi"] }] },
      "KEYWORD_DUPLICATE",
      ["triggers", 0, "words", 1],
    );
    const many = Array.from({ length: 51 }, (_, i) => `w${i}`);
    rejects({ ...minimalFlow(), triggers: [{ kind: "keyword", words: many }] }, "LIST_TOO_LONG", [
      "triggers",
      0,
      "words",
    ]);
  });

  it("a repeated first_message or referral_source trigger is refused; no triggers only warns", () => {
    rejects(
      { ...minimalFlow(), triggers: [{ kind: "first_message" }, { kind: "first_message" }] },
      "TRIGGER_DUPLICATE",
      ["triggers", 1],
    );
    rejects(
      { ...minimalFlow(), triggers: [{ kind: "referral_source" }, { kind: "referral_source" }] },
      "TRIGGER_DUPLICATE",
    );
    const none = validateFlow({ ...minimalFlow(), triggers: [] });
    expect(none.ok).toBe(true);
    expect(codesOf(none)).toContain("TRIGGERS_EMPTY");
    rejects(
      {
        ...minimalFlow(),
        triggers: Array.from({ length: 11 }, () => ({ kind: "keyword", words: ["a"] })),
      },
      "LIST_TOO_LONG",
      ["triggers"],
    );
  });
});

describe("limits", () => {
  it("U. the size limit is measured on the canonical form in UTF-8 bytes, not in characters", () => {
    const build = (nodes: number, text: string) => {
      const flow = flowWithNodeCount(nodes + 3);
      for (let i = 0; i < nodes; i++) nodesOf(flow)[`f${i}`]!.text = text;
      return flow;
    };
    // 1,000 Sinhala letters are 3,000 bytes: 25 such nodes are 25,000 characters but about 75 KB.
    const sinhala = "අ".repeat(1000);
    const over = rejects(build(25, sinhala), "CONFIG_TOO_LARGE", []);
    expect(over.diagnostics).toHaveLength(1);
    expect(hitsOf(over, "CONFIG_TOO_LARGE")[0]!.context).toEqual({
      max: FLOW_LIMITS.configBytesMax,
    });
    expect(validateFlow(build(20, sinhala)).ok).toBe(true); // about 61 KB
    // the same number of ASCII characters would have fit
    expect(validateFlow(build(25, "a".repeat(1000))).ok).toBe(true);
    // a huge string is refused cheaply
    rejects(build(1, "a".repeat(200_000)), "CONFIG_TOO_LARGE", []);
  });

  describe("the size limit applies to the normalized configuration (review correction)", () => {
    const LIMIT = FLOW_LIMITS.configBytesMax;
    const bytes = (value: unknown) =>
      new TextEncoder().encode(canonicalFlowJson(value as FlowConfig)).byteLength;
    const small = flowWithNodeCount(70 + 3); // the base flow flowOfNormalizedSize pads

    it("A. an input that fits but outgrows the limit once defaults are added is refused", () => {
      const flow = flowOfNormalizedSize(LIMIT + 1);
      expect(bytes(flow)).toBeLessThan(LIMIT); // the early guard alone would pass it
      const result = rejects(flow, "CONFIG_TOO_LARGE", []);
      expect(result.config).toBeNull();
      expect(hitsOf(result, "CONFIG_TOO_LARGE")[0]!.context).toEqual({ max: LIMIT });
    });

    it("B/C. exactly at the limit is accepted; one byte over is refused", () => {
      const atLimit = validateFlow(flowOfNormalizedSize(LIMIT));
      expect(atLimit.ok).toBe(true);
      expect(bytes(atLimit.config)).toBe(LIMIT);
      rejects(flowOfNormalizedSize(LIMIT + 1), "CONFIG_TOO_LARGE", []);
    });

    it("D/E/F. every returned configuration validates again, unchanged", () => {
      const flows = [minimalFlow(), enquiryFlow(), flowOfNormalizedSize(LIMIT), small];
      for (const flow of flows) {
        const first = validateFlow(flow);
        expect(first.ok).toBe(true);
        const second = validateFlow(first.config);
        expect(second.ok).toBe(true);
        expect(canonicalFlowJson(second.config!)).toBe(canonicalFlowJson(first.config!));
        expect(validateFlow(second.config).config).toEqual(second.config);
      }
    });

    it("G. the key order of the input does not change the outcome", () => {
      expect(validateFlow(reverseKeys(flowOfNormalizedSize(LIMIT))).ok).toBe(true);
      rejects(reverseKeys(flowOfNormalizedSize(LIMIT + 1)), "CONFIG_TOO_LARGE", []);
    });

    it("H. the limit counts UTF-8 bytes: a Sinhala letter is 3 bytes", () => {
      const swap = (flow: Json, ascii: number) => {
        const node = nodesOf(flow).f0!;
        node.text = (node.text as string).slice(0, -ascii) + "අ";
        return flow;
      };
      // three ASCII bytes replaced by one 3-byte letter: same size, still accepted
      expect(validateFlow(swap(flowOfNormalizedSize(LIMIT), 3)).ok).toBe(true);
      // two ASCII bytes replaced by one 3-byte letter: one byte over, though one character shorter
      rejects(swap(flowOfNormalizedSize(LIMIT), 2), "CONFIG_TOO_LARGE", []);
    });
  });

  it("V. exactly 200 nodes are accepted and 201 are not", () => {
    expect(validateFlow(flowWithNodeCount(FLOW_LIMITS.nodesMax)).ok).toBe(true);
    rejects(flowWithNodeCount(FLOW_LIMITS.nodesMax + 1), "NODE_COUNT_EXCEEDED", ["nodes"]);
    rejects({ ...minimalFlow(), nodes: {} }, "LIST_TOO_SHORT", ["nodes"]);
  });

  it("V. exactly 50 variables are accepted and 51 are not", () => {
    const declare = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`v${i}`, { type: "boolean" }]));
    const fifty = validateFlow({ ...minimalFlow(), variables: declare(50) });
    expect(fifty.ok).toBe(true);
    expect(codesOf(fifty).filter((c) => c === "VARIABLE_UNUSED")).toHaveLength(50);
    rejects({ ...minimalFlow(), variables: declare(51) }, "VARIABLE_COUNT_EXCEEDED", ["variables"]);
  });

  it("V. a variable's length bounds: 1-500, strings only", () => {
    rejects(
      { ...minimalFlow(), variables: { v: { type: "string", maxLength: 501 } } },
      "NUMBER_TOO_LARGE",
      ["variables", "v", "maxLength"],
    );
    rejects(
      { ...minimalFlow(), variables: { v: { type: "string", maxLength: 0 } } },
      "NUMBER_TOO_SMALL",
      ["variables", "v", "maxLength"],
    );
    rejects(
      { ...minimalFlow(), variables: { v: { type: "integer", maxLength: 5 } } },
      "VARIABLE_MAXLENGTH_NOT_ALLOWED",
      ["variables", "v", "maxLength"],
    );
    rejects({ ...minimalFlow(), variables: { v: { type: "date" } } }, "VALUE_NOT_ALLOWED", [
      "variables",
      "v",
      "type",
    ]);
    expect(
      validateFlow({ ...minimalFlow(), variables: { v: { type: "string" } } }).config?.variables,
    ).toEqual({
      v: { type: "string", sensitive: false, maxLength: 500 },
    });
  });

  it("V. declarations that could together exceed the 4 KiB value budget only warn", () => {
    const variables = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`v${i}`, { type: "string", maxLength: 500 }]),
    );
    const result = validateFlow({ ...minimalFlow(), variables });
    expect(result.ok).toBe(true);
    expect(codesOf(result)).toContain("VARIABLES_MAY_EXCEED_TOTAL");
  });

  const buttons = (options: number, title = "T") => ({
    type: "BUTTONS",
    body: "b",
    options: Array.from({ length: options }, (_, i) => ({
      key: `k${i}`,
      title: `${title}${i}`,
      next: "done",
    })),
    onInvalid: "to_staff",
  });

  it("W. a BUTTONS menu has 1-3 options", () => {
    rejects(flowWith({ m: buttons(4) }, "m"), "LIST_TOO_LONG", ["nodes", "m", "options"]);
    rejects(flowWith({ m: buttons(0) }, "m"), "LIST_TOO_SHORT", ["nodes", "m", "options"]);
  });

  it("W. a LIST menu has 1-10 rows", () => {
    const list = (n: number) => ({
      type: "LIST",
      body: "b",
      buttonLabel: "Open",
      onInvalid: "to_staff",
      options: Array.from({ length: n }, (_, i) => ({
        key: `k${i}`,
        title: `Row ${i}`,
        next: "done",
      })),
    });
    rejects(flowWith({ l: list(11) }, "l"), "LIST_TOO_LONG", ["nodes", "l", "options"]);
    rejects(flowWith({ l: list(0) }, "l"), "LIST_TOO_SHORT", ["nodes", "l", "options"]);
    expect(validateFlow(flowWith({ l: list(10) }, "l")).ok).toBe(true);
  });

  it("W. text limits: titles 20/24, descriptions 72, buttonLabel 20, footer 60, bodies 1024, name 80", () => {
    const at = (max: number) => "x".repeat(max);
    const fits = (node: Json) => validateFlow(flowWith({ n: node }, "n")).ok;

    const button = (title: string) => ({
      type: "BUTTONS",
      body: "b",
      options: [{ key: "a", title, next: "done" }],
      onInvalid: "to_staff",
    });
    expect(fits(button(at(20)))).toBe(true);
    rejects(flowWith({ n: button(at(21)) }, "n"), "TEXT_TOO_LONG", [
      "nodes",
      "n",
      "options",
      0,
      "title",
    ]);

    const row = (o: Json) => ({
      type: "LIST",
      body: "b",
      buttonLabel: "Open",
      options: [{ key: "a", title: "Row", next: "done", ...o }],
      onInvalid: "to_staff",
    });
    expect(fits(row({ title: at(24) }))).toBe(true);
    rejects(flowWith({ n: row({ title: at(25) }) }, "n"), "TEXT_TOO_LONG", [
      "nodes",
      "n",
      "options",
      0,
      "title",
    ]);
    expect(fits(row({ description: at(72) }))).toBe(true);
    rejects(flowWith({ n: row({ description: at(73) }) }, "n"), "TEXT_TOO_LONG", [
      "nodes",
      "n",
      "options",
      0,
      "description",
    ]);
    rejects(flowWith({ n: { ...row({}), buttonLabel: at(21) } }, "n"), "TEXT_TOO_LONG", [
      "nodes",
      "n",
      "buttonLabel",
    ]);
    rejects(flowWith({ n: { ...row({}), footer: at(61) } }, "n"), "TEXT_TOO_LONG", [
      "nodes",
      "n",
      "footer",
    ]);
    expect(fits({ ...row({}), footer: at(60) })).toBe(true);

    expect(fits({ type: "MESSAGE", text: at(1024), next: "done" })).toBe(true);
    rejects(
      flowWith({ n: { type: "MESSAGE", text: at(1025), next: "done" } }, "n"),
      "TEXT_TOO_LONG",
      ["nodes", "n", "text"],
    );
    rejects(flowWith({ n: { type: "END", message: at(1025) } }, "n"), "TEXT_TOO_LONG", [
      "nodes",
      "n",
      "message",
    ]);
    rejects(flowWith({ n: { type: "MESSAGE", text: "", next: "done" } }, "n"), "TEXT_TOO_SHORT", [
      "nodes",
      "n",
      "text",
    ]);

    rejects({ ...minimalFlow(), name: at(81) }, "TEXT_TOO_LONG", ["name"]);
    rejects({ ...minimalFlow(), name: "" }, "TEXT_TOO_SHORT", ["name"]);
    expect(validateFlow({ ...minimalFlow(), name: at(80) }).ok).toBe(true);
  });

  it("W. lengths count UTF-16 code units: 512 emoji fit a 1024 body, 513 do not", () => {
    const body = (n: number) => ({ type: "MESSAGE", text: "😀".repeat(n), next: "done" });
    expect(validateFlow(flowWith({ n: body(512) }, "n")).ok).toBe(true);
    rejects(flowWith({ n: body(513) }, "n"), "TEXT_TOO_LONG", ["nodes", "n", "text"]);
  });

  it("the diagnostic list itself is bounded", () => {
    const flow = flowWithNodeCount(150);
    for (const node of Object.values(nodesOf(flow))) Object.assign(node, { a: 1, b: 2, c: 3 });
    const result = validateFlow(flow);
    expect(result.diagnostics.length).toBe(SUPPLEMENTARY_LIMITS.diagnosticsMax);
    expect(result.diagnostics[0]!.code).toBe("TOO_MANY_DIAGNOSTICS");
    expect(result.errorCount).toBe(SUPPLEMENTARY_LIMITS.diagnosticsMax);
  });

  it("the enquiry flow stays far below the published limits", () => {
    const result = validateFlow(enquiryFlow());
    expect(result.ok).toBe(true);
    expect(Object.keys(result.config!.nodes).length).toBeLessThan(FLOW_LIMITS.nodesMax);
  });
});

describe("plain JSON only", () => {
  const withSecond = (value: unknown) => ({ ...minimalFlow(), name: value });
  it.each([
    ["undefined", () => ({ ...minimalFlow(), extra: undefined })],
    ["NaN", () => ({ ...minimalFlow(), settings: { idleTimeoutMinutes: Number.NaN } })],
    ["Infinity", () => withSecond(Number.POSITIVE_INFINITY)],
    ["a function", () => withSecond(() => 1)],
    ["a Date", () => withSecond(new Date(0))],
    ["a Map", () => withSecond(new Map())],
    ["a bigint", () => withSecond(BigInt(1))],
    ["a symbol", () => withSecond(Symbol("x"))],
    ["a class instance", () => withSecond(new (class Foo {})())],
    ["a sparse array", () => ({ ...minimalFlow(), triggers: new Array(2) })],
  ])("CONFIG_NOT_JSON for %s", (_name, make) => {
    const result = validateFlow(make());
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "CONFIG_NOT_JSON", path: [] }),
    ]);
  });

  it("a cyclic or absurdly deep structure is refused without recursing", () => {
    const cyclic: Json = minimalFlow();
    cyclic.self = cyclic;
    expect(codesOf(validateFlow(cyclic))).toEqual(["CONFIG_TOO_DEEP"]);

    let deep: unknown = "leaf";
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(codesOf(validateFlow({ ...minimalFlow(), name: deep }))).toEqual(["CONFIG_TOO_DEEP"]);
  });
});

describe("the pre-scan work budget (review correction)", () => {
  const BUDGET = SUPPLEMENTARY_LIMITS.jsonValuesMax;
  const isIndex = (key: string | symbol) => typeof key === "string" && /^\d+$/.test(key);

  /** An array that counts how many of its elements are read (`get`) or probed (`in`). */
  function counted(target: unknown[]) {
    const counts = { gets: 0, probes: 0 };
    const array = new Proxy(target, {
      get(t, key, receiver) {
        if (isIndex(key)) counts.gets++;
        return Reflect.get(t, key, receiver) as unknown;
      },
      has(t, key) {
        if (isIndex(key)) counts.probes++;
        return Reflect.has(t, key);
      },
    });
    return { array, counts };
  }
  const zeros = (n: number) => new Array<number>(n).fill(0);

  it("A. a dense array of 250,000 elements is refused without reading one element", () => {
    const { array, counts } = counted(zeros(250_000));
    expect(checkJsonShape(array)).toBe("CONFIG_TOO_LARGE");
    expect(counts).toEqual({ gets: 0, probes: 0 });
    expect(codesOf(validateFlow({ ...minimalFlow(), triggers: array }))).toEqual([
      "CONFIG_TOO_LARGE",
    ]);
  });

  it("B. a sparse array with a huge length is refused without probing its holes", () => {
    const { array, counts } = counted(new Array(10_000_000));
    expect(checkJsonShape(array)).toBe("CONFIG_TOO_LARGE");
    expect(counts).toEqual({ gets: 0, probes: 0 });
  });

  it("B. even the largest possible array length is refused at once", () => {
    expect(checkJsonShape(new Array(2 ** 32 - 1))).toBe("CONFIG_TOO_LARGE");
  });

  it("C/D. nested and sibling arrays share one budget: total element reads never exceed it", () => {
    const a = counted(zeros(60_000));
    const b = counted(zeros(60_000));
    expect(checkJsonShape([a.array, b.array])).toBe("CONFIG_TOO_LARGE");
    expect(a.counts.gets + b.counts.gets).toBeLessThanOrEqual(BUDGET);

    const c = counted(zeros(60_000));
    const d = counted(zeros(60_000));
    expect(checkJsonShape({ first: c.array, second: d.array })).toBe("CONFIG_TOO_LARGE");
    expect(c.counts.gets + d.counts.gets).toBeLessThanOrEqual(BUDGET);
  });

  it("E/F. exactly the budget is accepted; one value more is refused", () => {
    // the root counts as one value
    expect(checkJsonShape(zeros(BUDGET - 1))).toBe("ok");
    expect(checkJsonShape(zeros(BUDGET))).toBe("CONFIG_TOO_LARGE");
    // two nested arrays: root + 2 arrays + their elements
    expect(checkJsonShape([zeros(49_998), zeros(49_999)])).toBe("ok");
    expect(checkJsonShape([zeros(49_998), zeros(50_000)])).toBe("CONFIG_TOO_LARGE");
    expect(checkJsonShape({ a: zeros(49_998), b: zeros(49_999) })).toBe("ok");
    expect(checkJsonShape({ a: zeros(49_998), b: zeros(50_000) })).toBe("CONFIG_TOO_LARGE");
  });

  it("G. legitimate nesting within the depth limit is accepted", () => {
    const nest = (levels: number) => {
      let value: unknown = 0;
      for (let i = 0; i < levels; i++) value = i % 2 === 0 ? [value] : { k: value };
      return value;
    };
    expect(checkJsonShape(nest(SUPPLEMENTARY_LIMITS.jsonDepthMax))).toBe("ok");
    expect(checkJsonShape(nest(SUPPLEMENTARY_LIMITS.jsonDepthMax + 1))).toBe("CONFIG_TOO_DEEP");
    expect(validateFlow(enquiryFlow()).ok).toBe(true);
  });

  it("H. circular and wide self-referencing input fails safely within the budget", () => {
    const loop: unknown[] = [];
    loop.push(loop);
    expect(checkJsonShape(loop)).toBe("CONFIG_TOO_DEEP");
    const wide: unknown[] = [];
    const { array, counts } = counted(wide);
    for (let i = 0; i < 10; i++) wide.push(array); // every level is read through the counting proxy
    expect(checkJsonShape(array)).toBe("CONFIG_TOO_LARGE");
    expect(counts.gets).toBeLessThanOrEqual(BUDGET);
    const result = validateFlow({ ...minimalFlow(), name: array });
    expect(result).toMatchObject({ ok: false, config: null });
  });
});
