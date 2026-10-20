import type { FlowConfig, FlowNode, VariableDecl } from "./types";

// Own-property lookups. A node id or variable name such as "constructor" is legal, so `config.nodes[id]` alone would return an
// inherited member for an id that is not present.

export const getNode = (config: FlowConfig, id: string): FlowNode | undefined =>
  Object.hasOwn(config.nodes, id) ? config.nodes[id] : undefined;

export const getVariable = (config: FlowConfig, name: string): VariableDecl | undefined =>
  Object.hasOwn(config.variables, name) ? config.variables[name] : undefined;
