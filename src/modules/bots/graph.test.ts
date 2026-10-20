import { describe, expect, it } from "vitest";
import {
  analyzeFlow,
  isAutomaticNode,
  isInputWaitingNode,
  isTerminalNode,
  nodeEdges,
  validateFlow,
} from "./index";
import type { FlowNode } from "./index";
import { codesOf, enquiryFlow, flowWith, hitsOf, minimalFlow, nodesOf, pathsOf } from "./testing";

// Static graph validation: automatic cycles, valid menu loops, reachability and termination.

const buttons = (next: string, onInvalid = "to_staff") => ({
  type: "BUTTONS",
  body: "Choose",
  options: [{ key: "a", title: "A", next }],
  onInvalid,
});

describe("X. automatic cycles (an infinite loop that never waits for the student)", () => {
  it("a MESSAGE that points at itself", () => {
    const result = validateFlow(
      flowWith({ loop: { type: "MESSAGE", text: "again", next: "loop" } }, "loop"),
    );
    expect(result.ok).toBe(false);
    expect(hitsOf(result, "AUTOMATIC_CYCLE")).toEqual([
      expect.objectContaining({
        path: ["nodes", "loop"],
        nodeId: "loop",
        context: { nodes: ["loop"] },
      }),
    ]);
  });

  it("two and three automatic nodes of different kinds", () => {
    const two = flowWith(
      {
        a: { type: "MESSAGE", text: "a", next: "b" },
        b: { type: "MESSAGE", text: "b", next: "a" },
      },
      "a",
    );
    expect(hitsOf(validateFlow(two), "AUTOMATIC_CYCLE")[0]!.context).toEqual({ nodes: ["a", "b"] });

    const three = flowWith(
      {
        c: {
          type: "CONDITION",
          branches: [{ when: { op: "is_set", variable: "v" }, next: "s" }],
          else: "done",
        },
        s: { type: "SET_VARIABLE", variable: "v", value: "x", next: "m" },
        m: { type: "MESSAGE", text: "m", next: "c" },
      },
      "c",
    );
    three.variables = { v: { type: "string" } };
    expect(hitsOf(validateFlow(three), "AUTOMATIC_CYCLE")[0]!.context).toEqual({
      nodes: ["c", "m", "s"],
    });
  });

  it("a condition whose else branch loops back", () => {
    const flow = flowWith(
      {
        c: {
          type: "CONDITION",
          branches: [{ when: { op: "is_set", variable: "v" }, next: "done" }],
          else: "c",
        },
      },
      "c",
    );
    flow.variables = { v: { type: "string" } };
    expect(codesOf(validateFlow(flow))).toContain("AUTOMATIC_CYCLE");
  });

  it("separate cycles are reported separately and in a stable order", () => {
    const flow = flowWith(
      {
        z1: { type: "MESSAGE", text: "z", next: "z2" },
        z2: { type: "MESSAGE", text: "z", next: "z1" },
        a1: { type: "MESSAGE", text: "a", next: "a2" },
        a2: { type: "MESSAGE", text: "a", next: "a1" },
        entry: buttons("a1"),
      },
      "entry",
    );
    nodesOf(flow).entry!.options = [
      { key: "a", title: "A", next: "a1" },
      { key: "b", title: "B", next: "z1" },
    ];
    const result = validateFlow(flow);
    expect(pathsOf(result, "AUTOMATIC_CYCLE")).toEqual([
      ["nodes", "a1"],
      ["nodes", "z1"],
    ]);
  });

  it("is reported even when other errors exist", () => {
    const flow = flowWith(
      {
        a: { type: "MESSAGE", text: "a", next: "a" },
        b: { type: "MESSAGE", text: "b", next: "missing" },
      },
      "a",
    );
    const codes = codesOf(validateFlow(flow));
    expect(codes).toContain("AUTOMATIC_CYCLE");
    expect(codes).toContain("REFERENCE_MISSING");
  });
});

describe("Y. loops that wait for the student stay valid", () => {
  it("a menu that returns to itself after an answer", () => {
    const flow = flowWith(
      {
        menu: buttons("info"),
        info: { type: "MESSAGE", text: "Info", next: "menu" },
      },
      "menu",
    );
    nodesOf(flow).menu!.options = [
      { key: "a", title: "Info", next: "info" },
      { key: "b", title: "Done", next: "done" },
    ];
    expect(validateFlow(flow).ok).toBe(true);
  });

  it("the enquiry flow loops through its LIST menu", () => {
    const analysis = analyzeFlow(validateFlow(enquiryFlow()).config!);
    expect(analysis.automaticCycles).toEqual([]);
  });

  it("a QUESTION or a menu that re-asks itself on invalid input", () => {
    const flow = flowWith({ menu: buttons("done", "menu") }, "menu");
    expect(validateFlow(flow).ok).toBe(true);
  });

  it("a long automatic chain that ends is not a cycle", () => {
    expect(
      validateFlow(
        flowWith(
          {
            a: { type: "MESSAGE", text: "a", next: "b" },
            b: { type: "MESSAGE", text: "b", next: "done" },
          },
          "a",
        ),
      ).ok,
    ).toBe(true);
  });
});

