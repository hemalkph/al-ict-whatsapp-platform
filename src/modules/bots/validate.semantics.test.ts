import { describe, expect, it } from "vitest";
import { getNode, validateFlow } from "./index";
import type { DiagnosticCode } from "./diagnostics";
import { codesOf, flowWith, hitsOf, minimalFlow, nodesOf, pathsOf, type Json } from "./testing";

// Meaning of nodes: declared variables, type compatibility, interpolation, conditions and answers.

function rejects(flow: unknown, code: DiagnosticCode, path?: readonly (string | number)[]) {
  const result = validateFlow(flow);
  expect(result.ok, `expected ${code}`).toBe(false);
  const hits = hitsOf(result, code);
  expect(hits.length, `expected ${code}, got ${codesOf(result).join(",")}`).toBeGreaterThan(0);
  if (path) expect(hits.map((h) => h.path)).toContainEqual(path);
  return result;
}

const withVars = (flow: Json, variables: Json): Json => ({ ...flow, variables });
const condition = (when: unknown, variables: Json): Json =>
  withVars(
    flowWith(
      { c: { type: "CONDITION", branches: [{ when, next: "done" }], else: "to_staff" } },
      "c",
    ),
    variables,
  );
const question = (variable: string, answer: Json, variables: Json): Json =>
  withVars(
    flowWith(
      { q: { type: "QUESTION", text: "q", variable, answer, next: "done", onInvalid: "to_staff" } },
      "q",
    ),
    variables,
  );
const setVar = (variable: string, value: unknown, variables: Json): Json =>
  withVars(
    flowWith({ s: { type: "SET_VARIABLE", variable, value, next: "done" } }, "s"),
    variables,
  );
const message = (text: string, variables: Json = {}): Json =>
  withVars(flowWith({ m: { type: "MESSAGE", text, next: "done" } }, "m"), variables);

describe("R. undeclared variables", () => {
  it("in QUESTION, SET_VARIABLE, conditions and placeholders", () => {
    rejects(question("ghost", { kind: "text", max: 5 }, {}), "VARIABLE_UNDECLARED", [
      "nodes",
      "q",
      "variable",
    ]);
    rejects(setVar("ghost", "x", {}), "VARIABLE_UNDECLARED", ["nodes", "s", "variable"]);
    rejects(condition({ op: "is_set", variable: "ghost" }, {}), "VARIABLE_UNDECLARED", [
      "nodes",
      "c",
      "branches",
      0,
      "when",
      "variable",
    ]);
    rejects(message("Hello {{ghost}}"), "INTERPOLATION_UNDECLARED", ["nodes", "m", "text"]);
  });

  it("a declared variable that nothing uses, or reads but never assigns, only warns", () => {
    const unused = validateFlow(withVars(minimalFlow(), { spare: { type: "string" } }));
    expect(unused.ok).toBe(true);
    expect(hitsOf(unused, "VARIABLE_UNUSED")[0]).toMatchObject({
      severity: "warning",
      path: ["variables", "spare"],
    });

    const neverSet = validateFlow(message("Hi {{v}}", { v: { type: "string" } }));
    expect(neverSet.ok).toBe(true);
    expect(codesOf(neverSet)).toContain("VARIABLE_NEVER_ASSIGNED");

    const set = validateFlow(
      withVars(
        flowWith(
          {
            s: { type: "SET_VARIABLE", variable: "v", value: "x", next: "m" },
            m: { type: "MESSAGE", text: "Hi {{v}}", next: "done" },
          },
          "s",
        ),
        { v: { type: "string" } },
      ),
    );
    expect(set.ok).toBe(true);
    expect(set.diagnostics.filter((d) => d.code.startsWith("VARIABLE_"))).toEqual([]);
  });
});

