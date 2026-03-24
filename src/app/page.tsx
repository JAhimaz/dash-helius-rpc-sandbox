"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BotMessageSquare,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  PanelRightClose,
  Plus,
  Download,
  Send,
  Search,
  SquareChevronRight,
  ToggleLeft,
  ToggleRight,
  FileDown,
} from "lucide-react";
import { NodeGraphCanvas, type NodeGraphConnection } from "@/components/NodeGraphCanvas";
import { parseWorkflowImport } from "@/lib/workflowSchema";
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

interface ConsoleLogEntry {
  timestamp: string;
  nodeName: string;
  output: unknown;
}

function formatTimestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}:${ms}`;
}

function stringifyConsoleOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
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
const DEFAULT_HELIUS_WS_URLS: Record<RpcNetwork, string> = {
  mainnet: "wss://mainnet.helius-rpc.com",
  devnet: "wss://devnet.helius-rpc.com",
  testnet: "wss://testnet.helius-rpc.com",
};
const GATEKEEPER_RPC_URL = "https://beta.helius-rpc.com/";
const SESSION_STORAGE_API_KEY = "dash-flow:api-key";

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

/**
 * Run user-provided JS in a sandboxed iframe with no access to the parent
 * page, cookies, localStorage, or same-origin content. Communication happens
 * via postMessage with structured-clone-safe data only.
 */
function runSandboxedScript(code: string, input: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    // allow-scripts lets JS run; no allow-same-origin means the iframe
    // cannot access the parent page, cookies, localStorage, etc.
    iframe.sandbox.add("allow-scripts");
    iframe.style.display = "none";
    document.body.appendChild(iframe);

    const TIMEOUT_MS = 10_000;
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      iframe.remove();
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Script timed out (10s limit)."));
    }, TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      clearTimeout(timer);
      cleanup();
      const { ok, value, error } = event.data as { ok: boolean; value?: unknown; error?: string };
      if (ok) {
        resolve(value);
      } else {
        reject(new Error(error ?? "Script execution failed."));
      }
    };

    window.addEventListener("message", onMessage);

    const script = `
      <script>
        "use strict";
        (function() {
          // Capture real parent ref before sandboxing
          var _host = window.parent;
          // Block user code from accessing parent/top
          try { Object.defineProperty(window, "parent", { value: window }); } catch {}
          try { Object.defineProperty(window, "top", { value: window }); } catch {}

          window.addEventListener("message", function(e) {
            try {
              var fn = new Function("input", e.data.code);
              var result = fn(e.data.input);
              _host.postMessage({ ok: true, value: result }, "*");
            } catch (err) {
              _host.postMessage({ ok: false, error: err.message || String(err) }, "*");
            }
          });
        })();
      <\/script>
    `;

    iframe.srcdoc = script;
    iframe.onload = () => {
      if (settled) return;
      iframe.contentWindow?.postMessage({ code, input }, "*");
    };
  });
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

function buildHeliusWebSocketUrl(apiKey: string, network: RpcNetwork): string {
  const baseUrl = DEFAULT_HELIUS_WS_URLS[network];
  const url = new URL(baseUrl);
  if (apiKey.trim()) {
    url.searchParams.set("api-key", apiKey.trim());
  }
  return url.toString();
}

function getMethodCategoryId(entry: MethodRegistryEntry): MethodCategoryId {
  return entry.category ?? "solana-rpc-apis";
}

/**
 * Build a minimal nested object so that getByPath(wrapper, originalPath)
 * resolves to `value`.  [] tokens in the path are stripped — getByPath
 * skips [] on non-arrays, so the navigation still works.
 */
function buildNestedWrapper(path: string, value: unknown): unknown {
  const keys = path
    .replace(/\[\]/g, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  if (keys.length === 0) return value;
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  for (let i = 0; i < keys.length - 1; i += 1) {
    current[keys[i]] = {};
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return root;
}

function getCustomNodeOutput(node: WorkflowNode, outputsByNodeId: Map<string, unknown>): unknown {
  const valueParam = node.params.find((param) => param.name === "value");
  if (!valueParam) {
    return null;
  }

  return resolveParamValue(valueParam.value, outputsByNodeId);
}

function getListReference(
  node: WorkflowNode,
  nodes: Record<string, WorkflowNode>,
): { paramName: string; listNodeId: string; path: string } | null {
  // Filter receives the full array and handles it internally
  if (node.method === "Filter") return null;

  for (const param of node.params) {
    if (param.value.type === "ref") {
      const refNode = nodes[param.value.nodeId];
      // Explicit List node reference
      if (refNode?.method === "List") {
        return { paramName: param.name, listNodeId: param.value.nodeId, path: param.value.path };
      }
      // [each] path on any node — treat the referenced node as a list source
      if (param.value.path.includes("[]")) {
        return { paramName: param.name, listNodeId: param.value.nodeId, path: param.value.path };
      }
    }
  }
  return null;
}

function getAllReferencedNodeIds(node: WorkflowNode): string[] {
  const refs: string[] = [];
  for (const param of node.params) {
    if (param.value.type === "ref") {
      refs.push(param.value.nodeId);
    }
  }
  return refs;
}

function referencesAnyNode(node: WorkflowNode, nodeIds: Set<string>): boolean {
  return getAllReferencedNodeIds(node).some((id) => nodeIds.has(id));
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

    for (const sourceNodeId of getAllReferencedNodeIds(node)) {
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

function groupByExecutionLevel(
  orderedNodeIds: string[],
  nodes: Record<string, WorkflowNode>,
): string[][] {
  const nodeIdSet = new Set(orderedNodeIds);
  const depths = new Map<string, number>();

  function getDepth(nodeId: string, visited: Set<string>): number {
    if (depths.has(nodeId)) return depths.get(nodeId)!;
    if (visited.has(nodeId)) return 0;
    visited.add(nodeId);

    const node = nodes[nodeId];
    if (!node) return 0;

    let maxParentDepth = -1;
    for (const refId of getAllReferencedNodeIds(node)) {
      if (nodeIdSet.has(refId)) {
        maxParentDepth = Math.max(maxParentDepth, getDepth(refId, visited));
      }
    }

    const depth = maxParentDepth + 1;
    depths.set(nodeId, depth);
    return depth;
  }

  for (const nodeId of orderedNodeIds) {
    getDepth(nodeId, new Set());
  }

  const levels: string[][] = [];
  for (const nodeId of orderedNodeIds) {
    const depth = depths.get(nodeId) ?? 0;
    while (levels.length <= depth) {
      levels.push([]);
    }
    levels[depth].push(nodeId);
  }

  return levels;
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
  const setResetOnNewRun = useWorkflowStore((state) => state.setResetOnNewRun);
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
  const [showConsole, setShowConsole] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([]);
  const consoleEndRef = useRef<HTMLDivElement | null>(null);
  const emptyStateFileRef = useRef<HTMLInputElement | null>(null);
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
  const activeWebSocketsRef = useRef<Map<string, WebSocket>>(new Map());
  const aggregatorStateRef = useRef<Map<string, { accumulated: number; iterations: number }>>(new Map());

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleLogs]);

  const logToConsole = (nodeId: string, output: unknown) => {
    const node = useWorkflowStore.getState().nodes[nodeId];
    setConsoleLogs((prev) => [
      ...prev,
      {
        timestamp: formatTimestamp(),
        nodeName: node?.name ?? node?.method ?? nodeId,
        output,
      },
    ]);
  };

  const clearConsole = () => setConsoleLogs([]);

  const exportConsoleLog = () => {
    const lines = consoleLogs.map(
      (entry) => `${entry.timestamp} | ${entry.nodeName}\n${stringifyConsoleOutput(entry.output)}\n`,
    );
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dash-flow-console-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
    if (dependencyExecutionPlan.hasCycle) {
      const orderByNodeId: Record<string, number | null> = {};
      for (const node of orderedNodes) {
        orderByNodeId[node.id] = null;
      }
      return orderByNodeId;
    }

    const nodeIdSet = new Set(dependencyExecutionPlan.orderedNodeIds);
    const depths: Record<string, number> = {};

    function getDepth(nodeId: string, visited: Set<string>): number {
      if (depths[nodeId] !== undefined) return depths[nodeId];
      if (visited.has(nodeId)) return 1;
      visited.add(nodeId);

      const node = nodes[nodeId];
      if (!node) { depths[nodeId] = 1; return 1; }

      let maxParentDepth = 0;
      for (const refId of getAllReferencedNodeIds(node)) {
        if (nodeIdSet.has(refId)) {
          maxParentDepth = Math.max(maxParentDepth, getDepth(refId, visited));
        }
      }

      depths[nodeId] = maxParentDepth + 1;
      return depths[nodeId];
    }

    for (const nodeId of dependencyExecutionPlan.orderedNodeIds) {
      getDepth(nodeId, new Set());
    }

    return depths;
  }, [dependencyExecutionPlan, orderedNodes, nodes]);
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
          id: `${param.value.nodeId}-${node.id}-${param.name}-${param.value.path}`,
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
        id: "websockets",
        label: "WebSockets",
        methods: methodEntries
          .filter((entry) => getMethodCategoryId(entry) === "websockets")
          .map((entry) => entry.method),
      },
      {
        id: "priority-fee",
        label: "Priority Fee",
        methods: methodEntries
          .filter((entry) => getMethodCategoryId(entry) === "priority-fee")
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
            clearConsole();
            aggregatorStateRef.current.clear();
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
                clearConsole();
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
        let output: unknown;

        if (node.method === "Value Aggregator") {
          const valueParam = node.params.find((p) => p.name === "value");
          const operationParam = node.params.find((p) => p.name === "operation");
          const initialValueParam = node.params.find((p) => p.name === "initialValue");

          const incomingValue = Number(valueParam ? resolveParamValue(valueParam.value, outputsByNodeId) : 0) || 0;
          const operation = String(operationParam ? resolveParamValue(operationParam.value, outputsByNodeId) : "add");
          const initialValue = Number(initialValueParam ? resolveParamValue(initialValueParam.value, outputsByNodeId) : 0) || 0;

          const state = aggregatorStateRef.current.get(node.id) ?? { accumulated: initialValue, iterations: 0 };

          const AGG_MAX = 1e15;
          const AGG_MIN = -1e15;

          switch (operation) {
            case "add":
              state.accumulated += incomingValue;
              break;
            case "subtract":
              state.accumulated -= incomingValue;
              break;
            case "multiply":
              state.accumulated *= incomingValue;
              break;
            case "divide":
              state.accumulated = incomingValue !== 0 ? state.accumulated / incomingValue : state.accumulated;
              break;
            default:
              state.accumulated += incomingValue;
          }

          state.accumulated = Math.min(AGG_MAX, Math.max(AGG_MIN, state.accumulated));
          state.accumulated = Number(state.accumulated.toFixed(12));
          state.iterations += 1;
          aggregatorStateRef.current.set(node.id, state);

          output = {
            accumulated: state.accumulated,
            lastValue: incomingValue,
            operation,
            iterations: state.iterations,
          };
        } else if (node.method === "Arithmetic") {
          const inputParam = node.params.find((p) => p.name === "input");
          const operationParam = node.params.find((p) => p.name === "operation");
          const operandParam = node.params.find((p) => p.name === "operand");

          const inputValue = Number(inputParam ? resolveParamValue(inputParam.value, outputsByNodeId) : 0) || 0;
          const operation = String(operationParam ? resolveParamValue(operationParam.value, outputsByNodeId) : "add");
          const operand = Number(operandParam ? resolveParamValue(operandParam.value, outputsByNodeId) : 0) || 0;

          const ARITH_MAX = 1e15;
          const ARITH_MIN = -1e15;

          let result: number;
          switch (operation) {
            case "add":
              result = inputValue + operand;
              break;
            case "subtract":
              result = inputValue - operand;
              break;
            case "multiply":
              result = inputValue * operand;
              break;
            case "divide":
              result = operand !== 0 ? inputValue / operand : inputValue;
              break;
            default:
              result = inputValue;
          }

          result = Math.min(ARITH_MAX, Math.max(ARITH_MIN, result));
          result = Number(result.toFixed(12));

          output = { input: inputValue, operation, operand, result };
        } else if (node.method === "Script") {
          const inputParam = node.params.find((p) => p.name === "input");
          const codeParam = node.params.find((p) => p.name === "code");

          const input = inputParam ? resolveParamValue(inputParam.value, outputsByNodeId) : null;
          const code = String(codeParam?.value.type === "literal" ? codeParam.value.value ?? "" : "");

          if (!code.trim()) {
            throw new Error("Script node has no code.");
          }

          output = await runSandboxedScript(code, input);
        } else if (node.method === "Filter") {
          const inputParam = node.params.find((p) => p.name === "input");
          const pathParam = node.params.find((p) => p.name === "path");
          const operatorParam = node.params.find((p) => p.name === "operator");
          const compareToParam = node.params.find((p) => p.name === "compareTo");

          const inputVal = inputParam ? resolveParamValue(inputParam.value, outputsByNodeId) : null;
          const path = String(pathParam?.value.type === "literal" ? pathParam.value.value ?? "" : "");
          const operator = String(operatorParam ? resolveParamValue(operatorParam.value, outputsByNodeId) : "==");
          const compareVal = compareToParam ? resolveParamValue(compareToParam.value, outputsByNodeId) : null;

          if (!Array.isArray(inputVal)) {
            output = [];
          } else {
            output = inputVal.filter((item) => {
              const testVal = path ? getByPath(item, path) : item;
              const valStr = testVal === null || testVal === undefined ? "" : String(testVal).trim();
              const cmpStr = compareVal === null || compareVal === undefined ? "" : String(compareVal).trim();
              switch (operator) {
                case ">": return Number(testVal) > Number(compareVal);
                case "<": return Number(testVal) < Number(compareVal);
                case ">=": return Number(testVal) >= Number(compareVal);
                case "<=": return Number(testVal) <= Number(compareVal);
                case "!=": return valStr !== cmpStr;
                case "==": return valStr === cmpStr;
                case "contains": return JSON.stringify(testVal).includes(String(compareVal ?? ""));
                case "not contains": return !JSON.stringify(testVal).includes(String(compareVal ?? ""));
                case "is null": return testVal === null || testVal === undefined;
                case "is not null": return testVal !== null && testVal !== undefined;
                default: return false;
              }
            });
          }
        } else {
          output = getCustomNodeOutput(node, outputsByNodeId);
        }

        if (node.method === "Script" && (output === null || output === undefined)) {
          outputsByNodeId.set(node.id, output);
          return { success: true };
        }

        setNodeOutput(node.id, output);
        logToConsole(node.id, output);
        outputsByNodeId.set(node.id, output);
        setNodeStatus(node.id, "success");
        return { success: true };
      }

      if (transport === "websocket") {
        const subscriptionMethodParam = node.params.find((p) => p.name === "subscriptionMethod");

        const rawSubscriptionMethod = subscriptionMethodParam
          ? String(resolveParamValue(subscriptionMethodParam.value, outputsByNodeId) ?? "")
          : "";
        const subscriptionMethod = rawSubscriptionMethod === "__custom_input__" ? "" : rawSubscriptionMethod;

        if (!subscriptionMethod) {
          throw new Error("subscriptionMethod is required for WebSocket nodes.");
        }

        const skipParams = new Set(["subscriptionMethod", "extraParams"]);
        const subscriptionParams: unknown[] = [];
        const optionsObj: Record<string, unknown> = {};

        for (const param of node.params) {
          if (skipParams.has(param.name)) continue;
          const resolved = resolveParamValue(param.value, outputsByNodeId);
          if (resolved === null || resolved === undefined || resolved === "" || resolved === "__custom_input__") continue;

          const WS_PRIMARY_PARAMS = new Set(["pubkey", "programId", "signature", "filter"]);
          if (WS_PRIMARY_PARAMS.has(param.name)) {
            let parsed = resolved;
            if (typeof resolved === "string") {
              try { parsed = JSON.parse(resolved); } catch { /* keep as string */ }
            }
            if (subscriptionParams.length === 0) {
              subscriptionParams.push(parsed);
            }
          } else {
            let parsed = resolved;
            if (typeof resolved === "string") {
              try { parsed = JSON.parse(resolved); } catch { /* keep as string */ }
            }
            optionsObj[param.name] = parsed;
          }
        }

        const extraParamsParam = node.params.find((p) => p.name === "extraParams");
        if (extraParamsParam) {
          const raw = resolveParamValue(extraParamsParam.value, outputsByNodeId);
          if (raw && raw !== "" && raw !== "__custom_input__") {
            let parsed: unknown = raw;
            if (typeof raw === "string") {
              try { parsed = JSON.parse(raw); } catch { /* ignore */ }
            }
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              Object.assign(optionsObj, parsed);
            }
          }
        }

        if (Object.keys(optionsObj).length > 0) {
          subscriptionParams.push(optionsObj);
        }

        const wsUrl = buildHeliusWebSocketUrl(apiKeyValue, network);
        const ws = new WebSocket(wsUrl);
        activeWebSocketsRef.current.set(node.id, ws);

        const cleanup = () => {
          activeWebSocketsRef.current.delete(node.id);
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        };

        const onAbort = () => {
          cleanup();
          setNodeStatus(node.id, "idle");
        };

        signal.addEventListener("abort", onAbort, { once: true });

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: subscriptionMethod,
              params: subscriptionParams,
            }),
          );
        };

        ws.onmessage = async (event) => {
          if (signal.aborted) return;

          try {
            const data = JSON.parse(String(event.data));

            // Skip subscription confirmation responses
            if (data.result !== undefined && !data.method) {
              return;
            }

            const output = data.params?.result ?? data;
            setNodeOutput(node.id, output);
            logToConsole(node.id, output);
            outputsByNodeId.set(node.id, output);

            setNodeCallCounts((prev) => ({
              ...prev,
              [node.id]: (prev[node.id] ?? 0) + 1,
            }));

            // Trigger all downstream nodes on each message
            const state = useWorkflowStore.getState();
            const allNodeIds = [...state.order];
            const includedNodeIds = new Set(allNodeIds);
            const downstreamNodeIds = getReferencedDownstreamNodeIds(
              allNodeIds,
              state.nodes,
              node.id,
              includedNodeIds,
            );

            for (const downstreamNodeId of downstreamNodeIds) {
              if (signal.aborted) break;
              await executeSingleNode(downstreamNodeId, outputsByNodeId, signal);
            }
          } catch {
            // ignore unparseable messages
          }
        };

        ws.onerror = () => {
          if (signal.aborted) return;
          signal.removeEventListener("abort", onAbort);
          cleanup();
          setNodeStatus(node.id, "error", "WebSocket connection error.");
        };

        ws.onclose = (event) => {
          if (signal.aborted) return;
          signal.removeEventListener("abort", onAbort);
          cleanup();
          if (event.wasClean) {
            setNodeStatus(node.id, "success");
          } else {
            setNodeStatus(node.id, "error", `WebSocket closed unexpectedly (code ${event.code}).`);
          }
        };

        // Return immediately — WebSocket runs in background, doesn't block execution
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
      logToConsole(node.id, parsed);

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

    // Reset aggregator state for Value Aggregator nodes that have resetOnNewRun enabled
    for (const nodeId of orderSnapshot) {
      const node = state.nodes[nodeId];
      if (node?.method === "Value Aggregator" && node.resetOnNewRun) {
        aggregatorStateRef.current.delete(nodeId);
      }
    }

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
      const levels = groupByExecutionLevel(executionOrder, state.nodes);

      for (const level of levels) {
        if (executionController.signal.aborted) {
          return {
            success: false,
            canceled: true,
            errorMessage: "Execution stopped by user.",
          };
        }

        const levelNodes = level.filter((nodeId) => !skippedNodeIds.has(nodeId));
        if (levelNodes.length === 0) continue;

        const executeNode = async (nodeId: string): Promise<RunRangeResult> => {
          const node = useWorkflowStore.getState().nodes[nodeId];
          if (!node) return { success: true };

          // Check if this node references a List node
          const listRef = getListReference(node, useWorkflowStore.getState().nodes);
          if (listRef) {
            const rawListOutput = outputsByNodeId.get(listRef.listNodeId);

            // Resolve the full path — getByPath handles [] tokens by mapping
            // over arrays recursively, which may produce nested arrays when the
            // path crosses multiple array levels.  Flatten so we iterate the
            // individual leaf values (e.g. each accountKey string, not an array
            // of arrays).
            let listArray: unknown[];
            const hasEach = listRef.path.includes("[]");
            if (hasEach) {
              const resolved = getByPath(rawListOutput, listRef.path);
              listArray = Array.isArray(resolved) ? (resolved as unknown[]).flat(Infinity) : resolved !== undefined ? [resolved] : [];
            } else {
              listArray = Array.isArray(rawListOutput) ? rawListOutput : [];
            }

            if (listArray.length === 0) {
              setNodeStatus(nodeId, "error", "List is empty.");
              return { success: false, failedNodeId: nodeId, failedNodeName: node.name, errorMessage: "List is empty." };
            }

            setNodeCallTargets((prev) => ({ ...prev, [nodeId]: listArray.length }));

            const downstreamNodeIds = getReferencedDownstreamNodeIds(
              executionOrder,
              useWorkflowStore.getState().nodes,
              nodeId,
              includedNodeIds,
            );

            const currentNodes = useWorkflowStore.getState().nodes;
            const postIterationMethods = new Set(["Arithmetic"]);
            const iterationDownstream = downstreamNodeIds.filter((id) => !postIterationMethods.has(currentNodes[id]?.method ?? ""));
            const postIterationDownstream = downstreamNodeIds.filter((id) => currentNodes[id]?.method === "Arithmetic");

            const originalListOutput = outputsByNodeId.get(listRef.listNodeId);

            for (let i = 0; i < listArray.length; i += 1) {
              if (executionController.signal.aborted) {
                return { success: false, canceled: true, errorMessage: "Execution stopped by user." };
              }

              if (hasEach) {
                // Build a minimal wrapper object so that
                // getByPath(wrapper, originalPath) resolves to the single item.
                // getByPath skips [] on non-arrays, so the navigation still works.
                const wrapper = buildNestedWrapper(listRef.path, listArray[i]);
                outputsByNodeId.set(listRef.listNodeId, wrapper);
              } else {
                outputsByNodeId.set(listRef.listNodeId, listArray[i]);
              }

              const result = await executeSingleNode(nodeId, outputsByNodeId, executionController.signal);
              if (!result.success) return result;

              // Skip downstream if output is null (filtered)
              const currentOutput = outputsByNodeId.get(nodeId);
              if (currentOutput === null || currentOutput === undefined) continue;

              for (const downstreamNodeId of iterationDownstream) {
                const dsResult = await executeSingleNode(downstreamNodeId, outputsByNodeId, executionController.signal);
                if (!dsResult.success) return dsResult;
                // If this downstream node returned null, skip the rest of the chain for this iteration
                const dsOutput = outputsByNodeId.get(downstreamNodeId);
                if (dsOutput === null || dsOutput === undefined) break;
              }
            }

            if (originalListOutput !== undefined) {
              outputsByNodeId.set(listRef.listNodeId, originalListOutput);
            }

            // Run Arithmetic nodes once after all iterations
            for (const downstreamNodeId of postIterationDownstream) {
              if (executionController.signal.aborted) {
                return { success: false, canceled: true, errorMessage: "Execution stopped by user." };
              }
              const dsResult = await executeSingleNode(downstreamNodeId, outputsByNodeId, executionController.signal);
              if (!dsResult.success) return dsResult;
            }

            for (const downstreamNodeId of downstreamNodeIds) {
              skippedNodeIds.add(downstreamNodeId);
            }

            return { success: true };
          }

          if (!node.repeat.enabled) {
            return executeSingleNode(nodeId, outputsByNodeId, executionController.signal);
          }

          const downstreamNodeIds = getReferencedDownstreamNodeIds(
            executionOrder,
            useWorkflowStore.getState().nodes,
            nodeId,
            includedNodeIds,
          );

          const repeatNodes = useWorkflowStore.getState().nodes;
          const repeatPostMethods = new Set(["Arithmetic"]);
          const repeatIterationDownstream = downstreamNodeIds.filter((id) => !repeatPostMethods.has(repeatNodes[id]?.method ?? ""));
          const repeatPostIterationDownstream = downstreamNodeIds.filter((id) => repeatNodes[id]?.method === "Arithmetic");

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
              if (!nodeResult.success) return nodeResult;

              const repeatCurrentOutput = outputsByNodeId.get(nodeId);
              if (repeatCurrentOutput !== null && repeatCurrentOutput !== undefined) {
                for (const downstreamNodeId of repeatIterationDownstream) {
                  const downstreamResult = await executeSingleNode(downstreamNodeId, outputsByNodeId, executionController.signal);
                  if (!downstreamResult.success) return downstreamResult;
                }
              }

              globalIteration += 1;
            }
          }

          // Run Arithmetic nodes once after all repeat iterations
          for (const downstreamNodeId of repeatPostIterationDownstream) {
            if (executionController.signal.aborted) {
              return { success: false, canceled: true, errorMessage: "Execution stopped by user." };
            }
            const dsResult = await executeSingleNode(downstreamNodeId, outputsByNodeId, executionController.signal);
            if (!dsResult.success) return dsResult;
          }

          for (const downstreamNodeId of downstreamNodeIds) {
            skippedNodeIds.add(downstreamNodeId);
          }

          return { success: true };
        };

        // Run all nodes at this level in parallel
        const results = await Promise.all(levelNodes.map(executeNode));

        for (const result of results) {
          if (!result.success) {
            if (result.canceled) {
              setStatusMessage("Execution stopped.");
            } else {
              setStatusMessage(
                `Execution stopped at ${result.failedNodeName ?? "node"}: ${result.errorMessage ?? "unknown error"}`,
              );
            }
            return result;
          }
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
      if (activeWebSocketsRef.current.size === 0) {
        setIsExecuting(false);
      }
    }

    return { success: true };
  };

  const executeAll = async () => {
    await runRange(0, order.length);
  };

  const stopAllActiveNodes = () => {
    const controller = activeExecutionAbortControllerRef.current;
    if (controller) {
      controller.abort();
      activeExecutionAbortControllerRef.current = null;
    }

    for (const [nodeId, ws] of activeWebSocketsRef.current.entries()) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      setNodeStatus(nodeId, "idle");
    }
    activeWebSocketsRef.current.clear();
    setIsExecuting(false);
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
      <div className="mx-auto max-w-6xl space-y-3">
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

            <div className="flex items-center gap-2">
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
              <QuickTooltip content={showConsole ? "Close console" : "Open console"}>
                <Button
                  size="sm"
                  variant="outline"
                  className={showConsole ? "h-8 px-3 border-primary text-primary" : "h-8 px-3 text-foreground/60"}
                  onClick={() =>
                    setShowConsole((value) => {
                      const next = !value;
                      if (next) {
                        setShowBotPanel(false);
                        setShowMethodPicker(false);
                        setShowInstructions(false);
                      }
                      return next;
                    })
                  }
                  aria-label={showConsole ? "Close console" : "Open console"}
                >
                  <SquareChevronRight className="h-3.5 w-3.5" />
                  Console
                </Button>
              </QuickTooltip>
              <QuickTooltip content={showInstructions ? "Close tutorial" : "Open tutorial"}>
                <Button
                  size="sm"
                  variant="outline"
                  className={showInstructions ? "h-8 px-3 border-primary text-primary" : "h-8 px-3 text-foreground/60"}
                  onClick={() =>
                    setShowInstructions((value) => {
                      const next = !value;
                      if (next) {
                        setShowBotPanel(false);
                        setShowMethodPicker(false);
                        setShowConsole(false);
                      }
                      return next;
                    })
                  }
                  aria-label={showInstructions ? "Close tutorial" : "Open tutorial"}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  Tutorial
                </Button>
              </QuickTooltip>
              {/* Help Me Build — disabled for now
              <QuickTooltip content="Help me build">
                <Button
                  size="sm"
                  variant="outline"
                  className={showBotPanel ? "h-8 px-3 border-primary text-primary" : "h-8 px-3 text-foreground/60"}
                  onClick={() =>
                    setShowBotPanel((value) => {
                      const next = !value;
                      if (next) {
                        setShowMethodPicker(false);
                        setShowConsole(false);
                        setShowInstructions(false);
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
              */}
              <QuickTooltip content={showMethodPicker ? "Close method picker" : "Add a new node"}>
                <Button
                  size="sm"
                  onClick={() =>
                    setShowMethodPicker((value) => {
                      const next = !value;
                      if (next) {
                        setShowBotPanel(false);
                        setShowConsole(false);
                        setShowInstructions(false);
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
          </div>

          {statusMessage ? <p className="mt-3 text-xs text-foreground/80">{statusMessage}</p> : null}
        </section>

        <div className={showBotPanel || showConsole || showMethodPicker || showInstructions ? "" : "!mt-0"}>
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

          <div
            className={`grid transition-[grid-template-rows,opacity,margin-top] duration-300 ease-in-out ${showInstructions ? "mt-3 grid-rows-[1fr] opacity-100" : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"}`}
            aria-hidden={!showInstructions}
          >
            <div className="overflow-hidden">
              <section
                className={`panel-surface w-full rounded-xl p-4 transition-transform duration-300 ease-in-out ${showInstructions ? "translate-y-0" : "-translate-y-2"}`}
              >
                <div className="grid gap-3 text-sm text-foreground/80 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="panel-tile rounded-lg p-3">
                    <p className="mb-2 text-xs font-semibold tracking-wide text-primary">1. Set Up</p>
                    <ol className="list-inside list-decimal space-y-1">
                      <li>Paste your Helius API key above.</li>
                      <li>Choose your network (Mainnet / Devnet).</li>
                      <li>Toggle Gatekeeper to route JSON-RPC via the beta endpoint.</li>
                    </ol>
                  </div>

                  <div className="panel-tile rounded-lg p-3">
                    <p className="mb-2 text-xs font-semibold tracking-wide text-primary">2. Build Nodes</p>
                    <ol className="list-inside list-decimal space-y-1">
                      <li>Click <strong>Add Node</strong>, search for a method, and insert it.</li>
                      <li>Drag nodes on the canvas to arrange your flow.</li>
                      <li>Click the gear icon on a node to open its settings.</li>
                    </ol>
                  </div>

                  <div className="panel-tile rounded-lg p-3">
                    <p className="mb-2 text-xs font-semibold tracking-wide text-primary">3. Configure Params</p>
                    <ol className="list-inside list-decimal space-y-1">
                      <li>Fill fields in the Input pane with JSON literals.</li>
                      <li>Switch a field to <strong>Reference</strong> to map output from another node.</li>
                      <li>For raw schemas, enter a JSON params array directly.</li>
                    </ol>
                  </div>

                  <div className="panel-tile rounded-lg p-3">
                    <p className="mb-2 text-xs font-semibold tracking-wide text-primary">4. Execute &amp; Inspect</p>
                    <ol className="list-inside list-decimal space-y-1">
                      <li>Use the canvas toolbar to run all, run from selected, stop, or reset.</li>
                      <li>Open node settings to inspect outputs and errors.</li>
                      <li>Status dots show idle, running, success, or error per node.</li>
                    </ol>
                  </div>

                  <div className="panel-tile rounded-lg p-3">
                    <p className="mb-2 text-xs font-semibold tracking-wide text-primary">5. Import &amp; Export</p>
                    <ol className="list-inside list-decimal space-y-1">
                      <li>Use the canvas toolbar icons to export or import workflow JSON.</li>
                      <li>Import is also available on the empty canvas before adding nodes.</li>
                      <li>Optionally include node outputs in exports.</li>
                    </ol>
                  </div>

                  <div className="panel-tile rounded-lg p-3">
                    <p className="mb-2 text-xs font-semibold tracking-wide text-primary">6. Troubleshooting</p>
                    <ol className="list-inside list-decimal space-y-1">
                      <li>Invalid params? Check parameter order and types for that method.</li>
                      <li>Omit optional values instead of sending null.</li>
                      <li>If a reference path fails, run the source node first.</li>
                    </ol>
                  </div>
                </div>
              </section>
            </div>
          </div>

          <div
            className={`grid transition-[grid-template-rows,opacity,margin-top] duration-300 ease-in-out ${showConsole ? "mt-3 grid-rows-[1fr] opacity-100" : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"}`}
            aria-hidden={!showConsole}
          >
            <div className="overflow-hidden">
              <section
                className={`panel-surface w-full rounded-xl border border-border p-4 transition-transform duration-300 ease-in-out ${showConsole ? "translate-y-0" : "-translate-y-2"}`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-foreground/70">Console</p>
                  <QuickTooltip content="Export log as .txt">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs text-foreground/60"
                      onClick={exportConsoleLog}
                      disabled={consoleLogs.length === 0}
                      aria-label="Export console log"
                    >
                      <Download className="mr-1 h-3 w-3" />
                      Export
                    </Button>
                  </QuickTooltip>
                </div>
                <div className="h-[260px] overflow-y-auto rounded-lg bg-foreground/5 p-3 font-mono text-xs">
                  {consoleLogs.length === 0 ? (
                    <p className="text-foreground/40">No output yet.</p>
                  ) : (
                    consoleLogs.map((entry, index) => (
                      <details key={`${entry.timestamp}-${index}`} className="mb-1 group">
                        <summary className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-foreground/5 select-none list-none">
                          <ChevronDown className="h-3 w-3 text-foreground/40 transition-transform group-open:rotate-0 -rotate-90" />
                          <span className="text-foreground/60">{entry.timestamp}</span>
                          <span className="font-semibold text-primary">{entry.nodeName}</span>
                        </summary>
                        <div className="relative mt-1 mb-2 ml-[18px]">
                          <button
                            type="button"
                            className="absolute right-2 top-2 rounded-md border border-border/50 bg-foreground/10 p-1 text-foreground/40 hover:text-foreground/80 transition-colors"
                            aria-label="Copy output"
                            onClick={(event) => {
                              const text = stringifyConsoleOutput(entry.output);
                              navigator.clipboard.writeText(text);
                              const btn = event.currentTarget;
                              const icon = btn.querySelector("[data-copy-icon]") as HTMLElement | null;
                              const check = btn.querySelector("[data-check-icon]") as HTMLElement | null;
                              if (icon) icon.style.display = "none";
                              if (check) check.style.display = "block";
                              setTimeout(() => {
                                if (icon) icon.style.display = "block";
                                if (check) check.style.display = "none";
                              }, 1500);
                            }}
                          >
                            <Copy data-copy-icon className="h-3 w-3" />
                            <Check data-check-icon className="h-3 w-3 text-success" style={{ display: "none" }} />
                          </button>
                          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-foreground/5 p-2.5 pr-8 text-foreground/80">
                            {stringifyConsoleOutput(entry.output)}
                          </pre>
                        </div>
                      </details>
                    ))
                  )}
                  <div ref={consoleEndRef} />
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

                  <div className="flex min-h-0 flex-col rounded-lg border border-border bg-background/60">
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
                    <div className="min-h-0 flex-1 overflow-auto p-3 pb-6">
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
                                : activeMethodEntry?.transport === "websocket"
                                  ? "WebSocket subscription"
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
            <div className="flex h-[680px] flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-background text-center">
              <p className="text-sm text-foreground/70">Add your first RPC node to begin building the workflow.</p>
              <div>
                <input
                  ref={emptyStateFileRef}
                  hidden
                  accept="application/json"
                  type="file"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void (async () => {
                        try {
                          const raw = await file.text();
                          const json = JSON.parse(raw) as unknown;
                          const parsed = parseWorkflowImport(json);
                          if (parsed.success) {
                            importWorkflow(parsed.data);
                          }
                        } catch { /* ignore invalid files */ }
                      })();
                    }
                    event.currentTarget.value = "";
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3"
                  onClick={() => emptyStateFileRef.current?.click()}
                >
                  <FileDown className="mr-1.5 h-3.5 w-3.5" />
                  Import Workflow
                </Button>
              </div>
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
              onMoveNode={setNodePosition}
              isExecuting={isExecuting}
              hasActiveWebSockets={activeWebSocketsRef.current.size > 0}
              onExecuteAll={() => void executeAll()}
              onStop={stopAllActiveNodes}
              onExecuteFromSelected={() => void executeFromSelected()}
              onReset={() => {
                clearOutputs();
                clearExecutionCallStats();
                clearConsole();
                aggregatorStateRef.current.clear();
              }}
              includeOutputsOnExport={includeOutputsOnExport}
              onIncludeOutputsChange={setIncludeOutputsOnExport}
              onExport={(includeOutputs) => exportWorkflow(includeOutputs)}
              onImport={importWorkflow}
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
        onResetOnNewRunChange={(value) => {
          if (!editingNode) return;
          setResetOnNewRun(editingNode.id, value);
        }}
        listNodeName={(() => {
          if (!editingNode) return undefined;
          const ref = getListReference(editingNode, nodes);
          return ref ? (nodes[ref.listNodeId]?.name ?? "List") : undefined;
        })()}
      />
    </div>
  );
}
