import { create } from "zustand";

import { getMethodEntry } from "@/lib/methodRegistry";
import type {
  NodePosition as WorkflowNodePosition,
  NodeRepeat as WorkflowNodeRepeat,
  ParamBinding,
  ParamValue,
  WorkflowExport,
} from "@/lib/workflowSchema";

export type NodeStatus = "idle" | "running" | "success" | "error";
export type NodeRepeat = WorkflowNodeRepeat;
export type NodePosition = WorkflowNodePosition;
export type RepeatUnit = NodeRepeat["unit"];

export const DEFAULT_NODE_REPEAT: NodeRepeat = {
  enabled: false,
  count: 2,
  interval: 1,
  unit: "seconds",
  loopCount: 1,
};

export const DEFAULT_NODE_POSITION: NodePosition = {
  x: 80,
  y: 80,
};

export interface WorkflowNode {
  id: string;
  name: string;
  method: string;
  schemaMode: "known" | "unknown";
  params: ParamBinding[];
  rawParamsJson: string;
  repeat: NodeRepeat;
  position: NodePosition;
  output?: unknown;
  error?: string;
  status: NodeStatus;
  outputOpen: boolean;
}

interface WorkflowStore {
  apiKey: string;
  order: string[];
  nodes: Record<string, WorkflowNode>;
  selectedNodeId?: string;
  includeOutputsOnExport: boolean;
  setApiKey: (apiKey: string) => void;
  addNode: (method: string) => string;
  removeNode: (nodeId: string) => void;
  renameNode: (nodeId: string, name: string) => void;
  selectNode: (nodeId?: string) => void;
  reorderNodes: (fromNodeId: string, toNodeId: string) => void;
  setParamValue: (nodeId: string, paramName: string, value: ParamValue) => void;
  setRawParamsJson: (nodeId: string, rawParamsJson: string) => void;
  setNodeRepeat: (nodeId: string, repeat: Partial<NodeRepeat>) => void;
  setNodePosition: (nodeId: string, position: NodePosition) => void;
  setNodeStatus: (nodeId: string, status: NodeStatus, error?: string) => void;
  setNodeOutput: (nodeId: string, output: unknown) => void;
  clearOutputs: () => void;
  toggleOutputOpen: (nodeId: string) => void;
  exportWorkflow: (includeOutputs?: boolean) => WorkflowExport;
  importWorkflow: (workflow: WorkflowExport) => void;
  setIncludeOutputsOnExport: (value: boolean) => void;
}

const METHOD_DEFAULT_LITERAL_PARAMS: Record<string, Record<string, unknown>> = {
  getTokenAccountsByOwnerV2: {
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    encoding: "base64",
  },
};

function defaultNodeName(method: string, position: number): string {
  return `${method} #${position}`;
}

function buildDefaultParams(method: string): {
  schemaMode: "known" | "unknown";
  params: ParamBinding[];
  rawParamsJson: string;
} {
  const entry = getMethodEntry(method);

  if (!entry || entry.schema === "unknown") {
    return {
      schemaMode: "unknown",
      params: [],
      rawParamsJson: "[]",
    };
  }

  if (entry.params?.kind === "table") {
    const methodDefaults = METHOD_DEFAULT_LITERAL_PARAMS[method] ?? {};
    return {
      schemaMode: "known",
      params: entry.params.fields.map((field) => ({
        name: field.name,
        value: {
          type: "literal",
          value: Object.prototype.hasOwnProperty.call(methodDefaults, field.name)
            ? methodDefaults[field.name]
            : null,
        },
      })),
      rawParamsJson: "[]",
    };
  }

  return {
    schemaMode: "known",
    params: [],
    rawParamsJson: "[]",
  };
}

function buildNode(method: string, position: number): WorkflowNode {
  const defaults = buildDefaultParams(method);
  const id = `n-${crypto.randomUUID()}`;
  const zeroBasedPosition = Math.max(0, position - 1);
  const column = zeroBasedPosition % 4;
  const row = Math.floor(zeroBasedPosition / 4);

  return {
    id,
    name: defaultNodeName(method, position),
    method,
    schemaMode: defaults.schemaMode,
    params: defaults.params,
    rawParamsJson: defaults.rawParamsJson,
    repeat: DEFAULT_NODE_REPEAT,
    position: {
      x: DEFAULT_NODE_POSITION.x + column * 280,
      y: DEFAULT_NODE_POSITION.y + row * 200,
    },
    status: "idle",
    outputOpen: false,
  };
}

