"use client";

import { type FormEvent, useMemo, useState } from "react";
import {
  BotMessageSquare,
  BookOpen,
  ChevronDown,
  KeyRound,
  Map as MapIcon,
  MessageSquareX,
  PanelRightClose,
  Play,
  Plus,
  Send,
  Search,
  StepForward,
} from "lucide-react";

import { ImportExport } from "@/components/ImportExport";
import { NodeMapModal } from "@/components/NodeMapModal";
import { NodeCard } from "@/components/NodeCard";
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
import type { WorkflowNode } from "@/store/workflowStore";

type RpcNetwork = "mainnet" | "devnet";

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
  failedNodeId?: string;
  failedNodeName?: string;
  errorMessage?: string;
}

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
};
const DEFAULT_HELIUS_HTTP_URLS: Record<RpcNetwork, string> = {
  mainnet: "https://api.helius.xyz",
  devnet: "https://api-devnet.helius.xyz",
};

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

      setByDotPath(options, field.name, value);
    });

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

function buildHeliusJsonRpcUrl(apiKey: string, network: RpcNetwork): string {
  const configured = process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
  const baseUrl = configured ?? DEFAULT_HELIUS_RPC_URLS[network];

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
      : entry.http.devnetBaseUrl ?? DEFAULT_HELIUS_HTTP_URLS.devnet;

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
  const reorderNodes = useWorkflowStore((state) => state.reorderNodes);
  const setParamValue = useWorkflowStore((state) => state.setParamValue);
  const setRawParamsJson = useWorkflowStore((state) => state.setRawParamsJson);
  const setNodeStatus = useWorkflowStore((state) => state.setNodeStatus);
  const setNodeOutput = useWorkflowStore((state) => state.setNodeOutput);
  const toggleOutputOpen = useWorkflowStore((state) => state.toggleOutputOpen);
  const clearOutputs = useWorkflowStore((state) => state.clearOutputs);
  const exportWorkflow = useWorkflowStore((state) => state.exportWorkflow);
  const importWorkflow = useWorkflowStore((state) => state.importWorkflow);
  const setIncludeOutputsOnExport = useWorkflowStore((state) => state.setIncludeOutputsOnExport);

  const [isExecuting, setIsExecuting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [showMethodPicker, setShowMethodPicker] = useState(false);
  const [showNodeMap, setShowNodeMap] = useState(false);
  const [showBotPanel, setShowBotPanel] = useState(false);
  const [isBotReplying, setIsBotReplying] = useState(false);
  const [isBotTesting, setIsBotTesting] = useState(false);
  const [botInput, setBotInput] = useState("");
  const [botMessages, setBotMessages] = useState<ChatMessage[]>([]);
  const [methodQuery, setMethodQuery] = useState("");
  const [selectedMethodCategoryId, setSelectedMethodCategoryId] = useState<MethodCategoryId>("solana-rpc-apis");
  const [selectedMethod, setSelectedMethod] = useState<string>();
  const [draggingNodeId, setDraggingNodeId] = useState<string>();
  const [showInstructions, setShowInstructions] = useState(false);
  const [network, setNetwork] = useState<RpcNetwork>("mainnet");

  const orderedNodes = useMemo(
    () => order.map((nodeId) => nodes[nodeId]).filter((node): node is WorkflowNode => Boolean(node)),
    [order, nodes],
  );

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
      const data = await requestChatPlan(nextMessages, "plan");

      const reply = data.reply?.trim() ? data.reply : "No response returned.";
      let assistantReply = reply;
      let assistantPlan: ChatPlanSummary | undefined;

      const proposals = extractProposals(data);
      const canAddNodes = Boolean(data.canAddNodes ?? data.canAddNode);

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

                assistantReply += repairRun.success
                  ? " Initial validation failed, then auto-correction succeeded."
                  : ` Auto-correction attempted but still failed at ${repairRun.failedNodeName ?? "a node"}: ${repairRun.errorMessage ?? "unknown error"}.`;
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

  const runRange = async (startIndex: number, endIndexExclusive: number): Promise<RunRangeResult> => {
    if (startIndex < 0) {
      return {
        success: false,
        errorMessage: "Invalid start index for execution.",
      };
    }

    let runResult: RunRangeResult = { success: true };
    const currentState = useWorkflowStore.getState();
    const outputsByNodeId = new Map<string, unknown>();

    for (const nodeId of currentState.order) {
      const output = currentState.nodes[nodeId]?.output;
      if (output !== undefined) {
        outputsByNodeId.set(nodeId, output);
      }
    }

    setStatusMessage("");
    setIsExecuting(true);

    try {
      for (let index = startIndex; index < endIndexExclusive; index += 1) {
        const nodeId = useWorkflowStore.getState().order[index];
        const node = useWorkflowStore.getState().nodes[nodeId];

        if (!node) {
          continue;
        }

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
            continue;
          }

          if (transport === "http") {
            if (!methodEntry?.http) {
              throw new Error(`Method ${node.method} is marked as HTTP but has no HTTP config.`);
            }

            const httpParams = getNodeHttpParams(node, outputsByNodeId);
            const url = buildHeliusHttpUrl(
              apiKeyValue,
              network,
              methodEntry,
              httpParams,
              methodEntry.http.method === "GET",
            );

            if (methodEntry.http.method === "POST") {
              response = await fetch(url, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                },
                body: JSON.stringify(httpParams),
              });
            } else {
              response = await fetch(url, {
                method: "GET",
              });
            }
          } else {
            const params = getNodeParams(node, outputsByNodeId);

            response = await fetch(buildHeliusJsonRpcUrl(apiKeyValue, network), {
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
            setStatusMessage(`Execution stopped at ${node.name}: ${message}`);
            runResult = {
              success: false,
              failedNodeId: node.id,
              failedNodeName: node.name,
              errorMessage: message,
            };
            break;
          }

          if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
            const rpcError = (parsed as { error?: unknown }).error;
            const message = typeof rpcError === "string" ? rpcError : JSON.stringify(rpcError);
            setNodeStatus(node.id, "error", message);
            setStatusMessage(`Execution stopped at ${node.name}: ${message}`);
            runResult = {
              success: false,
              failedNodeId: node.id,
              failedNodeName: node.name,
              errorMessage: message,
            };
            break;
          }

          outputsByNodeId.set(node.id, parsed);
          setNodeStatus(node.id, "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown execution error";
          setNodeStatus(node.id, "error", message);
          setStatusMessage(`Execution stopped at ${node.name}: ${message}`);
          runResult = {
            success: false,
            failedNodeId: node.id,
            failedNodeName: node.name,
            errorMessage: message,
          };
          break;
        }
      }
    } finally {
      setIsExecuting(false);
    }

    return runResult;
  };

  const executeAll = async () => {
    await runRange(0, order.length);
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
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(232,65,37,0.16),transparent_42%),linear-gradient(180deg,#090909_0%,#0f0f10_100%)] p-6 text-foreground">
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <PanelRightClose className="h-8 w-8 text-primary" />
              <h1 className="text-[1.5rem] font-bold tracking-wide text-primary">DASH</h1>
              <span className="text-sm text-foreground/50">Helius Workflow Builder</span>
            </div>

            <div className="flex items-center gap-2">
              <label htmlFor="network-select" className="text-xs font-semibold uppercase tracking-wide text-foreground/65">
                Network
              </label>
              <select
                id="network-select"
                value={network}
                onChange={(event) => setNetwork(event.target.value as RpcNetwork)}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
              >
                <option value="mainnet">Mainnet</option>
                <option value="devnet">Devnet</option>
              </select>
            </div>
          </div>
        </header>

        <section className="rounded-xl border border-border bg-background/80 p-4 shadow-lg shadow-black/25 backdrop-blur">
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
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wide text-primary">1. Configure Access</p>
                  <ol className="list-inside list-decimal space-y-1">
                    <li>Paste your Helius API key in the field below this tutorial.</li>
                    <li>Use the action icons on the right to run all nodes, run from the selected node, or clear outputs.</li>
                    <li>Use the export and import controls to save your flow and load it back.</li>
                  </ol>
                </div>

                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wide text-primary">2. Build Nodes</p>
                  <ol className="list-inside list-decimal space-y-1">
                    <li>Click `Add Node`, search a method, and insert it into the workflow.</li>
                    <li>Use drag handle ordering to place nodes in execution order.</li>
                    <li>Rename each node in the top bar so the flow is readable.</li>
                  </ol>
                </div>

                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wide text-primary">3. Set Parameters</p>
                  <ol className="list-inside list-decimal space-y-1">
                    <li>For known schemas, fill fields in the Input pane using JSON literals.</li>
                    <li>Switch a field to `Reference` to map data from a previous node output path.</li>
                    <li>For unknown schemas, enter raw JSON array params directly.</li>
                  </ol>
                </div>

                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wide text-primary">4. Execute and Inspect</p>
                  <ol className="list-inside list-decimal space-y-1">
                    <li>Run a single node with `Run Node` or a sequence with `Run From Here`.</li>
                    <li>Open Output to inspect parsed JSON responses and error payloads.</li>
                    <li>Status badges show `idle`, `running`, `success`, or `error` per node.</li>
                  </ol>
                </div>

                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <p className="mb-2 text-xs font-semibold tracking-wide text-primary">5. Troubleshooting</p>
                  <ol className="list-inside list-decimal space-y-1">
                    <li>If you get `Invalid params`, check the parameter order and type for that method.</li>
                    <li>Optional values should be omitted when null to avoid RPC validation errors.</li>
                    <li>If a reference path fails, run the source node first and reselect the path.</li>
                  </ol>
                </div>

                <div className="rounded-lg border border-border bg-background/60 p-3">
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

        <section className="rounded-xl border border-border bg-background/80 p-4 shadow-lg shadow-black/25 backdrop-blur">
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
            <QuickTooltip content="Clear outputs">
              <Button
                size="sm"
                className="h-8 w-8 p-0"
                variant="secondary"
                onClick={clearOutputs}
                disabled={isExecuting || order.length === 0}
                aria-label="Clear outputs"
              >
                <MessageSquareX className="h-3.5 w-3.5" />
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
            <QuickTooltip content="Open node map">
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0"
                onClick={() => setShowNodeMap(true)}
                aria-label="Open node map"
              >
                <MapIcon className="h-3.5 w-3.5" />
              </Button>
            </QuickTooltip>
            <QuickTooltip content="Help me build">
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0"
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
                className={`w-full rounded-xl border border-border bg-background/80 p-4 shadow-lg shadow-black/25 backdrop-blur transition-transform duration-300 ease-in-out ${showBotPanel ? "translate-y-0" : "-translate-y-2"}`}
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
                                In order to achieve "{message.plan.task}", you will have to call the following:
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

        {showMethodPicker ? (
          <section className="rounded-xl border border-border bg-background/80 p-4 shadow-lg shadow-black/25 backdrop-blur">
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
        ) : null}

        <section className="space-y-3">
          {orderedNodes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-background/40 p-8 text-center text-sm text-foreground/70">
              Add your first RPC node to begin building the workflow.
            </div>
          ) : (
            orderedNodes.map((node, index) => {
              const sourceNodes = node.outputOpen
                ? orderedNodes
                    .slice(0, index)
                    .filter((candidate) => candidate.output !== undefined)
                    .map((candidate) => ({
                      id: candidate.id,
                      name: candidate.name,
                      output: candidate.output,
                    }))
                : [];

              return (
                <NodeCard
                  key={node.id}
                  node={node}
                  selected={selectedNodeId === node.id}
                  methodEntry={getMethodEntry(node.method)}
                  sourceNodes={sourceNodes}
                  onSelect={() => selectNode(node.id)}
                  onRename={(name) => renameNode(node.id, name)}
                  onRunNode={() => void runRange(index, index + 1)}
                  onRunFromHere={() => void runRange(index, order.length)}
                  onDelete={() => removeNode(node.id)}
                  onToggleExpand={() => toggleOutputOpen(node.id)}
                  onParamChange={(paramName, value) => setParamValue(node.id, paramName, value)}
                  onRawParamsChange={(raw) => setRawParamsJson(node.id, raw)}
                  onDragStart={() => setDraggingNodeId(node.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (draggingNodeId && draggingNodeId !== node.id) {
                      reorderNodes(draggingNodeId, node.id);
                    }
                    setDraggingNodeId(undefined);
                  }}
                />
              );
            })
          )}
        </section>
      </div>
      <NodeMapModal open={showNodeMap} nodes={orderedNodes} onClose={() => setShowNodeMap(false)} />
    </div>
  );
}
