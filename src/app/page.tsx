"use client";

import { useMemo, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  Map as MapIcon,
  MessageSquareX,
  PanelRightClose,
  Play,
  Plus,
  Search,
  StepForward,
} from "lucide-react";

import { ImportExport } from "@/components/ImportExport";
import { NodeMapModal } from "@/components/NodeMapModal";
import { NodeCard } from "@/components/NodeCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getMethodEntry, getMethodNames } from "@/lib/methodRegistry";
import { getByPath } from "@/lib/path";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/store/workflowStore";

type RpcNetwork = "mainnet" | "devnet";

const DEFAULT_HELIUS_RPC_URLS: Record<RpcNetwork, string> = {
  mainnet: "https://mainnet.helius-rpc.com",
  devnet: "https://devnet.helius-rpc.com",
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

function parseRawParams(raw: string): unknown[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Raw params must be a JSON array");
  }
  return parsed;
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

function getNodeParams(node: WorkflowNode, outputsByNodeId: Map<string, unknown>): unknown[] {
  const entry = getMethodEntry(node.method);

  if (entry?.params?.kind === "table") {
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

  return parseRawParams(node.rawParamsJson)
    .map((param) => pruneNullish(param))
    .filter((param) => param !== undefined);
}

function parseRpcResponse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function buildHeliusRpcUrl(apiKey: string, network: RpcNetwork): string {
  const configured = process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
  const baseUrl = configured ?? DEFAULT_HELIUS_RPC_URLS[network];

  const url = new URL(baseUrl);
  if (apiKey.trim()) {
    url.searchParams.set("api-key", apiKey.trim());
  }
  return url.toString();
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
  const [methodQuery, setMethodQuery] = useState("");
  const [draggingNodeId, setDraggingNodeId] = useState<string>();
  const [showInstructions, setShowInstructions] = useState(false);
  const [network, setNetwork] = useState<RpcNetwork>("mainnet");

  const orderedNodes = useMemo(
    () => order.map((nodeId) => nodes[nodeId]).filter((node): node is WorkflowNode => Boolean(node)),
    [order, nodes],
  );

  const methodNames = useMemo(() => getMethodNames(), []);
  const filteredMethods = useMemo(() => {
    const query = methodQuery.trim().toLowerCase();
    if (!query) {
      return methodNames.slice(0, 40);
    }
    return methodNames.filter((method) => method.toLowerCase().includes(query)).slice(0, 40);
  }, [methodNames, methodQuery]);

  const runRange = async (startIndex: number, endIndexExclusive: number) => {
    if (startIndex < 0) {
      return;
    }

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
          const params = getNodeParams(node, outputsByNodeId);

          const response = await fetch(buildHeliusRpcUrl(useWorkflowStore.getState().apiKey, network), {
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
            break;
          }

          if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
            const rpcError = (parsed as { error?: unknown }).error;
            const message = typeof rpcError === "string" ? rpcError : JSON.stringify(rpcError);
            setNodeStatus(node.id, "error", message);
            setStatusMessage(`Execution stopped at ${node.name}: ${message}`);
            break;
          }

          outputsByNodeId.set(node.id, parsed);
          setNodeStatus(node.id, "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown execution error";
          setNodeStatus(node.id, "error", message);
          setStatusMessage(`Execution stopped at ${node.name}: ${message}`);
          break;
        }
      }
    } finally {
      setIsExecuting(false);
    }
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
              <span className="text-sm text-foreground/50">RPC Workflow Builder</span>
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
            className="flex w-full items-center justify-between rounded-md px-1 py-1 text-left transition-colors duration-150 hover:bg-foreground/5"
            onClick={() => setShowInstructions((value) => !value)}
            aria-expanded={showInstructions}
            aria-controls="tutorial-panel"
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
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-foreground/65">Helius API Key</label>
              <Input
                type="password"
                autoComplete="off"
                placeholder="Paste API key (session only)"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>

            <Button
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => void executeAll()}
              disabled={isExecuting || order.length === 0}
              title="Execute all"
              aria-label="Execute all"
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              className="h-8 w-8 p-0"
              variant="outline"
              onClick={() => void executeFromSelected()}
              disabled={isExecuting || order.length === 0}
              title="Execute from current node"
              aria-label="Execute from current node"
            >
              <StepForward className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              className="h-8 w-8 p-0"
              variant="secondary"
              onClick={clearOutputs}
              disabled={isExecuting || order.length === 0}
              title="Clear outputs"
              aria-label="Clear outputs"
            >
              <MessageSquareX className="h-3.5 w-3.5" />
            </Button>

            <ImportExport
              includeOutputs={includeOutputsOnExport}
              onIncludeOutputsChange={setIncludeOutputsOnExport}
              onExport={(includeOutputs) => exportWorkflow(includeOutputs)}
              onImport={importWorkflow}
            />
          </div>

          {statusMessage ? <p className="mt-3 text-xs text-foreground/80">{statusMessage}</p> : null}
        </section>

        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => setShowNodeMap(true)}
            title="Open node map"
            aria-label="Open node map"
          >
            <MapIcon className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" onClick={() => setShowMethodPicker((value) => !value)}>
            <Plus className="h-3.5 w-3.5" />
            Add Node
          </Button>
        </div>

        {showMethodPicker ? (
          <section className="rounded-xl border border-border bg-background/80 p-4 shadow-lg shadow-black/25 backdrop-blur">
            <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-foreground/50" />
                <Input
                  className="pl-8"
                  value={methodQuery}
                  onChange={(event) => setMethodQuery(event.target.value)}
                  placeholder="Search RPC HTTP method"
                />
              </div>

              <div className="max-h-56 overflow-auto rounded-md border border-border bg-background p-1">
                {filteredMethods.length === 0 ? (
                  <p className="p-2 text-xs text-foreground/65">No methods in the current generated registry.</p>
                ) : (
                  <ul className="space-y-1">
                    {filteredMethods.map((method) => (
                      <li key={method}>
                        <Button
                          className="w-full justify-start"
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            addNode(method);
                            setMethodQuery("");
                            setShowMethodPicker(false);
                          }}
                        >
                          {method}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
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
