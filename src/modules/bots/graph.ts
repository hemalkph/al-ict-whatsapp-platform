import { INPUT_WAITING_NODE_TYPES, TERMINAL_NODE_TYPES } from "./limits";
import type { ConfigPath, FlowConfig, FlowNode } from "./types";

// Static graph facts about a flow. Pure; deterministic (identifiers are visited in sorted order).
//
// Vocabulary (ADR 0017):
//  - terminal: HANDOVER and END. They end the session and have no outgoing edge.
//  - input-waiting: BUTTONS, LIST, QUESTION. The step stops there and waits for the student's next message, so every edge
//    OUT of such a node (an option, `next`, `onInvalid`) is taken only after the student answers.
//  - automatic: MESSAGE, CONDITION, SET_VARIABLE. The engine runs through them within one step. A cycle made only of
//    automatic nodes never waits for the student and never ends: that is the infinite loop to refuse. A cycle that contains
//    an input-waiting node is a menu, and stays valid.

export type Edge = {
  readonly from: string;
  readonly to: string;
  /** Path of the field holding the destination, from the root of the configuration. */
  readonly path: ConfigPath;
};

export const isTerminalNode = (node: FlowNode): boolean =>
  (TERMINAL_NODE_TYPES as readonly string[]).includes(node.type);
export const isInputWaitingNode = (node: FlowNode): boolean =>
  (INPUT_WAITING_NODE_TYPES as readonly string[]).includes(node.type);
export const isAutomaticNode = (node: FlowNode): boolean =>
  !isTerminalNode(node) && !isInputWaitingNode(node);

/** Every outgoing transition of a node, in declaration order. */
export function nodeEdges(id: string, node: FlowNode): Edge[] {
  const at = (...rest: (string | number)[]): ConfigPath => ["nodes", id, ...rest];
  switch (node.type) {
    case "MESSAGE":
    case "SET_VARIABLE":
      return [{ from: id, to: node.next, path: at("next") }];
    case "BUTTONS":
    case "LIST":
      return [
        ...node.options.map((o, i) => ({ from: id, to: o.next, path: at("options", i, "next") })),
        { from: id, to: node.onInvalid, path: at("onInvalid") },
      ];
    case "QUESTION":
      return [
        { from: id, to: node.next, path: at("next") },
        { from: id, to: node.onInvalid, path: at("onInvalid") },
      ];
    case "CONDITION":
      return [
        ...node.branches.map((b, i) => ({ from: id, to: b.next, path: at("branches", i, "next") })),
        { from: id, to: node.else, path: at("else") },
      ];
    case "HANDOVER":
    case "END":
      return [];
  }
}

export type GraphAnalysis = {
  /** Reachable from the start node. */
  readonly reachableFromStart: ReadonlySet<string>;
  /** Reachable from the start node or the error node (the engine routes failures to the error node). */
  readonly reachable: ReadonlySet<string>;
  /** Nodes from which some terminal node can be reached (terminals included). */
  readonly canReachTerminal: ReadonlySet<string>;
  /** Groups of automatic nodes that loop without waiting. Each group is sorted; the list is sorted by first member. */
  readonly automaticCycles: readonly (readonly string[])[];
};

/** Analyzes the nodes in the map (edges to absent nodes are ignored). */
export function analyzeGraph(input: {
  readonly startNodeId: string;
  readonly errorNodeId: string;
  readonly nodes: ReadonlyMap<string, FlowNode>;
}): GraphAnalysis {
  const ids = [...input.nodes.keys()].sort();
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    into.set(id, []);
  }
  for (const id of ids) {
    for (const edge of nodeEdges(id, input.nodes.get(id)!)) {
      if (!input.nodes.has(edge.to)) continue;
      out.get(id)!.push(edge.to);
      into.get(edge.to)!.push(id);
    }
  }

  const walk = (roots: readonly string[], next: ReadonlyMap<string, string[]>): Set<string> => {
    const seen = new Set<string>();
    const queue = roots.filter((r) => input.nodes.has(r));
    for (const r of queue) seen.add(r);
    while (queue.length > 0) {
      const id = queue.pop()!;
      for (const to of next.get(id) ?? []) {
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    return seen;
  };

  const terminals = ids.filter((id) => isTerminalNode(input.nodes.get(id)!));
  return {
    reachableFromStart: walk([input.startNodeId], out),
    reachable: walk([input.startNodeId, input.errorNodeId], out),
    canReachTerminal: walk(terminals, into),
    automaticCycles: automaticCycles(ids, out, input.nodes),
  };
}

/** Strongly connected components of the subgraph of automatic nodes that contain a cycle (Tarjan). */
function automaticCycles(
  ids: readonly string[],
  out: ReadonlyMap<string, string[]>,
  nodes: ReadonlyMap<string, FlowNode>,
): string[][] {
  const automatic = new Set(ids.filter((id) => isAutomaticNode(nodes.get(id)!)));
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;

  const visit = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter++;
    stack.push(id);
    onStack.add(id);
    for (const to of out.get(id) ?? []) {
      if (!automatic.has(to)) continue;
      if (!index.has(to)) {
        visit(to);
        low.set(id, Math.min(low.get(id)!, low.get(to)!));
      } else if (onStack.has(to)) {
        low.set(id, Math.min(low.get(id)!, index.get(to)!));
      }
    }
    if (low.get(id) === index.get(id)) {
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        group.push(member);
      } while (member !== id);
      const selfLoop = group.length === 1 && (out.get(id) ?? []).includes(id);
      if (group.length > 1 || selfLoop) found.push(group.sort());
    }
  };

  // Validated flows have at most 200 nodes, so recursion depth is bounded.
  for (const id of ids) if (automatic.has(id) && !index.has(id)) visit(id);
  return found.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
}

/** The same analysis for a validated configuration (nodes looked up by own property only). */
export function analyzeFlow(config: FlowConfig): GraphAnalysis {
  return analyzeGraph({
    startNodeId: config.startNodeId,
    errorNodeId: config.errorNodeId,
    nodes: new Map(Object.entries(config.nodes)),
  });
}
