"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BotMessageSquare,
  BookOpen,
  ChevronDown,
  KeyRound,
  PanelRightClose,
  Play,
  Plus,
  RotateCcw,
  Send,
  Search,
  Square,
  StepForward,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";

import { ImportExport } from "@/components/ImportExport";
import { NodeGraphCanvas, type NodeGraphConnection } from "@/components/NodeGraphCanvas";
import { NodeSettingsDialog } from "@/components/NodeSettingsDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QuickTooltip } from "@/components/ui/quick-tooltip";
import {
  getMethodEntries,
  getMethodEntry,
  type MethodCategoryId,
  type MethodRegistryEntry,
} from "@/lib/methodRegistry";
import { getByPath } from "@/lib/path";
import { useWorkflowStore } from "@/store/workflowStore";
import type { RepeatUnit, WorkflowNode } from "@/store/workflowStore";

type RpcNetwork = "mainnet" | "devnet" | "testnet";

interface MethodCategory {
  id: MethodCategoryId;
  label: string;
  methods: string[];
}

interface ChatNodeProposal {
  localId?: string;
  method: string;
  paramsByField?: Record<string, unknown>;
  rawParams?: unknown[];
}

interface ChatPlanSummary {
  task: string;
  methods: string[];
  requiredArguments: string[];
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  plan?: ChatPlanSummary;
}

interface ChatResponsePayload {
  reply?: string;
  error?: string;
  nodeProposals?: ChatNodeProposal[];
  nodeProposal?: ChatNodeProposal | null;
  canAddNodes?: boolean;
  canAddNode?: boolean;
  availabilityError?: string;
}

interface RunRangeResult {
  success: boolean;
  canceled?: boolean;
  failedNodeId?: string;
  failedNodeName?: string;
  errorMessage?: string;
}

type PlannedCallCount = number | null;

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatArgumentLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toWorkflowParamValue(
  proposedValue: unknown,
  createdNodeIds: Array<string | undefined>,
  localIdToNodeId: Map<string, string>,
): WorkflowNode["params"][number]["value"] {
  if (
    typeof proposedValue === "object" &&
    proposedValue !== null &&
    (proposedValue as { type?: unknown }).type === "ref"
  ) {
    const path = readNonEmptyString((proposedValue as { path?: unknown }).path);
    if (path) {
      let sourceNodeId: string | undefined;

      const fromNodeIndex = (proposedValue as { fromNodeIndex?: unknown }).fromNodeIndex;
      if (
        typeof fromNodeIndex === "number" &&
        Number.isInteger(fromNodeIndex) &&
        fromNodeIndex >= 0 &&
        fromNodeIndex < createdNodeIds.length
      ) {
        sourceNodeId = createdNodeIds[fromNodeIndex];
      }

      if (!sourceNodeId) {
        const localRef =
          readNonEmptyString((proposedValue as { fromNodeLocalId?: unknown }).fromNodeLocalId) ??
          readNonEmptyString((proposedValue as { fromLocalId?: unknown }).fromLocalId) ??
          readNonEmptyString((proposedValue as { node?: unknown }).node);
        if (localRef) {
          sourceNodeId = localIdToNodeId.get(localRef) ?? sourceNodeId;
        }
      }

      if (!sourceNodeId) {
        const directNodeId = readNonEmptyString((proposedValue as { fromNodeId?: unknown }).fromNodeId);
        if (directNodeId) {
          sourceNodeId = directNodeId;
        }
      }

      if (sourceNodeId) {
        return {
          type: "ref",
          nodeId: sourceNodeId,
          path,
        };
      }
    }
  }

  return {
    type: "literal",
    value: proposedValue,
  };
}

const DEFAULT_HELIUS_RPC_URLS: Record<RpcNetwork, string> = {
  mainnet: "https://mainnet.helius-rpc.com",
  devnet: "https://devnet.helius-rpc.com",
  testnet: "https://testnet.helius-rpc.com",
};
const DEFAULT_HELIUS_HTTP_URLS: Record<RpcNetwork, string> = {
  mainnet: "https://api.helius.xyz",
  devnet: "https://api-devnet.helius.xyz",
  testnet: "https://api-testnet.helius.xyz",
};
const GATEKEEPER_RPC_URL = "https://beta.helius-rpc.com/";
const SESSION_STORAGE_API_KEY = "helius-flow:api-key";

function resolveParamValue(
  paramValue: WorkflowNode["params"][number]["value"],
  outputsByNodeId: Map<string, unknown>,
): unknown {
  if (paramValue.type === "literal") {
    return paramValue.value;
  }

  const sourceOutput = outputsByNodeId.get(paramValue.nodeId);
  if (sourceOutput === undefined) {
    throw new Error(`Reference node ${paramValue.nodeId} has no output`);
  }

  const value = getByPath(sourceOutput, paramValue.path);
  if (value === undefined) {
    throw new Error(`Reference path not found: ${paramValue.path}`);
  }

  return value;
}

function parseRawParams(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function pruneNullish(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => pruneNullish(entry))
      .filter((entry) => entry !== undefined);
  }

  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(input)) {
      const cleaned = pruneNullish(entry);
      if (cleaned !== undefined) {
        next[key] = cleaned;
      }
    }

    return next;
  }

  return value;
}

function setByDotPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = target;

  for (let index = 0; index < parts.length; index += 1) {
    const key = parts[index];
    if (!key) {
      continue;
    }

    if (index === parts.length - 1) {
      cursor[key] = value;
      return;
    }

    const existing = cursor[key];
    if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
      continue;
    }

    const next: Record<string, unknown> = {};
    cursor[key] = next;
    cursor = next;
  }
}

function getNodeParams(node: WorkflowNode, outputsByNodeId: Map<string, unknown>): unknown {
  const entry = getMethodEntry(node.method);

  if (entry?.params?.kind === "table") {
    if (entry.jsonrpcParamsStyle === "object") {
      const paramsObject: Record<string, unknown> = {};

      entry.params.fields.forEach((field) => {
        const binding = node.params.find((param) => param.name === field.name);
        if (!binding) {
          return;
        }

        const value = pruneNullish(resolveParamValue(binding.value, outputsByNodeId));
        if (value === undefined) {
          return;
        }

        setByDotPath(paramsObject, field.name, value);
      });

      return paramsObject;
    }

    const args: unknown[] = [];
    const options: Record<string, unknown> = {};
    const isTokenAccountsFilterMethod =
      node.method === "getTokenAccountsByOwner" ||
      node.method === "getTokenAccountsByOwnerV2" ||
      node.method === "getTokenAccountsByDelegate";
    const tokenAccountFilter: Record<string, unknown> = {};

    entry.params.fields.forEach((field, index) => {
      const binding = node.params.find((param) => param.name === field.name);
      if (!binding) {
        return;
      }

      const value = pruneNullish(resolveParamValue(binding.value, outputsByNodeId));
      if (value === undefined) {
        return;
      }

      // Convention used by our registry: first required field is primary positional arg, others are config options.
      if (index === 0 && field.required) {
        args.push(value);
        return;
      }

      if (isTokenAccountsFilterMethod && (field.name === "mint" || field.name === "programId")) {
        tokenAccountFilter[field.name] = value;
        return;
      }

      setByDotPath(options, field.name, value);
    });

    if (isTokenAccountsFilterMethod && Object.keys(tokenAccountFilter).length > 0) {
      args.push(tokenAccountFilter);
    }

    const cleanedOptions = pruneNullish(options);
    if (
      cleanedOptions &&
      typeof cleanedOptions === "object" &&
      !Array.isArray(cleanedOptions) &&
      Object.keys(cleanedOptions as Record<string, unknown>).length > 0
    ) {
      args.push(cleanedOptions);
    }

    return args;
  }

  const raw = parseRawParams(node.rawParamsJson);
  const cleaned = pruneNullish(raw);
  return cleaned === undefined ? [] : cleaned;
}