describe("Z. reachability and termination", () => {
  it("an unreachable node is a warning with a path and node id, not an error", () => {
    const flow = flowWith({
      island: { type: "END", message: "never" },
      island2: { type: "MESSAGE", text: "x", next: "island" },
    });
    const result = validateFlow(flow);
    expect(result.ok).toBe(true);
    expect(hitsOf(result, "NODE_UNREACHABLE")).toEqual([
      expect.objectContaining({ severity: "warning", path: ["nodes", "island"], nodeId: "island" }),
      expect.objectContaining({
        severity: "warning",
        path: ["nodes", "island2"],
        nodeId: "island2",
      }),
    ]);
  });

  it("the error node counts as reachable even though only the engine routes there", () => {
    const flow = flowWith({ off: { type: "END", message: "e" } });
    flow.errorNodeId = "off";
    flow.nodes = {
      welcome: { type: "MESSAGE", text: "x", next: "done" },
      done: { type: "END" },
      off: { type: "END", message: "e" },
    };
    expect(codesOf(validateFlow(flow))).not.toContain("NODE_UNREACHABLE");
  });

  it("a reachable node from which no terminal can be reached is an error", () => {
    const trap = flowWith({ a: buttons("b", "b"), b: buttons("a", "a") }, "a");
    const result = validateFlow(trap);
    expect(result.ok).toBe(false);
    expect(pathsOf(result, "NODE_CANNOT_REACH_TERMINAL")).toEqual([
      ["nodes", "a"],
      ["nodes", "b"],
    ]);
  });

  it("an onInvalid exit to staff is enough to leave a menu loop", () => {
    expect(validateFlow(flowWith({ a: buttons("b"), b: buttons("a") }, "a")).ok).toBe(true);
  });

  it("whole-graph warnings are held back while another error could make them wrong", () => {
    const flow = flowWith(
      { island: { type: "END" }, bad: { type: "MESSAGE", text: "x", next: "missing" } },
      "bad",
    );
    const codes = codesOf(validateFlow(flow));
    expect(codes).toContain("REFERENCE_MISSING");
    expect(codes).not.toContain("NODE_UNREACHABLE");
    expect(codes).not.toContain("NODE_CANNOT_REACH_TERMINAL");
  });
});

describe("graph helpers", () => {
  const nodes: Record<string, FlowNode> = {
    message: { type: "MESSAGE", text: "t", next: "end" },
    buttons: {
      type: "BUTTONS",
      body: "b",
      options: [
        { key: "a", title: "A", next: "x" },
        { key: "b", title: "B", next: "y" },
      ],
      onInvalid: "z",
    },
    list: {
      type: "LIST",
      body: "b",
      buttonLabel: "o",
      options: [{ key: "a", title: "A", next: "x" }],
      onInvalid: "z",
    },
    question: {
      type: "QUESTION",
      text: "q",
      variable: "v",
      answer: { kind: "yes_no" },
      next: "x",
      onInvalid: "z",
    },
    condition: {
      type: "CONDITION",
      branches: [{ when: { op: "is_set", variable: "v" }, next: "x" }],
      else: "z",
    },
    set: { type: "SET_VARIABLE", variable: "v", value: 1, next: "x" },
    handover: { type: "HANDOVER", reason: "other" },
    end: { type: "END" },
  };

  it("classifies every node type exactly once", () => {
    const kinds = Object.fromEntries(
      Object.entries(nodes).map(([k, n]) => [
        k,
        [isTerminalNode(n), isInputWaitingNode(n), isAutomaticNode(n)],
      ]),
    );
    expect(kinds).toEqual({
      message: [false, false, true],
      buttons: [false, true, false],
      list: [false, true, false],
      question: [false, true, false],
      condition: [false, false, true],
      set: [false, false, true],
      handover: [true, false, false],
      end: [true, false, false],
    });
  });

  it("lists every outgoing edge with the path of the field that holds it", () => {
    expect(nodeEdges("buttons", nodes.buttons!).map((e) => [e.to, e.path])).toEqual([
      ["x", ["nodes", "buttons", "options", 0, "next"]],
      ["y", ["nodes", "buttons", "options", 1, "next"]],
      ["z", ["nodes", "buttons", "onInvalid"]],
    ]);
    expect(nodeEdges("question", nodes.question!).map((e) => e.to)).toEqual(["x", "z"]);
    expect(nodeEdges("condition", nodes.condition!).map((e) => e.path)).toEqual([
      ["nodes", "condition", "branches", 0, "next"],
      ["nodes", "condition", "else"],
    ]);
    expect(nodeEdges("handover", nodes.handover!)).toEqual([]);
    expect(nodeEdges("end", nodes.end!)).toEqual([]);
  });

  it("analyzes a validated configuration", () => {
    const config = validateFlow(minimalFlow()).config!;
    const analysis = analyzeFlow(config);
    expect([...analysis.reachableFromStart].sort()).toEqual(["done", "welcome"]);
    expect([...analysis.reachable].sort()).toEqual(["done", "to_staff", "welcome"]);
    expect([...analysis.canReachTerminal].sort()).toEqual(["done", "to_staff", "welcome"]);
  });
});