describe("S. type-incompatible comparisons and values", () => {
  const vars = {
    age: { type: "integer" },
    label: { type: "string", maxLength: 5 },
    flag: { type: "boolean" },
  };

  it("lt / gt need an integer variable and an integer", () => {
    rejects(condition({ op: "lt", variable: "label", value: 3 }, vars), "VARIABLE_TYPE_MISMATCH", [
      "nodes",
      "c",
      "branches",
      0,
      "when",
      "variable",
    ]);
    rejects(condition({ op: "gt", variable: "flag", value: 3 }, vars), "VARIABLE_TYPE_MISMATCH");
    rejects(condition({ op: "lt", variable: "age", value: "3" }, vars), "FIELD_TYPE_INVALID", [
      "nodes",
      "c",
      "branches",
      0,
      "when",
      "value",
    ]);
    rejects(condition({ op: "gt", variable: "age", value: 1.5 }, vars), "NUMBER_NOT_INTEGER");
    rejects(condition({ op: "lt", variable: "age" }, vars), "FIELD_REQUIRED", [
      "nodes",
      "c",
      "branches",
      0,
      "when",
      "value",
    ]);
  });

  it("equals / not_equals / in compare like with like", () => {
    rejects(
      condition({ op: "equals", variable: "age", value: "ten" }, vars),
      "VARIABLE_TYPE_MISMATCH",
      ["nodes", "c", "branches", 0, "when", "value"],
    );
    rejects(
      condition({ op: "not_equals", variable: "label", value: 5 }, vars),
      "VARIABLE_TYPE_MISMATCH",
    );
    rejects(
      condition({ op: "equals", variable: "flag", value: "true" }, vars),
      "VARIABLE_TYPE_MISMATCH",
    );
    rejects(
      condition({ op: "in", variable: "age", values: [1, "2"] }, vars),
      "VARIABLE_TYPE_MISMATCH",
      ["nodes", "c", "branches", 0, "when", "values", 1],
    );
    rejects(condition({ op: "equals", variable: "age", value: null }, vars), "FIELD_TYPE_INVALID");
    rejects(condition({ op: "equals", variable: "age", value: {} }, vars), "FIELD_TYPE_INVALID");
    rejects(condition({ op: "in", variable: "age", values: [] }, vars), "LIST_TOO_SHORT");
    rejects(
      condition(
        { op: "in", variable: "age", values: Array.from({ length: 51 }, (_, i) => i) },
        vars,
      ),
      "LIST_TOO_LONG",
    );
    rejects(condition({ op: "in", variable: "age", values: "1,2" }, vars), "FIELD_TYPE_INVALID");
  });

  it("a QUESTION answer kind must match the variable type", () => {
    rejects(question("age", { kind: "text", max: 3 }, vars), "VARIABLE_TYPE_MISMATCH", [
      "nodes",
      "q",
      "answer",
      "kind",
    ]);
    rejects(question("label", { kind: "integer" }, vars), "VARIABLE_TYPE_MISMATCH");
    rejects(question("label", { kind: "yes_no" }, vars), "VARIABLE_TYPE_MISMATCH");
    rejects(question("flag", { kind: "integer" }, vars), "VARIABLE_TYPE_MISMATCH");
    expect(validateFlow(question("flag", { kind: "yes_no" }, vars)).ok).toBe(true);
  });

  it("QUESTION answer constraints: required max for text, ranges, no fields on yes/no", () => {
    rejects(question("label", { kind: "text" }, vars), "FIELD_REQUIRED", [
      "nodes",
      "q",
      "answer",
      "max",
    ]);
    rejects(question("label", { kind: "text", max: 6 }, vars), "ANSWER_EXCEEDS_VARIABLE", [
      "nodes",
      "q",
      "answer",
      "max",
    ]);
    expect(validateFlow(question("label", { kind: "text", min: 1, max: 5 }, vars)).ok).toBe(true);
    rejects(question("label", { kind: "text", min: 0, max: 5 }, vars), "NUMBER_TOO_SMALL", [
      "nodes",
      "q",
      "answer",
      "min",
    ]);
    rejects(question("label", { kind: "text", min: 4, max: 3 }, vars), "ANSWER_RANGE_INVALID");
    rejects(question("age", { kind: "integer", min: 10, max: 5 }, vars), "ANSWER_RANGE_INVALID");
    rejects(question("age", { kind: "integer", min: 1.5 }, vars), "NUMBER_NOT_INTEGER", [
      "nodes",
      "q",
      "answer",
      "min",
    ]);
    rejects(question("flag", { kind: "yes_no", min: 1 }, vars), "ANSWER_FIELD_NOT_ALLOWED", [
      "nodes",
      "q",
      "answer",
      "min",
    ]);
    rejects(question("age", { kind: "email" }, vars), "VALUE_NOT_ALLOWED", [
      "nodes",
      "q",
      "answer",
      "kind",
    ]);
    rejects(question("age", {}, vars), "FIELD_REQUIRED", ["nodes", "q", "answer", "kind"]);
  });

  describe("text answer ranges (review correction)", () => {
    const rangeVars = { name: { type: "string", maxLength: 50 }, age: { type: "integer" } };
    const textAnswer = (answer: Json) => question("name", { kind: "text", ...answer }, rangeVars);
    const maxPath = ["nodes", "q", "answer", "max"];

    it("A. a negative max with min omitted is rejected, not published", () => {
      const result = rejects(textAnswer({ max: -1 }), "NUMBER_TOO_SMALL", maxPath);
      expect(hitsOf(result, "NUMBER_TOO_SMALL")[0]!.context).toEqual({ min: 1 });
      expect(result.config).toBeNull();
    });

    it("B. a negative max with an explicit min is rejected", () => {
      rejects(textAnswer({ min: 1, max: -5 }), "NUMBER_TOO_SMALL", maxPath);
    });

    it("C. max 0 is refused: an empty answer is never accepted (effective min is 1)", () => {
      rejects(textAnswer({ max: 0 }), "NUMBER_TOO_SMALL", maxPath);
      const both = rejects(textAnswer({ min: 0, max: 0 }), "NUMBER_TOO_SMALL", maxPath);
      expect(pathsOf(both, "NUMBER_TOO_SMALL")).toContainEqual(["nodes", "q", "answer", "min"]);
    });

    it("D. min greater than max is rejected", () => {
      rejects(textAnswer({ min: 10, max: 5 }), "ANSWER_RANGE_INVALID", ["nodes", "q", "answer"]);
      rejects(textAnswer({ min: 51, max: 50 }), "ANSWER_RANGE_INVALID");
    });

    it("E. the boundaries 1 and the variable's maxLength are accepted", () => {
      for (const answer of [{ max: 1 }, { min: 1, max: 1 }, { max: 50 }, { min: 50, max: 50 }])
        expect(validateFlow(textAnswer(answer)).ok, JSON.stringify(answer)).toBe(true);
      rejects(textAnswer({ max: 51 }), "ANSWER_EXCEEDS_VARIABLE", maxPath);
    });

    it("F. omitted bounds are normalized consistently and stay stable on re-validation", () => {
      const text = validateFlow(textAnswer({ max: 20 }));
      expect(getNode(text.config!, "q")).toMatchObject({ answer: { kind: "text", max: 20 } });
      expect((getNode(text.config!, "q") as { answer: Json }).answer).not.toHaveProperty("min");
      const integer = validateFlow(question("age", { kind: "integer" }, rangeVars));
      expect((getNode(integer.config!, "q") as { answer: Json }).answer).toEqual({
        kind: "integer",
      });
      for (const result of [text, integer])
        expect(validateFlow(result.config).config).toEqual(result.config);
    });

    it("G. integer ranges are unchanged: any whole numbers, only min > max is invalid", () => {
      const integer = (answer: Json) => question("age", { kind: "integer", ...answer }, rangeVars);
      for (const answer of [{ max: -1 }, { min: -10, max: -1 }, { min: 0, max: 0 }, { min: 7 }])
        expect(validateFlow(integer(answer)).ok, JSON.stringify(answer)).toBe(true);
      rejects(integer({ min: 0, max: -1 }), "ANSWER_RANGE_INVALID");
    });
  });

  it("SET_VARIABLE value must fit the variable", () => {
    rejects(setVar("age", "ten", vars), "VARIABLE_TYPE_MISMATCH", ["nodes", "s", "value"]);
    rejects(setVar("label", 5, vars), "VARIABLE_TYPE_MISMATCH");
    rejects(setVar("flag", "yes", vars), "VARIABLE_TYPE_MISMATCH");
    rejects(setVar("age", 1.5, vars), "NUMBER_NOT_INTEGER", ["nodes", "s", "value"]);
    rejects(setVar("age", 2 ** 60, vars), "NUMBER_NOT_INTEGER");
    rejects(setVar("label", "too long", vars), "VALUE_EXCEEDS_VARIABLE", ["nodes", "s", "value"]);
    rejects(setVar("label", null, vars), "FIELD_INVALID", ["nodes", "s", "value"]);
    expect(validateFlow(setVar("label", "ok", vars)).ok).toBe(true);
    expect(validateFlow(setVar("label", "", vars)).ok).toBe(true); // a literal may be empty
  });
});