function getNodeHttpParams(node: WorkflowNode, outputsByNodeId: Map<string, unknown>): Record<string, unknown> {
  const entry = getMethodEntry(node.method);

  if (entry?.params?.kind !== "table") {
    throw new Error("HTTP methods require table-style params schema in the registry.");
  }

  const params: Record<string, unknown> = {};

  entry.params.fields.forEach((field) => {
    const binding = node.params.find((param) => param.name === field.name);
    if (!binding) {
      return;
    }

    const value = pruneNullish(resolveParamValue(binding.value, outputsByNodeId));
    if (value === undefined) {
      return;
    }

    params[field.name] = value;
  });

  return params;
}

function parseRpcResponse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function buildHeliusJsonRpcUrl(apiKey: string, network: RpcNetwork, gatekeeperEnabled: boolean): string {
  const configured = process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
  const baseUrl = gatekeeperEnabled ? GATEKEEPER_RPC_URL : configured ?? DEFAULT_HELIUS_RPC_URLS[network];

  const url = new URL(baseUrl);
  if (apiKey.trim()) {
    url.searchParams.set("api-key", apiKey.trim());
  }
  return url.toString();
}

function appendQueryValue(searchParams: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => appendQueryValue(searchParams, key, entry));
    return;
  }

  if (typeof value === "object") {
    searchParams.set(key, JSON.stringify(value));
    return;
  }

  searchParams.set(key, String(value));
}