function normalizeRepeat(repeat?: Partial<NodeRepeat>): NodeRepeat {
  const countCandidate = Number(repeat?.count ?? DEFAULT_NODE_REPEAT.count);
  const intervalCandidate = Number(repeat?.interval ?? DEFAULT_NODE_REPEAT.interval);
  const unitCandidate = repeat?.unit ?? DEFAULT_NODE_REPEAT.unit;

  const count = Number.isFinite(countCandidate) ? Math.floor(countCandidate) : DEFAULT_NODE_REPEAT.count;
  const interval = Number.isFinite(intervalCandidate)
    ? Math.floor(intervalCandidate)
    : DEFAULT_NODE_REPEAT.interval;
  const loopCountCandidate = Number(repeat?.loopCount ?? DEFAULT_NODE_REPEAT.loopCount);
  const loopCount = Number.isFinite(loopCountCandidate)
    ? Math.floor(loopCountCandidate)
    : DEFAULT_NODE_REPEAT.loopCount;

  return {
    enabled: repeat?.enabled ?? DEFAULT_NODE_REPEAT.enabled,
    count: Math.min(Math.max(count, 1), 1000),
    interval: Math.min(Math.max(interval, 0), 86_400_000),
    unit:
      unitCandidate === "milliseconds" || unitCandidate === "seconds" || unitCandidate === "minutes"
        ? unitCandidate
        : DEFAULT_NODE_REPEAT.unit,
    loopCount: Math.min(Math.max(loopCount, 0), 100_000),
  };
}

function normalizeNodePosition(position: Partial<NodePosition> | undefined, fallbackIndex: number): NodePosition {
  const zeroBasedPosition = Math.max(0, fallbackIndex - 1);
  const column = zeroBasedPosition % 4;
  const row = Math.floor(zeroBasedPosition / 4);

  const xCandidate = Number(position?.x);
  const yCandidate = Number(position?.y);

  return {
    x: Number.isFinite(xCandidate) ? xCandidate : DEFAULT_NODE_POSITION.x + column * 280,
    y: Number.isFinite(yCandidate) ? yCandidate : DEFAULT_NODE_POSITION.y + row * 200,
  };
}

function buildReferenceAdjacency(nodes: Record<string, WorkflowNode>): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();

  for (const node of Object.values(nodes)) {
    for (const param of node.params) {
      if (param.value.type !== "ref") {
        continue;
      }

      const sourceNodeId = param.value.nodeId;
      const targets = adjacency.get(sourceNodeId) ?? new Set<string>();
      targets.add(node.id);
      adjacency.set(sourceNodeId, targets);
    }
  }

  return adjacency;
}

function hasPath(adjacency: Map<string, Set<string>>, fromNodeId: string, toNodeId: string): boolean {
  if (fromNodeId === toNodeId) {
    return true;
  }

  const visited = new Set<string>();
  const stack: string[] = [fromNodeId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const nextTargets = adjacency.get(current);
    if (!nextTargets) {
      continue;
    }

    for (const nextNodeId of nextTargets) {
      if (nextNodeId === toNodeId) {
        return true;
      }
      if (!visited.has(nextNodeId)) {
        stack.push(nextNodeId);
      }
    }
  }

  return false;
}