describe("T. interpolation", () => {
  const vars = { student_name: { type: "string", maxLength: 100 }, grade: { type: "integer" } };

  it("well-formed placeholders of declared variables are accepted", () => {
    const flow = withVars(
      flowWith(
        {
          s: { type: "SET_VARIABLE", variable: "student_name", value: "x", next: "g" },
          g: { type: "SET_VARIABLE", variable: "grade", value: 1, next: "m" },
          m: { type: "MESSAGE", text: "Hi {{student_name}}, grade {{grade}}.", next: "done" },
        },
        "s",
      ),
      vars,
    );
    expect(validateFlow(flow).ok).toBe(true);
  });

  it.each([
    ["spaces inside", "Hi {{ student_name }}"],
    ["an empty placeholder", "Hi {{}}"],
    ["an unclosed opening", "Hi {{student_name"],
    ["a stray closing", "Hi student_name}}"],
    ["an uppercase name", "Hi {{Student}}"],
    ["a nested placeholder", "Hi {{{{student_name}}}}"],
    ["a placeholder with a symbol", "Hi {{student-name}}"],
  ])("T. %s is malformed", (_label, text) => {
    rejects(message(text, vars), "INTERPOLATION_MALFORMED", ["nodes", "m", "text"]);
  });

  it("a lone brace is ordinary text", () => {
    expect(validateFlow(message("Cost {10} and {x}", vars)).ok).toBe(true);
  });

  it("placeholders are refused in titles, labels, keys' neighbours and descriptions", () => {
    const flow = withVars(
      flowWith(
        {
          m: {
            type: "LIST",
            body: "ok {{student_name}}",
            buttonLabel: "Open {{grade}}",
            options: [{ key: "a", title: "T {{grade}}", description: "D {{grade}}", next: "done" }],
            onInvalid: "to_staff",
          },
        },
        "m",
      ),
      vars,
    );
    const result = rejects(flow, "INTERPOLATION_NOT_ALLOWED", ["nodes", "m", "buttonLabel"]);
    expect(hitsOf(result, "INTERPOLATION_NOT_ALLOWED").map((h) => h.path)).toEqual(
      expect.arrayContaining([
        ["nodes", "m", "options", 0, "title"],
        ["nodes", "m", "options", 0, "description"],
      ]),
    );
    expect(hitsOf(result, "INTERPOLATION_NOT_ALLOWED")).toHaveLength(3); // the body is allowed
  });

  it("at most ten placeholders per text", () => {
    const ten = "{{grade}}".repeat(10);
    expect(validateFlow(message(ten, vars)).ok).toBe(true);
    rejects(message("{{grade}}".repeat(11), vars), "INTERPOLATION_TOO_MANY", [
      "nodes",
      "m",
      "text",
    ]);
  });

  it("final messages and footers may use placeholders too", () => {
    const flow = withVars(
      flowWith(
        {
          e: { type: "END", message: "Bye {{grade}}" },
          h: { type: "HANDOVER", reason: "other", message: "Hold on {{grade}}" },
          b: {
            type: "BUTTONS",
            body: "b",
            footer: "F {{grade}}",
            options: [{ key: "a", title: "A", next: "e" }],
            onInvalid: "h",
          },
        },
        "b",
      ),
      vars,
    );
    expect(validateFlow(flow).ok).toBe(true);
  });

  it("a text that could outgrow its limit with the longest values only warns", () => {
    const long = withVars(
      flowWith({ m: { type: "MESSAGE", text: `${"x".repeat(600)}{{v}}`, next: "done" } }, "m"),
      { v: { type: "string", maxLength: 500 } },
    );
    const result = validateFlow(long);
    expect(result.ok).toBe(true);
    expect(hitsOf(result, "INTERPOLATED_TEXT_MAY_EXCEED_LIMIT")).toHaveLength(1);
    const fits = withVars(
      flowWith({ m: { type: "MESSAGE", text: `${"x".repeat(100)}{{v}}`, next: "done" } }, "m"),
      { v: { type: "string", maxLength: 500 } },
    );
    expect(codesOf(validateFlow(fits))).not.toContain("INTERPOLATED_TEXT_MAY_EXCEED_LIMIT");
  });
});