function buildHeliusHttpUrl(
  apiKey: string,
  network: RpcNetwork,
  entry: MethodRegistryEntry,
  params: Record<string, unknown>,
  includeQueryParams = true,
): string {
  if (!entry.http) {
    throw new Error("Missing HTTP config for method.");
  }

  const baseUrl =
    network === "mainnet"
      ? entry.http.mainnetBaseUrl ?? DEFAULT_HELIUS_HTTP_URLS.mainnet
      : network === "devnet"
        ? entry.http.devnetBaseUrl ?? DEFAULT_HELIUS_HTTP_URLS.devnet
        : DEFAULT_HELIUS_HTTP_URLS.testnet;

  const unresolvedPath = entry.http.path;
  const remainingParams: Record<string, unknown> = { ...params };
  const resolvedPath = unresolvedPath.replace(/\{([^}]+)\}/g, (_, token: string) => {
    const value = remainingParams[token];
    if (value === undefined || value === null) {
      throw new Error(`Missing required path param: ${token}`);
    }
    delete remainingParams[token];
    return encodeURIComponent(String(value));
  });

  const url = /^https?:\/\//.test(resolvedPath)
    ? new URL(resolvedPath)
    : new URL(resolvedPath.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`);

  if (apiKey.trim()) {
    url.searchParams.set("api-key", apiKey.trim());
  }

  if (includeQueryParams) {
    for (const [key, value] of Object.entries(remainingParams)) {
      appendQueryValue(url.searchParams, key, value);
    }
  }

  return url.toString();
}

function getMethodCategoryId(entry: MethodRegistryEntry): MethodCategoryId {
  return entry.category ?? "solana-rpc-apis";
}

function getCustomNodeOutput(node: WorkflowNode, outputsByNodeId: Map<string, unknown>): unknown {
  const valueParam = node.params.find((param) => param.name === "value");
  if (!valueParam) {
    return null;
  }

  return resolveParamValue(valueParam.value, outputsByNodeId);
}

function referencesAnyNode(node: WorkflowNode, nodeIds: Set<string>): boolean {
  return node.params.some((param) => param.value.type === "ref" && nodeIds.has(param.value.nodeId));
}

function buildReferenceAdjacency(
  nodeIds: string[],
  nodes: Record<string, WorkflowNode>,
): Map<string, Set<string>> {
  const nodeIdSet = new Set<string>(nodeIds);
  const adjacency = new Map<string, Set<string>>();

  for (const nodeId of nodeIds) {
    const node = nodes[nodeId];
    if (!node) {
      continue;
    }

    for (const param of node.params) {
      if (param.value.type !== "ref") {
        continue;
      }

      const sourceNodeId = param.value.nodeId;
      if (!nodeIdSet.has(sourceNodeId)) {
        continue;
      }

      const targets = adjacency.get(sourceNodeId) ?? new Set<string>();
      targets.add(node.id);
      adjacency.set(sourceNodeId, targets);
    }
  }

  return adjacency;
}

function hasReferencePath(
  adjacency: Map<string, Set<string>>,
  fromNodeId: string,
  toNodeId: string,
): boolean {
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
    const next = adjacency.get(current);
    if (!next) {
      continue;
    }

    for (const candidate of next) {
      if (candidate === toNodeId) {
        return true;
      }
      if (!visited.has(candidate)) {
        stack.push(candidate);
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

  const nodeIds = Object.keys(nodes);
  const adjacency = buildReferenceAdjacency(nodeIds, nodes);
  return hasReferencePath(adjacency, targetNodeId, sourceNodeId);
}

function buildDependencyExecutionOrder(
  order: string[],
  nodes: Record<string, WorkflowNode>,
): { orderedNodeIds: string[]; hasCycle: boolean } {
  const orderedNodeIds = order.filter((nodeId) => Boolean(nodes[nodeId]));
  const indexByNodeId = new Map<string, number>(
    orderedNodeIds.map((nodeId, index) => [nodeId, index]),
  );
  const adjacency = buildReferenceAdjacency(orderedNodeIds, nodes);
  const indegreeByNodeId = new Map<string, number>(orderedNodeIds.map((nodeId) => [nodeId, 0]));

  for (const targets of adjacency.values()) {
    for (const targetNodeId of targets) {
      indegreeByNodeId.set(targetNodeId, (indegreeByNodeId.get(targetNodeId) ?? 0) + 1);
    }
  }

  const queue: string[] = orderedNodeIds.filter((nodeId) => (indegreeByNodeId.get(nodeId) ?? 0) === 0);
  queue.sort((a, b) => (indexByNodeId.get(a) ?? 0) - (indexByNodeId.get(b) ?? 0));

  const result: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) {
      continue;
    }

    result.push(nodeId);
    const targets = adjacency.get(nodeId);
    if (!targets) {
      continue;
    }

    for (const targetNodeId of targets) {
      const nextInDegree = (indegreeByNodeId.get(targetNodeId) ?? 0) - 1;
      indegreeByNodeId.set(targetNodeId, nextInDegree);

      if (nextInDegree === 0) {
        queue.push(targetNodeId);
      }
    }

    queue.sort((a, b) => (indexByNodeId.get(a) ?? 0) - (indexByNodeId.get(b) ?? 0));
  }

  return {
    orderedNodeIds: result.length === orderedNodeIds.length ? result : orderedNodeIds,
    hasCycle: result.length !== orderedNodeIds.length,
  };
}

function getReferencedDownstreamNodeIds(
  executionOrder: string[],
  nodes: Record<string, WorkflowNode>,
  sourceNodeId: string,
  includedNodeIds: Set<string>,
): string[] {
  const sourceIds = new Set<string>([sourceNodeId]);
  const referencedNodeIds: string[] = [];

  for (const nodeId of executionOrder) {
    if (!includedNodeIds.has(nodeId) || nodeId === sourceNodeId) {
      continue;
    }

    const node = nodes[nodeId];

    if (!node || !referencesAnyNode(node, sourceIds)) {
      continue;
    }

    sourceIds.add(nodeId);
    referencedNodeIds.push(nodeId);
  }

  return referencedNodeIds;
}

function repeatIntervalToMs(interval: number, unit: RepeatUnit): number {
  if (unit === "minutes") {
    return interval * 60_000;
  }
  if (unit === "seconds") {
    return interval * 1_000;
  }
  return interval;
}

function sleepWithSignal(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Execution stopped.", "AbortError"));
      return;
    }

    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);

    const onAbort = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Execution stopped.", "AbortError"));
    };

    signal.addEventListener("abort", onAbort);
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function addPlannedCallCount(
  callCountsByNodeId: Map<string, PlannedCallCount>,
  nodeId: string,
  count: number,
): void {
  const existing = callCountsByNodeId.get(nodeId);
  if (existing === null) {
    return;
  }
  if (existing === undefined) {
    callCountsByNodeId.set(nodeId, count);
    return;
  }
  callCountsByNodeId.set(nodeId, existing + count);
}

function setPlannedCallCountInfinite(callCountsByNodeId: Map<string, PlannedCallCount>, nodeId: string): void {
  callCountsByNodeId.set(nodeId, null);
}

function calculatePlannedCallCounts(
  executionOrder: string[],
  nodes: Record<string, WorkflowNode>,
  includedNodeIds: Set<string>,
): Map<string, PlannedCallCount> {
  const callCountsByNodeId = new Map<string, PlannedCallCount>();
  const skippedNodeIds = new Set<string>();

  for (const nodeId of executionOrder) {
    if (!includedNodeIds.has(nodeId) || skippedNodeIds.has(nodeId)) {
      continue;
    }

    const node = nodes[nodeId];
    if (!node) {
      continue;
    }

    if (!node.repeat.enabled) {
      addPlannedCallCount(callCountsByNodeId, nodeId, 1);
      continue;
    }

    const downstreamNodeIds = getReferencedDownstreamNodeIds(executionOrder, nodes, nodeId, includedNodeIds);
    const repeatCount = Math.max(1, Math.floor(node.repeat.count));
    const loopCount = Math.max(0, Math.floor(node.repeat.loopCount));

    if (loopCount === 0) {
      setPlannedCallCountInfinite(callCountsByNodeId, nodeId);
      for (const downstreamNodeId of downstreamNodeIds) {
        setPlannedCallCountInfinite(callCountsByNodeId, downstreamNodeId);
      }
      break;
    }

    const totalCalls = repeatCount * loopCount;
    addPlannedCallCount(callCountsByNodeId, nodeId, totalCalls);
    for (const downstreamNodeId of downstreamNodeIds) {
      addPlannedCallCount(callCountsByNodeId, downstreamNodeId, totalCalls);
      skippedNodeIds.add(downstreamNodeId);
    }
  }

  return callCountsByNodeId;
}

export default function HomePage() {
  const apiKey = useWorkflowStore((state) => state.apiKey);
  const order = useWorkflowStore((state) => state.order);
  const nodes = useWorkflowStore((state) => state.nodes);
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId);
  const includeOutputsOnExport = useWorkflowStore((state) => state.includeOutputsOnExport);

  const setApiKey = useWorkflowStore((state) => state.setApiKey);
  const addNode = useWorkflowStore((state) => state.addNode);
  const removeNode = useWorkflowStore((state) => state.removeNode);
  const renameNode = useWorkflowStore((state) => state.renameNode);
  const selectNode = useWorkflowStore((state) => state.selectNode);
  const setNodePosition = useWorkflowStore((state) => state.setNodePosition);
  const setParamValue = useWorkflowStore((state) => state.setParamValue);
  const setRawParamsJson = useWorkflowStore((state) => state.setRawParamsJson);
  const setNodeRepeat = useWorkflowStore((state) => state.setNodeRepeat);
  const setNodeStatus = useWorkflowStore((state) => state.setNodeStatus);
  const setNodeOutput = useWorkflowStore((state) => state.setNodeOutput);
  const clearOutputs = useWorkflowStore((state) => state.clearOutputs);
  const exportWorkflow = useWorkflowStore((state) => state.exportWorkflow);
  const importWorkflow = useWorkflowStore((state) => state.importWorkflow);
  const setIncludeOutputsOnExport = useWorkflowStore((state) => state.setIncludeOutputsOnExport);

  const [isExecuting, setIsExecuting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [showMethodPicker, setShowMethodPicker] = useState(false);
  const [showBotPanel, setShowBotPanel] = useState(false);
  const [isBotReplying, setIsBotReplying] = useState(false);
  const [isBotTesting, setIsBotTesting] = useState(false);
  const [botInput, setBotInput] = useState("");
  const [botMessages, setBotMessages] = useState<ChatMessage[]>([]);
  const [methodQuery, setMethodQuery] = useState("");
  const [selectedMethodCategoryId, setSelectedMethodCategoryId] = useState<MethodCategoryId>("solana-rpc-apis");
  const [selectedMethod, setSelectedMethod] = useState<string>();
  const [editingNodeId, setEditingNodeId] = useState<string>();
  const [showInstructions, setShowInstructions] = useState(false);
  const [network, setNetwork] = useState<RpcNetwork>("mainnet");
  const [gatekeeperEnabled, setGatekeeperEnabled] = useState(false);
  const [hasLoadedApiKeyFromSession, setHasLoadedApiKeyFromSession] = useState(false);
  const [nodeCallCounts, setNodeCallCounts] = useState<Record<string, number>>({});
  const [nodeCallTargets, setNodeCallTargets] = useState<Record<string, PlannedCallCount>>({});
  const activeExecutionAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (gatekeeperEnabled && network === "testnet") {
      setNetwork("mainnet");
    }
  }, [gatekeeperEnabled, network]);

  useEffect(() => {
    const storedApiKey = window.sessionStorage.getItem(SESSION_STORAGE_API_KEY);
    if (storedApiKey) {
      setApiKey(storedApiKey);
    }
    setHasLoadedApiKeyFromSession(true);
  }, [setApiKey]);

  useEffect(() => {
    if (!hasLoadedApiKeyFromSession) {
      return;
    }

    if (apiKey.trim()) {
      window.sessionStorage.setItem(SESSION_STORAGE_API_KEY, apiKey);
      return;
    }

    window.sessionStorage.removeItem(SESSION_STORAGE_API_KEY);
  }, [apiKey, hasLoadedApiKeyFromSession]);

  useEffect(() => {
    if (!editingNodeId) {
      return;
    }

    if (nodes[editingNodeId]) {
      return;
    }

    setEditingNodeId(undefined);
  }, [editingNodeId, nodes]);

  const orderedNodes = useMemo(
    () => order.map((nodeId) => nodes[nodeId]).filter((node): node is WorkflowNode => Boolean(node)),
    [order, nodes],
  );
  const dependencyExecutionPlan = useMemo(
    () => buildDependencyExecutionOrder(order, nodes),
    [order, nodes],
  );
  const executionOrderByNodeId = useMemo<Record<string, number | null>>(() => {
    const orderByNodeId: Record<string, number | null> = {};

    for (const node of orderedNodes) {
      orderByNodeId[node.id] = dependencyExecutionPlan.hasCycle ? null : 0;
    }

    if (!dependencyExecutionPlan.hasCycle) {
      dependencyExecutionPlan.orderedNodeIds.forEach((nodeId, index) => {
        orderByNodeId[nodeId] = index + 1;
      });
    }

    return orderByNodeId;
  }, [dependencyExecutionPlan, orderedNodes]);
  const defaultPlannedCallCounts = useMemo(
    () =>
      calculatePlannedCallCounts(
        dependencyExecutionPlan.orderedNodeIds,
        nodes,
        new Set(dependencyExecutionPlan.orderedNodeIds),
      ),
    [dependencyExecutionPlan, nodes],
  );
  const graphConnections = useMemo<NodeGraphConnection[]>(() => {
    const connections: NodeGraphConnection[] = [];

    for (const node of orderedNodes) {
      for (const param of node.params) {
        if (param.value.type !== "ref") {
          continue;
        }

        connections.push({
          id: `${param.value.nodeId}-${node.id}-${param.name}-${param.value.path}-${connections.length}`,
          fromNodeId: param.value.nodeId,
          toNodeId: node.id,
          paramName: param.name,
          path: param.value.path,
        });
      }
    }

    return connections;
  }, [orderedNodes]);
  const callTargetByNodeId = useMemo<Record<string, number | null>>(() => {
    const targets: Record<string, number | null> = {};

    for (const node of orderedNodes) {
      const hasRunSpecificTarget = Object.prototype.hasOwnProperty.call(nodeCallTargets, node.id);
      if (hasRunSpecificTarget) {
        targets[node.id] = nodeCallTargets[node.id] ?? null;
        continue;
      }

      if (defaultPlannedCallCounts.has(node.id)) {
        targets[node.id] = defaultPlannedCallCounts.get(node.id) ?? null;
        continue;
      }

      targets[node.id] = 0;
    }

    return targets;
  }, [defaultPlannedCallCounts, nodeCallTargets, orderedNodes]);
  const editingNode = useMemo(
    () => (editingNodeId ? nodes[editingNodeId] : undefined),
    [editingNodeId, nodes],
  );
  const editingNodeIndex = useMemo(
    () => (editingNode ? order.indexOf(editingNode.id) : -1),
    [editingNode, order],
  );
  const editingNodeSourceNodes = useMemo(() => {
    if (!editingNode) {
      return [];
    }

    return orderedNodes
      .filter((candidate) => candidate.id !== editingNode.id)
      .filter((candidate) => candidate.output !== undefined)
      .filter((candidate) => !wouldCreateReferenceCycle(nodes, editingNode.id, candidate.id))
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        output: candidate.output,
      }));
  }, [editingNode, nodes, orderedNodes]);

  const methodEntries = useMemo(() => getMethodEntries(), []);
  const methodCategories = useMemo<MethodCategory[]>(
    () => [
      {
        id: "solana-rpc-apis",
        label: "Solana RPC APIs",
        methods: methodEntries
          .filter((entry) => getMethodCategoryId(entry) === "solana-rpc-apis")
          .map((entry) => entry.method),
      },
      {
        id: "digital-asset-standard-das",
        label: "Digital Asset Standard (DAS)",
        methods: methodEntries
          .filter((entry) => getMethodCategoryId(entry) === "digital-asset-standard-das")
          .map((entry) => entry.method),
      },
      {
        id: "wallet-api",
        label: "Wallet API",
        methods: methodEntries
          .filter((entry) => getMethodCategoryId(entry) === "wallet-api")
          .map((entry) => entry.method),
      },
      {
        id: "zk-compression",
        label: "ZK Compression",
        methods: methodEntries
          .filter((entry) => getMethodCategoryId(entry) === "zk-compression")
          .map((entry) => entry.method),
      },
      {
        id: "custom",
        label: "Custom",
        methods: methodEntries
          .filter((entry) => getMethodCategoryId(entry) === "custom")
          .map((entry) => entry.method),
      },
    ],
    [methodEntries],
  );

  const selectedCategory = useMemo(
    () => methodCategories.find((category) => category.id === selectedMethodCategoryId) ?? methodCategories[0],
    [methodCategories, selectedMethodCategoryId],
  );

  const filteredMethods = useMemo(() => {
    const query = methodQuery.trim().toLowerCase();
    const methods = selectedCategory?.methods ?? [];
    if (!query) {
      return methods;
    }
    return methods.filter((method) => method.toLowerCase().includes(query));
  }, [selectedCategory, methodQuery]);

  const activeMethod = useMemo(() => {
    if (selectedMethod && filteredMethods.includes(selectedMethod)) {
      return selectedMethod;
    }
    return filteredMethods[0];
  }, [filteredMethods, selectedMethod]);

  const activeMethodEntry = useMemo(
    () => (activeMethod ? methodEntries.find((entry) => entry.method === activeMethod) : undefined),
    [activeMethod, methodEntries],
  );

  const hasHeliusApiKey = apiKey.trim().length > 0;
  const isBotInputDisabled = isBotReplying || isBotTesting || isExecuting || !hasHeliusApiKey;

  const requestChatPlan = async (
    messages: Array<{ role: "user" | "assistant"; text: string }>,
    mode: "plan" | "repair" = "plan",
  ): Promise<ChatResponsePayload> => {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages, mode }),
    });

    const data = (await response.json()) as ChatResponsePayload;
    if (!response.ok) {
      throw new Error(data.error ?? "Failed to get a response from Claude.");
    }
    return data;
  };

  const extractProposals = (data: ChatResponsePayload): ChatNodeProposal[] =>
    Array.isArray(data.nodeProposals) ? data.nodeProposals : data.nodeProposal ? [data.nodeProposal] : [];

  const buildCompactHistory = (userMessage: string): Array<{ role: "user" | "assistant"; text: string }> => {
    const recent = botMessages
      .slice(-4)
      .map((entry) => ({ role: entry.role, text: entry.text }))
      .filter((entry) => entry.text.trim().length > 0);
    return [...recent, { role: "user", text: userMessage }];
  };

  const applyNodeProposals = (proposals: ChatNodeProposal[]) => {
    const createdNodeIdsByIndex: Array<string | undefined> = [];
    const createdMethodNames: string[] = [];
    const localIdToNodeId = new Map<string, string>();

    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index];
      const methodEntry = getMethodEntry(proposal.method);
      if (!methodEntry) {
        continue;
      }

      const nodeId = addNode(proposal.method);
      createdNodeIdsByIndex[index] = nodeId;
      createdMethodNames.push(proposal.method);

      const localId = readNonEmptyString(proposal.localId);
      if (localId) {
        localIdToNodeId.set(localId, nodeId);
      }
    }

    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index];
      const nodeId = createdNodeIdsByIndex[index];
      if (!nodeId) {
        continue;
      }

      const methodEntry = getMethodEntry(proposal.method);
      if (!methodEntry) {
        continue;
      }

      if (methodEntry.params?.kind === "table") {
        const paramsByField = proposal.paramsByField ?? {};
        for (const field of methodEntry.params.fields) {
          if (Object.prototype.hasOwnProperty.call(paramsByField, field.name)) {
            setParamValue(
              nodeId,
              field.name,
              toWorkflowParamValue(paramsByField[field.name], createdNodeIdsByIndex, localIdToNodeId),
            );
          }
        }
      } else if (proposal.rawParams) {
        setRawParamsJson(nodeId, JSON.stringify(proposal.rawParams, null, 2));
      }
    }

    return {
      createdNodeIds: createdNodeIdsByIndex.filter((nodeId): nodeId is string => Boolean(nodeId)),
      createdMethodNames,
    };
  };

  const handleBotSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = botInput.trim();
    if (!message || isBotReplying || isBotTesting || isExecuting || !hasHeliusApiKey) {
      return;
    }

    const nextMessages = buildCompactHistory(message);
    setBotMessages((prev) => [...prev, { role: "user", text: message }]);
    setBotInput("");

    setIsBotReplying(true);
    try {
      let data = await requestChatPlan(nextMessages, "plan");
      let proposals = extractProposals(data);
      let canAddNodes = Boolean(data.canAddNodes ?? data.canAddNode);

      if (proposals.length === 0 || !canAddNodes) {
        const retryData = await requestChatPlan(
          [
            ...nextMessages,
            {
              role: "user",
              text: "Add workflow nodes now. Return a non-empty proposedNodes array using only available methods.",
            },
          ],
          "plan",
        );

        const retryProposals = extractProposals(retryData);
        const canRetryAddNodes = Boolean(retryData.canAddNodes ?? retryData.canAddNode);
        if (retryProposals.length > 0 && canRetryAddNodes) {
          data = retryData;
          proposals = retryProposals;
          canAddNodes = canRetryAddNodes;
        }
      }

      let assistantReply = "Could not create a valid node plan. Please ask me to add nodes for a specific task.";
      let assistantPlan: ChatPlanSummary | undefined;

      if (proposals.length > 0) {
        const requiredArgumentsSet = new Set<string>();
        for (const proposal of proposals) {
          const methodEntry = getMethodEntry(proposal.method);
          if (methodEntry?.params?.kind !== "table") {
            continue;
          }

          const paramsByField = proposal.paramsByField ?? {};
          for (const field of methodEntry.params.fields) {
            if (!field.required) {
              continue;
            }
            if (!Object.prototype.hasOwnProperty.call(paramsByField, field.name)) {
              continue;
            }
            requiredArgumentsSet.add(formatArgumentLabel(field.name));
          }
        }
        const requiredArguments = [...requiredArgumentsSet];

        if (canAddNodes) {
          const { createdNodeIds, createdMethodNames } = applyNodeProposals(proposals);

          assistantPlan = {
            task: message,
            methods: createdMethodNames.length > 0 ? createdMethodNames : proposals.map((proposal) => proposal.method),
            requiredArguments,
          };

          if (createdMethodNames.length > 0) {
            assistantReply = `Added ${createdMethodNames.length} node(s) to the workflow.`;

            setIsBotTesting(true);
            clearOutputs();
            const initialRun = await runRange(0, useWorkflowStore.getState().order.length);

            if (initialRun.success) {
              assistantReply += " Validation passed.";
            } else if (initialRun.canceled) {
              assistantReply += " Validation was stopped.";
            } else {
              const workflowState = useWorkflowStore.getState();
              const recentNodes = createdNodeIds
                .map((nodeId) => workflowState.nodes[nodeId])
                .filter((node): node is WorkflowNode => Boolean(node))
                .map((node, index) => ({
                  index,
                  method: node.method,
                  params: node.params,
                  rawParamsJson: node.rawParamsJson,
                }));

              const repairRequest = [
                "The workflow validation run failed. Provide a corrected replacement plan for the recently added nodes.",
                `Failed node: ${initialRun.failedNodeName ?? "unknown"}`,
                `Error: ${initialRun.errorMessage ?? "unknown error"}`,
                `Network: ${network}`,
                `Recently added nodes: ${JSON.stringify(recentNodes)}`,
                "Return corrected proposedNodes only.",
              ].join("\n");

              const repairData = await requestChatPlan(
                [
                  { role: "user", text: message },
                  { role: "assistant", text: assistantReply },
                  { role: "user", text: repairRequest },
                ],
                "repair",
              );

              const repairProposals = extractProposals(repairData);
              const canRepair = Boolean(repairData.canAddNodes ?? repairData.canAddNode);

              if (canRepair && repairProposals.length > 0) {
                for (let index = createdNodeIds.length - 1; index >= 0; index -= 1) {
                  removeNode(createdNodeIds[index]);
                }

                applyNodeProposals(repairProposals);
                clearOutputs();
                const repairRun = await runRange(0, useWorkflowStore.getState().order.length);

                if (repairRun.success) {
                  assistantReply += " Initial validation failed, then auto-correction succeeded.";
                } else if (repairRun.canceled) {
                  assistantReply += " Auto-correction validation was stopped.";
                } else {
                  assistantReply += ` Auto-correction attempted but still failed at ${repairRun.failedNodeName ?? "a node"}: ${repairRun.errorMessage ?? "unknown error"}.`;
                }
              } else {
                assistantReply += ` Validation failed and no safe correction plan was available: ${repairData.availabilityError ?? "unknown reason"}.`;
              }
            }
            setIsBotTesting(false);
          } else {
            assistantReply = "No nodes were added because none of the proposed methods were available.";
          }
        } else {
          assistantReply = `Could not add node(s): ${data.availabilityError ?? "Suggested RPC plan is unavailable in this workflow."}`;
        }
      } else if (data.availabilityError) {
        assistantReply = `Could not add node(s): ${data.availabilityError}`;
      }

      setBotMessages((prev) => [...prev, { role: "assistant", text: assistantReply, plan: assistantPlan }]);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Unknown error";
      setBotMessages((prev) => [...prev, { role: "assistant", text: `Error: ${messageText}` }]);
    } finally {
      setIsBotTesting(false);
      setIsBotReplying(false);
    }
  };

  const executeSingleNode = async (
    nodeId: string,
    outputsByNodeId: Map<string, unknown>,
    signal: AbortSignal,
  ): Promise<RunRangeResult> => {
    const node = useWorkflowStore.getState().nodes[nodeId];
    if (!node) {
      return { success: true };
    }

    if (signal.aborted) {
      return {
        success: false,
        canceled: true,
        failedNodeId: node.id,
        failedNodeName: node.name,
        errorMessage: "Execution stopped by user.",
      };
    }

    setNodeCallCounts((prev) => ({
      ...prev,
      [node.id]: (prev[node.id] ?? 0) + 1,
    }));
    setNodeStatus(node.id, "running");

    try {
      const methodEntry = getMethodEntry(node.method);
      const transport = methodEntry?.transport ?? "jsonrpc";
      const apiKeyValue = useWorkflowStore.getState().apiKey;

      let response: Response;

      if (transport === "custom") {
        const output = getCustomNodeOutput(node, outputsByNodeId);
        setNodeOutput(node.id, output);
        outputsByNodeId.set(node.id, output);
        setNodeStatus(node.id, "success");
        return { success: true };
      }

      if (transport === "http") {
        if (!methodEntry?.http) {
          throw new Error(`Method ${node.method} is marked as HTTP but has no HTTP config.`);
        }

        const httpParams = getNodeHttpParams(node, outputsByNodeId);
        const shouldUsePost = gatekeeperEnabled || methodEntry.http.method === "POST";
        const url = buildHeliusHttpUrl(apiKeyValue, network, methodEntry, httpParams, !shouldUsePost);

        if (shouldUsePost) {
          response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(httpParams),
            signal,
          });
        } else {
          response = await fetch(url, {
            method: "GET",
            signal,
          });
        }
      } else {
        const params = getNodeParams(node, outputsByNodeId);

        response = await fetch(buildHeliusJsonRpcUrl(apiKeyValue, network, gatekeeperEnabled), {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            method: node.method,
            params,
          }),
          signal,
        });
      }

      const text = await response.text();
      const parsed = parseRpcResponse(text);
      setNodeOutput(node.id, parsed);

      if (!response.ok) {
        const message =
          typeof parsed === "object" && parsed !== null && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : `Request failed with status ${response.status}`;
        setNodeStatus(node.id, "error", message);
        return {
          success: false,
          failedNodeId: node.id,
          failedNodeName: node.name,
          errorMessage: message,
        };
      }

      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        const rpcError = (parsed as { error?: unknown }).error;
        const message = typeof rpcError === "string" ? rpcError : JSON.stringify(rpcError);
        setNodeStatus(node.id, "error", message);
        return {
          success: false,
          failedNodeId: node.id,
          failedNodeName: node.name,
          errorMessage: message,
        };
      }

      outputsByNodeId.set(node.id, parsed);
      setNodeStatus(node.id, "success");
      return { success: true };
    } catch (error) {
      if (isAbortError(error)) {
        setNodeStatus(node.id, "idle");
        return {
          success: false,
          canceled: true,
          failedNodeId: node.id,
          failedNodeName: node.name,
          errorMessage: "Execution stopped by user.",
        };
      }

      const message = error instanceof Error ? error.message : "Unknown execution error";
      setNodeStatus(node.id, "error", message);
      return {
        success: false,
        failedNodeId: node.id,
        failedNodeName: node.name,
        errorMessage: message,
      };
    }
  };

  const runRange = async (startIndex: number, endIndexExclusive: number): Promise<RunRangeResult> => {
    const state = useWorkflowStore.getState();
    const orderSnapshot = [...state.order];
    const boundedEnd = Math.min(endIndexExclusive, orderSnapshot.length);
    const executionController = new AbortController();
    activeExecutionAbortControllerRef.current = executionController;

    if (startIndex < 0 || startIndex > boundedEnd) {
      return {
        success: false,
        errorMessage: "Invalid start index for execution.",
      };
    }

    const dependencyPlan = buildDependencyExecutionOrder(orderSnapshot, state.nodes);
    if (dependencyPlan.hasCycle) {
      setStatusMessage("Circular reference detected. Remove cyclic references before running.");
      return {
        success: false,
        errorMessage: "Circular reference detected. Remove cyclic references before running.",
      };
    }

    const includedNodeIds = new Set<string>(orderSnapshot.slice(startIndex, boundedEnd));
    const executionOrder = dependencyPlan.orderedNodeIds.filter((nodeId) => includedNodeIds.has(nodeId));
    const plannedCallCounts = calculatePlannedCallCounts(executionOrder, state.nodes, includedNodeIds);
    const initialCallTargets: Record<string, PlannedCallCount> = {};
    const initialCallCounts: Record<string, number> = {};
    for (const nodeId of orderSnapshot) {
      initialCallTargets[nodeId] = plannedCallCounts.get(nodeId) ?? 0;
      initialCallCounts[nodeId] = 0;
    }
    setNodeCallTargets(initialCallTargets);
    setNodeCallCounts(initialCallCounts);

    const outputsByNodeId = new Map<string, unknown>();
    for (const nodeId of orderSnapshot) {
      const output = state.nodes[nodeId]?.output;
      if (output !== undefined) {
        outputsByNodeId.set(nodeId, output);
      }
    }

    const skippedNodeIds = new Set<string>();
    setStatusMessage("");
    setIsExecuting(true);

    try {
      for (const nodeId of executionOrder) {
        if (executionController.signal.aborted) {
          return {
            success: false,
            canceled: true,
            errorMessage: "Execution stopped by user.",
          };
        }

        if (skippedNodeIds.has(nodeId)) {
          continue;
        }

        const node = useWorkflowStore.getState().nodes[nodeId];
        if (!node) {
          continue;
        }

        if (!node.repeat.enabled) {
          const singleResult = await executeSingleNode(nodeId, outputsByNodeId, executionController.signal);
          if (!singleResult.success) {
            if (singleResult.canceled) {
              setStatusMessage("Execution stopped.");
            } else {
              setStatusMessage(
                `Execution stopped at ${singleResult.failedNodeName ?? "node"}: ${singleResult.errorMessage ?? "unknown error"}`,
              );
            }
            return singleResult;
          }
          continue;
        }

        const downstreamNodeIds = getReferencedDownstreamNodeIds(
          executionOrder,
          useWorkflowStore.getState().nodes,
          nodeId,
          includedNodeIds,
        );
        const repeatCount = Math.max(1, Math.floor(node.repeat.count));
        const loopCount = Math.max(0, Math.floor(node.repeat.loopCount));
        const repeatDelayMs = repeatIntervalToMs(Math.max(0, Math.floor(node.repeat.interval)), node.repeat.unit);
        let globalIteration = 0;

        for (let cycle = 0; loopCount === 0 || cycle < loopCount; cycle += 1) {
          for (let iteration = 0; iteration < repeatCount; iteration += 1) {
            if (globalIteration > 0 && repeatDelayMs > 0) {
              await sleepWithSignal(repeatDelayMs, executionController.signal);
            }

            const nodeResult = await executeSingleNode(nodeId, outputsByNodeId, executionController.signal);
            if (!nodeResult.success) {
              if (nodeResult.canceled) {
                setStatusMessage("Execution stopped.");
              } else {
                setStatusMessage(
                  `Execution stopped at ${nodeResult.failedNodeName ?? "node"}: ${nodeResult.errorMessage ?? "unknown error"}`,
                );
              }
              return nodeResult;
            }

            for (const downstreamNodeId of downstreamNodeIds) {
              const downstreamResult = await executeSingleNode(downstreamNodeId, outputsByNodeId, executionController.signal);
              if (!downstreamResult.success) {
                if (downstreamResult.canceled) {
                  setStatusMessage("Execution stopped.");
                } else {
                  setStatusMessage(
                    `Execution stopped at ${downstreamResult.failedNodeName ?? "node"}: ${downstreamResult.errorMessage ?? "unknown error"}`,
                  );
                }
                return downstreamResult;
              }
            }

            globalIteration += 1;
          }
        }

        for (const downstreamNodeId of downstreamNodeIds) {
          skippedNodeIds.add(downstreamNodeId);
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        return {
          success: false,
          canceled: true,
          errorMessage: "Execution stopped by user.",
        };
      }
      throw error;
    } finally {
      if (activeExecutionAbortControllerRef.current === executionController) {
        activeExecutionAbortControllerRef.current = null;
      }
      setIsExecuting(false);
    }

    return { success: true };
  };

  const executeAll = async () => {
    await runRange(0, order.length);
  };

  const stopAllActiveNodes = () => {
    const controller = activeExecutionAbortControllerRef.current;
    if (!controller) {
      return;
    }

    controller.abort();
    setStatusMessage("Execution stopped.");
  };

  const clearExecutionCallStats = () => {
    setNodeCallCounts({});
    setNodeCallTargets({});
  };

  const executeFromSelected = async () => {
    if (!selectedNodeId) {
      setStatusMessage("Select a node first.");
      return;
    }

    const startIndex = order.indexOf(selectedNodeId);
    await runRange(startIndex, order.length);
  };

  return (
    <div className="min-h-screen p-6 text-foreground">
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <PanelRightClose className="h-8 w-8 text-primary" />
              <h1 className="text-[1.5rem] font-bold tracking-wide text-primary">DASH</h1>
              <span className="text-sm text-foreground/50">Solana Workflow Builder</span>
            </div>

            <div className="flex items-center gap-2">
              <label htmlFor="network-select" className="text-xs font-semibold uppercase tracking-wide text-foreground/65">
                Network
              </label>
              <select
                id="network-select"
                value={network}
                onChange={(event) => setNetwork(event.target.value as RpcNetwork)}
                className="h-9 rounded-md border border-border px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
              >
                <option value="mainnet">Mainnet</option>
                <option value="devnet">Devnet</option>
                <option value="testnet" disabled={gatekeeperEnabled}>
                  Testnet
                </option>
              </select>
            </div>
          </div>
        </header>

        <section className="panel-surface rounded-xl p-4">
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md px-1 py-1 text-left transition-colors duration-150 cursor-pointer"
            onClick={() => setShowInstructions((value) => !value)}
            aria-expanded={showInstructions}
            aria-controls="tutorial-panel"
            aria-label={showInstructions ? "Hide tutorial instructions" : "Show tutorial instructions"}
          >
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              <h2 className="text-sm font-semibold tracking-wide text-foreground">Tutorial</h2>
            </div>
            <ChevronDown
              className={`h-4 w-4 text-foreground/70 transition-transform duration-300 ${showInstructions ? "rotate-180" : ""}`}
            />
          </button>

          <div
            className={`grid transition-[grid-template-rows,opacity] duration-300 ease-in-out ${showInstructions ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
          >
            <div className="overflow-hidden">
              <div id="tutorial-panel" className="mt-3 grid gap-4 text-sm text-foreground/80">
                <div className="panel-tile rounded-lg p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wide text-primary">1. Configure Access</p>
                  <ol className="list-inside list-decimal space-y-1">
                    <li>Paste your Helius API key in the field below this tutorial.</li>
                    <li>Use the action icons on the right to run all nodes, run from the selected node, stop execution, or reset.</li>
                    <li>Use the export and import controls to save your flow and load it back.</li>
                  </ol>
                </div>

                <div className="panel-tile rounded-lg p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wide text-primary">2. Build Nodes</p>
                  <ol className="list-inside list-decimal space-y-1">
                    <li>Click `Add Node`, search a method, and insert it into the workflow.</li>
                    <li>Drag nodes around the graph canvas to organize your flow visually.</li>
                    <li>Click the gear icon on a node to open settings, outputs, and run controls.</li>
                  </ol>
                </div>

                <div className="panel-tile rounded-lg p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wide text-primary">3. Set Parameters</p>
                  <ol className="list-inside list-decimal space-y-1">
                    <li>For known schemas, fill fields in the Input pane using JSON literals.</li>
                    <li>Switch a field to `Reference` to map data from a previous node output path.</li>
                    <li>For unknown schemas, enter raw JSON array params directly.</li>
                  </ol>
                </div>

                <div className="panel-tile rounded-lg p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wide text-primary">4. Execute and Inspect</p>
                  <ol className="list-inside list-decimal space-y-1">
                    <li>Run a single node with `Run Node` or a sequence with `Run From Here` in node settings.</li>
                    <li>Use the node settings dialog output pane to inspect responses and errors.</li>
                    <li>Status badges show `idle`, `running`, `success`, or `error` per node.</li>
                  </ol>
                </div>

                <div className="panel-tile rounded-lg p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wide text-primary">5. Troubleshooting</p>
                  <ol className="list-inside list-decimal space-y-1">
                    <li>If you get `Invalid params`, check the parameter order and type for that method.</li>
                    <li>Optional values should be omitted when null to avoid RPC validation errors.</li>
                    <li>If a reference path fails, run the source node first and reselect the path.</li>
                  </ol>
                </div>

                <div className="panel-tile rounded-lg p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wide text-primary">6. Save and Share</p>
                  <ol className="list-inside list-decimal space-y-1">
                    <li>Export workflow JSON to checkpoint your setup before major changes.</li>
                    <li>Import it later to restore node order, params, and optional outputs.</li>
                    <li>Keep method names and node labels consistent for long-running flows.</li>
                  </ol>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="panel-surface rounded-xl p-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-64 flex-1">
              <label className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-foreground/65"><KeyRound className="mr-1 h-3 w-3 text-primary" />Helius API Key</label>
              <Input
                type="password"
                autoComplete="off"
                placeholder="Paste API key (session only)"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>

            <QuickTooltip content="Execute all">
              <Button
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => void executeAll()}
                disabled={isExecuting || order.length === 0}
                aria-label="Execute all"
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
            </QuickTooltip>
            <QuickTooltip content="Stop all active nodes">
              <Button
                size="sm"
                className="h-8 w-8 p-0"
                variant="destructive"
                onClick={stopAllActiveNodes}
                disabled={!isExecuting}
                aria-label="Stop all active nodes"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            </QuickTooltip>
            <QuickTooltip content="Execute from current node">
              <Button
                size="sm"
                className="h-8 w-8 p-0"
                variant="outline"
                onClick={() => void executeFromSelected()}
                disabled={isExecuting || order.length === 0}
                aria-label="Execute from current node"
              >
                <StepForward className="h-3.5 w-3.5" />
              </Button>
            </QuickTooltip>
            <QuickTooltip content="Reset">
              <Button
                size="sm"
                className="h-8 w-8 p-0"
                variant="secondary"
                onClick={() => {
                  clearOutputs();
                  clearExecutionCallStats();
                }}
                disabled={isExecuting || order.length === 0}
                aria-label="Reset"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </QuickTooltip>

            <ImportExport
              includeOutputs={includeOutputsOnExport}
              onIncludeOutputsChange={setIncludeOutputsOnExport}
              onExport={(includeOutputs) => exportWorkflow(includeOutputs)}
              onImport={importWorkflow}
            />
          </div>

          {statusMessage ? <p className="mt-3 text-xs text-foreground/80">{statusMessage}</p> : null}
        </section>

        <div>
          <div className="flex justify-end gap-2">
            <QuickTooltip
              content={
                gatekeeperEnabled
                  ? "Gatekeeper enabled. JSON-RPC uses https://beta.helius-rpc.com."
                  : "Gatekeeper disabled."
              }
            >
              <Button
                size="sm"
                variant="outline"
                className={gatekeeperEnabled ? "h-8 px-3 border-primary text-primary" : "h-8 px-3 text-foreground/60"}
                onClick={() => setGatekeeperEnabled((value) => !value)}
                aria-label="Toggle Gatekeeper endpoint"
              >
                {gatekeeperEnabled ? (
                  <ToggleRight className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <ToggleLeft className="h-3.5 w-3.5 text-foreground/50" />
                )}
                (New) Gatekeeper ✨
              </Button>
            </QuickTooltip>
            <QuickTooltip content="Help me build">
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-3"
                onClick={() =>
                  setShowBotPanel((value) => {
                    const next = !value;
                    if (next) {
                      setShowMethodPicker(false);
                    }
                    return next;
                  })
                }
                aria-label={showBotPanel ? "Close bot panel" : "Open bot panel"}
              >
                <BotMessageSquare className="h-3.5 w-3.5" />
                Help Me Build
              </Button>
            </QuickTooltip>
            <QuickTooltip content={showMethodPicker ? "Close method picker" : "Add a new node"}>
              <Button
                size="sm"
                onClick={() =>
                  setShowMethodPicker((value) => {
                    const next = !value;
                    if (next) {
                      setShowBotPanel(false);
                    }
                    return next;
                  })
                }
                aria-label={showMethodPicker ? "Close method picker" : "Add a new node"}
              >
                <Plus className="h-3.5 w-3.5" />
                Add Node
              </Button>
            </QuickTooltip>
          </div>

          <div
            className={`grid transition-[grid-template-rows,opacity,margin-top] duration-300 ease-in-out ${showBotPanel ? "mt-3 grid-rows-[1fr] opacity-100" : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"}`}
            aria-hidden={!showBotPanel}
          >
            <div className="overflow-hidden">
              <section
                className={`panel-surface w-full rounded-xl p-4 transition-transform duration-300 ease-in-out ${showBotPanel ? "translate-y-0" : "-translate-y-2"}`}
              >
                <div className="space-y-3">
                  <div className="h-[220px] space-y-3 overflow-y-auto px-1 py-2">
                    {botMessages.length === 0 ? (
                      <p className="text-sm text-foreground/50">Tell me what you want to do. 🤖</p>
                    ) : (
                      botMessages.map((message, index) => (
                        <div
                          key={`${message.role}-${index}-${message.text}`}
                          className={message.role === "user" ? "flex justify-end" : "flex justify-start"}
                        >
                          {message.role === "assistant" && message.plan ? (
                            <div className="w-fit max-w-[75%] space-y-1 text-sm leading-6 text-foreground">
                              <p className="text-justify">
                                In order to achieve &quot;{message.plan.task}&quot;, you will have to call the following:
                              </p>
                              {message.plan.methods.map((method, methodIndex) => (
                                <p key={`${method}-${methodIndex}`} className="font-semibold text-primary">
                                  {method}
                                </p>
                              ))}
                              {message.plan.requiredArguments.length > 0 ? (
                                <p className="pt-1 text-justify">If necessary, I will require the following arguments:</p>
                              ) : null}
                              {message.plan.requiredArguments.map((argument, argIndex) => (
                                <p key={`${argument}-${argIndex}`} className="font-semibold text-primary">
                                  {argument}
                                </p>
                              ))}
                              <p className="pt-1 text-justify text-foreground/85">{message.text}</p>
                            </div>
                          ) : (
                            <p
                              className={`w-fit max-w-[75%] text-sm leading-6 ${message.role === "user" ? "text-justify italic [color:var(--text-dim)]" : "text-justify text-foreground"}`}
                            >
                              {message.text}
                            </p>
                          )}
                        </div>
                      ))
                    )}
                    {isBotTesting ? (
                      <div className="flex justify-start">
                        <p className="text-sm text-foreground/60">Testing workflow...</p>
                      </div>
                    ) : null}
                    {isBotReplying && !isBotTesting ? (
                      <div className="flex justify-start">
                        <p className="text-sm text-foreground/60">Thinking...</p>
                      </div>
                    ) : null}
                  </div>
                  <form className="flex items-center gap-2" onSubmit={handleBotSubmit}>
                    <Input
                      value={botInput}
                      onChange={(event) => setBotInput(event.target.value)}
                      placeholder={
                        !hasHeliusApiKey
                          ? "Add Helius API key to use assistant..."
                          : isBotTesting || isExecuting
                            ? "Assistant is testing workflow..."
                            : "Type your message..."
                      }
                      disabled={isBotInputDisabled}
                    />
                    <QuickTooltip content="Send">
                      <Button
                        type="submit"
                        aria-label="Send message"
                        className="h-9 w-9 p-0"
                        disabled={isBotInputDisabled || !botInput.trim()}
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    </QuickTooltip>
                  </form>
                </div>
              </section>
            </div>
          </div>
        </div>

        <div
          className={`grid transition-[grid-template-rows,opacity,margin-top] duration-300 ease-in-out ${showMethodPicker ? "mt-3 grid-rows-[1fr] opacity-100" : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"}`}
          aria-hidden={!showMethodPicker}
        >
          <div className="overflow-hidden">
            <section
              className={`panel-surface rounded-xl border border-border p-4 transition-transform duration-300 ease-in-out ${showMethodPicker ? "translate-y-0" : "-translate-y-2"}`}
            >
              <div className="space-y-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-foreground/50" />
                  <Input
                    className="pl-8"
                    value={methodQuery}
                    onChange={(event) => setMethodQuery(event.target.value)}
                    placeholder="Search methods in selected category"
                  />
                </div>

                <div className="grid h-[460px] gap-3 md:grid-cols-3">
                  <div className="min-h-0 rounded-lg border border-border bg-background/60">
                    <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-foreground/70">
                      Categories
                    </div>
                    <div className="h-[calc(460px-37px)] overflow-auto p-2">
                      <ul className="space-y-1">
                        {methodCategories.map((category) => (
                          <li key={category.id}>
                            <Button
                              className="w-full justify-start"
                              variant={selectedCategory?.id === category.id ? "default" : "secondary"}
                              size="sm"
                              onClick={() => {
                                setSelectedMethodCategoryId(category.id);
                                setSelectedMethod(undefined);
                              }}
                              aria-label={`Select ${category.label} category`}
                            >
                              <span className="truncate">{category.label}</span>
                              <span className="ml-auto text-[11px] opacity-80">{category.methods.length}</span>
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="min-h-0 rounded-lg border border-border bg-background/60">
                    <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-foreground/70">
                      Methods
                    </div>
                    <div className="h-[calc(460px-37px)] overflow-auto p-2">
                      {filteredMethods.length === 0 ? (
                        <p className="p-2 text-xs text-foreground/65">
                          {selectedCategory?.methods.length === 0
                            ? "No methods in this category yet."
                            : "No methods match your search."}
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {filteredMethods.map((method) => (
                            <li key={method}>
                              <Button
                                className="w-full justify-start"
                                variant={activeMethod === method ? "default" : "secondary"}
                                size="sm"
                                onClick={() => setSelectedMethod(method)}
                                aria-label={`Select ${method}`}
                              >
                                <span className="truncate">{method}</span>
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  <div className="min-h-0 rounded-lg border border-border bg-background/60">
                    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-foreground/70">Method Details</span>
                      <Button
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => {
                          if (!activeMethod) {
                            return;
                          }
                          addNode(activeMethod);
                          setMethodQuery("");
                          setShowMethodPicker(false);
                        }}
                        disabled={!activeMethod}
                        aria-label={activeMethod ? `Add ${activeMethod} node` : "Add selected method node"}
                      >
                        <Plus className="h-3 w-3" />
                        Add Node
                      </Button>
                    </div>
                    <div className="h-[calc(460px-37px)] overflow-auto p-3">
                      {!activeMethod ? (
                        <p className="text-xs text-foreground/65">
                          Select a method to see input details and add it as a node.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          <div>
                            <p className="text-sm font-semibold text-foreground">{activeMethod}</p>
                            <p className="text-xs text-foreground/65">
                              Schema: {activeMethodEntry?.schema ?? "unknown"}
                            </p>
                            <p className="text-xs text-foreground/65">
                              Request:{" "}
                              {activeMethodEntry?.transport === "custom"
                                ? "Local custom node"
                                : activeMethodEntry?.transport === "http"
                                  ? `HTTP ${activeMethodEntry.http?.method ?? "GET"}`
                                  : "JSON-RPC POST"}
                            </p>
                          </div>

                          {activeMethodEntry?.docsUrl ? (
                            <a
                              href={activeMethodEntry.docsUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex text-xs text-primary hover:underline"
                            >
                              Open docs
                            </a>
                          ) : null}

                          {activeMethodEntry?.params?.kind === "table" ? (
                            <div className="space-y-2">
                              <p className="text-xs font-semibold uppercase tracking-wide text-foreground/70">Inputs</p>
                              <ul className="space-y-2">
                                {activeMethodEntry.params.fields.map((field) => (
                                  <li key={`${activeMethod}-${field.name}`} className="rounded-md border border-border bg-background/50 p-2">
                                    <p className="text-xs font-medium text-foreground">{field.name}</p>
                                    <p className="text-[11px] text-foreground/65">
                                      {(field.type ?? "unknown").toLowerCase()} / {field.required ? "required" : "optional"}
                                    </p>
                                    {field.description ? <p className="mt-1 text-[11px] text-foreground/70">{field.description}</p> : null}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <p className="text-xs font-semibold uppercase tracking-wide text-foreground/70">Inputs</p>
                              <p className="text-xs text-foreground/70">
                                This method uses a raw JSON params array in the node editor.
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>

        <section className="space-y-3">
          {orderedNodes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-background/40 p-8 text-center text-sm text-foreground/70">
              Add your first RPC node to begin building the workflow.
            </div>
          ) : (
            <NodeGraphCanvas
              nodes={orderedNodes}
              selectedNodeId={selectedNodeId}
              connections={graphConnections}
              callCountsByNodeId={nodeCallCounts}
              callTargetsByNodeId={callTargetByNodeId}
              executionOrderByNodeId={executionOrderByNodeId}
              onSelectNode={selectNode}
              onOpenNodeSettings={(nodeId) => {
                setEditingNodeId(nodeId);
                selectNode(nodeId);
              }}
              onDeleteNode={(nodeId) => {
                removeNode(nodeId);
                if (editingNodeId === nodeId) {
                  setEditingNodeId(undefined);
                }
              }}
              onMoveNode={(nodeId, position) => setNodePosition(nodeId, position)}
            />
          )}
        </section>
      </div>
      <NodeSettingsDialog
        open={Boolean(editingNode)}
        node={editingNode}
        methodEntry={editingNode ? getMethodEntry(editingNode.method) : undefined}
        sourceNodes={editingNodeSourceNodes}
        callCount={editingNode ? (nodeCallCounts[editingNode.id] ?? 0) : 0}
        callTarget={
          editingNode
            ? Object.prototype.hasOwnProperty.call(callTargetByNodeId, editingNode.id)
              ? callTargetByNodeId[editingNode.id]
              : 0
            : 0
        }
        onClose={() => setEditingNodeId(undefined)}
        onRename={(name) => {
          if (!editingNode) {
            return;
          }
          renameNode(editingNode.id, name);
        }}
        onDelete={() => {
          if (!editingNode) {
            return;
          }
          removeNode(editingNode.id);
          setEditingNodeId(undefined);
        }}
        onRunNode={() => {
          if (!editingNode || editingNodeIndex < 0) {
            return;
          }
          void runRange(editingNodeIndex, editingNodeIndex + 1);
        }}
        onRunFromHere={() => {
          if (!editingNode || editingNodeIndex < 0) {
            return;
          }
          void runRange(editingNodeIndex, order.length);
        }}
        onParamChange={(paramName, value) => {
          if (!editingNode) {
            return;
          }
          setParamValue(editingNode.id, paramName, value);
        }}
        onRawParamsChange={(raw) => {
          if (!editingNode) {
            return;
          }
          setRawParamsJson(editingNode.id, raw);
        }}
        onRepeatChange={(value) => {
          if (!editingNode) {
            return;
          }
          setNodeRepeat(editingNode.id, value);
        }}
      />
    </div>
  );
}