function wouldCreateReferenceCycle(
  nodes: Record<string, WorkflowNode>,
  targetNodeId: string,
  sourceNodeId: string,
): boolean {
  if (targetNodeId === sourceNodeId) {
    return true;
  }

  const adjacency = buildReferenceAdjacency(nodes);
  return hasPath(adjacency, targetNodeId, sourceNodeId);
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  apiKey: "",
  order: [],
  nodes: {},
  includeOutputsOnExport: false,
  setApiKey: (apiKey) => set({ apiKey }),
  addNode: (method) => {
    const next = buildNode(method, get().order.length + 1);
    set((state) => ({
      order: [...state.order, next.id],
      nodes: { ...state.nodes, [next.id]: next },
      selectedNodeId: next.id,
    }));
    return next.id;
  },
  removeNode: (nodeId) => {
    set((state) => {
      if (!state.nodes[nodeId]) {
        return state;
      }

      const currentIndex = state.order.indexOf(nodeId);
      const nextOrder = state.order.filter((id) => id !== nodeId);

      const nextNodes = { ...state.nodes };
      delete nextNodes[nodeId];

      let nextSelectedNodeId = state.selectedNodeId;
      if (state.selectedNodeId === nodeId) {
        const candidate = nextOrder[currentIndex] ?? nextOrder[currentIndex - 1];
        nextSelectedNodeId = candidate;
      }

      return {
        order: nextOrder,
        nodes: nextNodes,
        selectedNodeId: nextSelectedNodeId,
      };
    });
  },
  renameNode: (nodeId, name) => {
    set((state) => {
      const node = state.nodes[nodeId];
      if (!node) {
        return state;
      }
      return {
        nodes: {
          ...state.nodes,
          [nodeId]: {
            ...node,
            name,
          },
        },
      };
    });
  },
  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),
  reorderNodes: (fromNodeId, toNodeId) => {
    if (fromNodeId === toNodeId) {
      return;
    }

    set((state) => {
      const fromIndex = state.order.indexOf(fromNodeId);
      const toIndex = state.order.indexOf(toNodeId);

      if (fromIndex < 0 || toIndex < 0) {
        return state;
      }

      const nextOrder = [...state.order];
      const [moved] = nextOrder.splice(fromIndex, 1);
      nextOrder.splice(toIndex, 0, moved);

      return {
        order: nextOrder,
      };
    });
  },
  setParamValue: (nodeId, paramName, value) => {
    set((state) => {
      const node = state.nodes[nodeId];
      if (!node) {
        return state;
      }

       if (value.type === "ref" && wouldCreateReferenceCycle(state.nodes, nodeId, value.nodeId)) {
        return state;
      }

      const existing = node.params.find((param) => param.name === paramName);
      const params = existing
        ? node.params.map((param) =>
            param.name === paramName
              ? {
                  ...param,
                  value,
                }
              : param,
          )
        : [...node.params, { name: paramName, value }];

      return {
        nodes: {
          ...state.nodes,
          [nodeId]: {
            ...node,
            params,
          },
        },
      };
    });
  },
  setRawParamsJson: (nodeId, rawParamsJson) => {
    set((state) => {
      const node = state.nodes[nodeId];
      if (!node) {
        return state;
      }

      return {
        nodes: {
          ...state.nodes,
          [nodeId]: {
            ...node,
            rawParamsJson,
          },
        },
      };
    });
  },
  setNodeRepeat: (nodeId, repeat) => {
    set((state) => {
      const node = state.nodes[nodeId];
      if (!node) {
        return state;
      }

      return {
        nodes: {
          ...state.nodes,
          [nodeId]: {
            ...node,
            repeat: normalizeRepeat({
              ...node.repeat,
              ...repeat,
            }),
          },
        },
      };
    });
  },
  setNodePosition: (nodeId, position) => {
    set((state) => {
      const node = state.nodes[nodeId];
      if (!node) {
        return state;
      }

      return {
        nodes: {
          ...state.nodes,
          [nodeId]: {
            ...node,
            position: normalizeNodePosition(position, state.order.indexOf(nodeId) + 1),
          },
        },
      };
    });
  },
  setNodeStatus: (nodeId, status, error) => {
    set((state) => {
      const node = state.nodes[nodeId];
      if (!node) {
        return state;
      }

      return {
        nodes: {
          ...state.nodes,
          [nodeId]: {
            ...node,
            status,
            error,
          },
        },
      };
    });
  },
  setNodeOutput: (nodeId, output) => {
    set((state) => {
      const node = state.nodes[nodeId];
      if (!node) {
        return state;
      }

      return {
        nodes: {
          ...state.nodes,
          [nodeId]: {
            ...node,
            output,
          },
        },
      };
    });
  },
  clearOutputs: () => {
    set((state) => {
      const nextNodes: Record<string, WorkflowNode> = {};
      for (const [id, node] of Object.entries(state.nodes)) {
        nextNodes[id] = {
          ...node,
          output: undefined,
          error: undefined,
          status: "idle",
        };
      }

      return {
        nodes: nextNodes,
      };
    });
  },
  toggleOutputOpen: (nodeId) => {
    set((state) => {
      const node = state.nodes[nodeId];
      if (!node) {
        return state;
      }

      return {
        nodes: {
          ...state.nodes,
          [nodeId]: {
            ...node,
            outputOpen: !node.outputOpen,
          },
        },
      };
    });
  },
  exportWorkflow: (includeOutputs = get().includeOutputsOnExport) => {
    const state = get();
    return {
      version: 1,
      order: state.order,
      selectedNodeId: state.selectedNodeId,
      ui: {
        includeOutputs,
      },
      nodes: state.order
        .map((nodeId) => state.nodes[nodeId])
        .filter((node): node is WorkflowNode => Boolean(node))
        .map((node) => ({
          id: node.id,
          name: node.name,
          method: node.method,
          schemaMode: node.schemaMode,
          params: node.params,
          rawParamsJson: node.rawParamsJson,
          repeat: node.repeat,
          position: node.position,
          ...(includeOutputs ? { output: node.output } : {}),
        })),
    };
  },
  importWorkflow: (workflow) => {
    set(() => {
      const nodes: Record<string, WorkflowNode> = {};
      const orderIndexById = new Map<string, number>(
        workflow.order.map((nodeId, index) => [nodeId, index + 1]),
      );

      for (const node of workflow.nodes) {
        const fallbackIndex = orderIndexById.get(node.id) ?? 1;
        nodes[node.id] = {
          ...node,
          repeat: normalizeRepeat(node.repeat),
          position: normalizeNodePosition(node.position, fallbackIndex),
          status: "idle",
          error: undefined,
          outputOpen: Boolean(node.output),
        };
      }

      return {
        order: workflow.order,
        nodes,
        selectedNodeId: workflow.selectedNodeId,
      };
    });
  },
  setIncludeOutputsOnExport: (value) => set({ includeOutputsOnExport: value }),
}));

export function selectOrderedNodes(state: WorkflowStore): WorkflowNode[] {
  return state.order.map((nodeId) => state.nodes[nodeId]).filter((node): node is WorkflowNode => Boolean(node));
}
