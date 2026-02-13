import { create } from "zustand";

import { getMethodEntry } from "@/lib/methodRegistry";
import type { ParamBinding, ParamValue, WorkflowExport } from "@/lib/workflowSchema";

export type NodeStatus = "idle" | "running" | "success" | "error";

export interface WorkflowNode {
  id: string;
  name: string;
  method: string;
  schemaMode: "known" | "unknown";
  params: ParamBinding[];
  rawParamsJson: string;
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

  return {
    id,
    name: defaultNodeName(method, position),
    method,
    schemaMode: defaults.schemaMode,
    params: defaults.params,
    rawParamsJson: defaults.rawParamsJson,
    status: "idle",
    outputOpen: false,
  };
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
          ...(includeOutputs ? { output: node.output } : {}),
        })),
    };
  },
  importWorkflow: (workflow) => {
    set(() => {
      const nodes: Record<string, WorkflowNode> = {};

      for (const node of workflow.nodes) {
        nodes[node.id] = {
          ...node,
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