describe("conditions are data, never expressions", () => {
  const vars = { v: { type: "string" } };
  it("rejects unsupported operators, including anything that looks like code", () => {
    for (const op of ["matches", "regex", "contains", "eval", "==", "and", "not", "ALL"]) {
      rejects(
        condition({ op, variable: "v", value: "x" }, vars),
        "CONDITION_OPERATOR_UNSUPPORTED",
        ["nodes", "c", "branches", 0, "when", "op"],
      );
    }
    rejects(condition({ op: 5 }, vars), "FIELD_TYPE_INVALID");
    rejects(condition({ variable: "v" }, vars), "FIELD_REQUIRED", [
      "nodes",
      "c",
      "branches",
      0,
      "when",
      "op",
    ]);
    rejects(condition("v == 'x'", vars), "FIELD_TYPE_INVALID", [
      "nodes",
      "c",
      "branches",
      0,
      "when",
    ]);
    rejects(condition(["is_set", "v"], vars), "FIELD_TYPE_INVALID");
    rejects(
      condition({ op: "equals", variable: "v", value: "x", script: "1" }, vars),
      "FIELD_UNKNOWN",
    );
  });

  it("AH. all / any nest at most two levels", () => {
    const leaf = { op: "is_set", variable: "v" };
    const two = { op: "all", conditions: [{ op: "any", conditions: [leaf] }] };
    expect(validateFlow(condition(two, vars)).ok).toBe(true);

    const three = {
      op: "all",
      conditions: [{ op: "any", conditions: [{ op: "all", conditions: [leaf] }] }],
    };
    const result = rejects(condition(three, vars), "CONDITION_TOO_DEEP", [
      "nodes",
      "c",
      "branches",
      0,
      "when",
      "conditions",
      0,
      "conditions",
      0,
    ]);
    expect(hitsOf(result, "CONDITION_TOO_DEEP")[0]!.context).toEqual({ max: 2 });

    rejects(condition({ op: "all", conditions: [] }, vars), "LIST_TOO_SHORT");
    rejects(condition({ op: "any" }, vars), "FIELD_REQUIRED", [
      "nodes",
      "c",
      "branches",
      0,
      "when",
      "conditions",
    ]);
    rejects(
      condition({ op: "any", conditions: Array.from({ length: 11 }, () => leaf) }, vars),
      "LIST_TOO_LONG",
    );
    rejects(condition({ op: "any", conditions: [leaf], extra: 1 }, vars), "FIELD_UNKNOWN");
  });

  it("a CONDITION node needs 1-20 branches and an else", () => {
    rejects(flowWith({ c: { type: "CONDITION", branches: [], else: "done" } }), "LIST_TOO_SHORT", [
      "nodes",
      "c",
      "branches",
    ]);
    rejects(
      flowWith({
        c: {
          type: "CONDITION",
          branches: [{ when: { op: "is_set", variable: "v" }, next: "done" }],
        },
      }),
      "FIELD_REQUIRED",
      ["nodes", "c", "else"],
    );
    rejects(
      flowWith({ c: { type: "CONDITION", branches: [{ next: "done" }], else: "done" } }),
      "FIELD_REQUIRED",
      ["nodes", "c", "branches", 0, "when"],
    );
  });
});

