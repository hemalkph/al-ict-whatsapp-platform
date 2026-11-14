import { describe, expect, it } from "vitest";
import { canonicalFlowJson, getNode, getVariable, validateFlow } from "./index";
import { codesOf, enquiryFlow, flowWith, minimalFlow, nodesOf, type Json } from "./testing";

// Positive fixtures: every supported node type, both terminal start nodes, and a realistic multilingual enquiry flow.

const ok = (flow: unknown) => {
  const result = validateFlow(flow);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.config).not.toBeNull();
  return result;
};

const withVariables = (flow: Json, variables: Json): Json => ({ ...flow, variables });

describe("valid flows", () => {
  it("A. a simple message flow, normalized with defaults and no diagnostics", () => {
    const result = ok(minimalFlow());
    expect(result.diagnostics).toEqual([]);
    expect(result.config).toMatchObject({
      schemaVersion: 1,
      startNodeId: "welcome",
      settings: { idleTimeoutMinutes: 30, maxInvalidAttempts: 2 },
      variables: {},
      layout: {},
    });
  });

  it("B. a BUTTONS menu with one to three options and a footer", () => {
    for (const count of [1, 2, 3]) {
      const options = ["a", "b", "c"]
        .slice(0, count)
        .map((key) => ({ key, title: `Option ${key}`, next: "done" }));
      ok(
        flowWith(
          {
            menu: {
              type: "BUTTONS",
              body: "Choose",
              footer: "Footer",
              options,
              onInvalid: "to_staff",
            },
          },
          "menu",
        ),
      );
    }
  });

  it("C. a LIST menu with descriptions, up to ten rows", () => {
    const options = Array.from({ length: 10 }, (_, i) => ({
      key: `row${i}`,
      title: `Row ${i}`,
      ...(i % 2 === 0 ? { description: `About row ${i}` } : {}),
      next: "done",
    }));
    ok(
      flowWith(
        {
          menu: {
            type: "LIST",
            body: "Pick",
            buttonLabel: "Open",
            footer: "F",
            options,
            onInvalid: "to_staff",
          },
        },
        "menu",
      ),
    );
  });

  it("D. QUESTION nodes: text, integer and yes/no answers", () => {
    const flow = withVariables(
      flowWith(
        {
          q1: {
            type: "QUESTION",
            text: "Name?",
            variable: "name",
            answer: { kind: "text", min: 1, max: 50 },
            next: "q2",
            onInvalid: "to_staff",
          },
          q2: {
            type: "QUESTION",
            text: "Grade?",
            variable: "grade",
            answer: { kind: "integer", min: 1, max: 13 },
            next: "q3",
            onInvalid: "to_staff",
          },
          q3: {
            type: "QUESTION",
            text: "Call you?",
            variable: "call",
            answer: { kind: "yes_no" },
            next: "done",
            onInvalid: "to_staff",
          },
        },
        "q1",
      ),
      {
        name: { type: "string", maxLength: 50 },
        grade: { type: "integer" },
        call: { type: "boolean" },
      },
    );
    const result = ok(flow);
    expect(getVariable(result.config!, "name")).toEqual({
      type: "string",
      sensitive: false,
      maxLength: 50,
    });
  });

  it("E. CONDITION branches with every operator and two levels of all/any", () => {
    const flow = withVariables(
      flowWith(
        {
          q: {
            type: "QUESTION",
            text: "Grade?",
            variable: "grade",
            answer: { kind: "integer" },
            next: "check",
            onInvalid: "to_staff",
          },
          check: {
            type: "CONDITION",
            branches: [
              { when: { op: "equals", variable: "stream", value: "ict" }, next: "done" },
              { when: { op: "not_equals", variable: "grade", value: 5 }, next: "done" },
              { when: { op: "in", variable: "stream", values: ["a", "b"] }, next: "done" },
              { when: { op: "is_set", variable: "stream" }, next: "done" },
              { when: { op: "lt", variable: "grade", value: 10 }, next: "done" },
              { when: { op: "gt", variable: "grade", value: 10 }, next: "done" },
              {
                when: {
                  op: "all",
                  conditions: [
                    { op: "equals", variable: "paid", value: true },
                    {
                      op: "any",
                      conditions: [
                        { op: "lt", variable: "grade", value: 3 },
                        { op: "gt", variable: "grade", value: 12 },
                      ],
                    },
                  ],
                },
                next: "done",
              },
            ],
            else: "to_staff",
          },
          s: { type: "SET_VARIABLE", variable: "stream", value: "ict", next: "done" },
          p: { type: "SET_VARIABLE", variable: "paid", value: false, next: "done" },
        },
        "q",
      ),
      { grade: { type: "integer" }, stream: { type: "string" }, paid: { type: "boolean" } },
    );
    ok(flow);
  });

  it("F. SET_VARIABLE with a string, an integer and a boolean literal", () => {
    const flow = withVariables(
      flowWith(
        {
          s1: { type: "SET_VARIABLE", variable: "label", value: "vip", next: "s2" },
          s2: { type: "SET_VARIABLE", variable: "count", value: -3, next: "s3" },
          s3: { type: "SET_VARIABLE", variable: "flag", value: true, next: "done" },
        },
        "s1",
      ),
      {
        label: { type: "string", maxLength: 10 },
        count: { type: "integer" },
        flag: { type: "boolean" },
      },
    );
    ok(flow);
  });

  it("G. a HANDOVER terminal with a reason and a final message", () => {
    const result = ok(
      flowWith(
        { h: { type: "HANDOVER", reason: "student_requested", message: "A person will help." } },
        "h",
      ),
    );
    expect(getNode(result.config!, "h")).toEqual({
      type: "HANDOVER",
      reason: "student_requested",
      message: "A person will help.",
    });
  });

  it("H. an END terminal with and without a final message", () => {
    ok(flowWith({ e1: { type: "END", message: "Bye" }, e2: { type: "END" } }));
  });

  it("I. END as the start node: valid with a message; without one it is valid but warns", () => {
    const withMessage = ok(flowWith({ e: { type: "END", message: "Closed." } }, "e"));
    expect(codesOf(withMessage)).not.toContain("START_NODE_END_WITHOUT_MESSAGE");

    const silent = ok(flowWith({ e: { type: "END" } }, "e"));
    expect(silent.diagnostics.filter((d) => d.code === "START_NODE_END_WITHOUT_MESSAGE")).toEqual([
      expect.objectContaining({ severity: "warning", path: ["startNodeId"] }),
    ]);
  });

  it("J. HANDOVER as the start node, with and without a message", () => {
    ok(flowWith({ h: { type: "HANDOVER", reason: "needs_staff" } }, "h"));
    ok(flowWith({ h: { type: "HANDOVER", reason: "other", message: "Hold on." } }, "h"));
  });

  it("the realistic multilingual enquiry flow validates, with only the link-review warning", () => {
    const result = ok(enquiryFlow());
    expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["URL_REVIEW_RECOMMENDED", ["nodes", "class_info", "text"]],
    ]);
    expect(result.config!.triggers).toHaveLength(3);
  });

  it("returns a canonical form that does not depend on key order", () => {
    const result = ok(enquiryFlow());
    expect(canonicalFlowJson(result.config!)).toBe(
      canonicalFlowJson(validateFlow(enquiryFlow()).config!),
    );
  });

  it("accepts identifiers that are also built-in property names, and looks them up safely", () => {
    const flow = flowWith(
      { constructor: { type: "MESSAGE", text: "Hi", next: "done" }, tostring: { type: "END" } },
      "constructor",
    );
    const result = ok(flow);
    expect(getNode(result.config!, "constructor")?.type).toBe("MESSAGE");
    expect(getNode(result.config!, "valueof")).toBeUndefined();
    expect(getNode(result.config!, "hasownproperty")).toBeUndefined();
    expect(getVariable(result.config!, "constructor")).toBeUndefined();
  });

  it("does not modify its input", () => {
    const flow = enquiryFlow();
    const before = structuredClone(flow);
    validateFlow(flow);
    expect(flow).toEqual(before);
    nodesOf(flow); // fixture accessor stays usable
  });
});