describe("sensitive variables and diagnostics hygiene", () => {
  it("diagnostics carry structure and codes, never configured text", () => {
    const marker = "SECRET-STUDENT-TEXT";
    const flow = flowWith({
      a: { type: "MESSAGE", text: `${marker}\u0000`, next: "done" },
      b: { type: "MESSAGE", text: `${marker} javascript:alert(1) ${marker}`, next: "done" },
      c: {
        type: "BUTTONS",
        body: marker,
        options: [{ key: "a", title: ` ${marker}`, next: "done" }],
        onInvalid: "to_staff",
      },
      d: { type: "MESSAGE", text: `${marker} {{ ${marker} }}`, next: "done" },
    });
    flow.name = ` ${marker}`;
    flow.triggers = [{ kind: "keyword", words: [` ${marker}`] }];
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(4);
    expect(JSON.stringify(result.diagnostics)).not.toContain(marker);
  });

  it("every diagnostic has a severity, a stable code, a path, a message and (inside nodes) the node id", () => {
    const flow = minimalFlow();
    nodesOf(flow).welcome!.next = "nowhere";
    nodesOf(flow).welcome!.extra = true;
    const result = validateFlow(flow);
    for (const d of result.diagnostics) {
      expect(["error", "warning"]).toContain(d.severity);
      expect(d.code).toMatch(/^[A-Z][A-Z_]+$/);
      expect(Array.isArray(d.path)).toBe(true);
      expect(d.message.length).toBeGreaterThan(10);
      if (d.path[0] === "nodes") expect(d.nodeId).toBe(d.path[1]);
      else expect(d.nodeId).toBeUndefined();
    }
    expect(result.errorCount + result.warningCount).toBe(result.diagnostics.length);
  });
});
