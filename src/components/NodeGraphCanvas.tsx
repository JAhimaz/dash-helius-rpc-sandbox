"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
  type NodeTypes,
  type NodeProps,
  type OnNodesChange,
  type OnNodeDrag,
  Handle,
  Position,
  ReactFlowProvider,
  useReactFlow,
  applyNodeChanges,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Maximize, Minus, Play, Plus, RotateCcw, Settings, Square, StepForward, Trash2 } from "lucide-react";

import { ImportExport } from "@/components/ImportExport";
import { Button } from "@/components/ui/button";
import { QuickTooltip } from "@/components/ui/quick-tooltip";
import type { WorkflowNode } from "@/store/workflowStore";
import type { WorkflowExport } from "@/lib/workflowSchema";
import { getMethodEntry } from "@/lib/methodRegistry";
import { cn } from "@/lib/utils";

const NODE_WIDTH = 330;
const NODE_HEIGHT = 168;
const EDGE_COLORS = ["#ff5f57", "#58d26b", "#ffd60a", "#3a9dff", "#ff8a3d", "#b18cff", "#00c2b8"];

export interface NodeGraphConnection {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  paramName: string;
  path: string;
}

interface NodeGraphCanvasProps {
  nodes: WorkflowNode[];
  selectedNodeId?: string;
  connections: NodeGraphConnection[];
  callCountsByNodeId: Record<string, number>;
  callTargetsByNodeId: Record<string, number | null>;
  executionOrderByNodeId: Record<string, number | null>;
  onSelectNode: (nodeId: string) => void;
  onOpenNodeSettings: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onMoveNode: (nodeId: string, position: { x: number; y: number }) => void;
  // Toolbar
  isExecuting: boolean;
  hasActiveWebSockets: boolean;
  onExecuteAll: () => void;
  onStop: () => void;
  onExecuteFromSelected: () => void;
  onReset: () => void;
  includeOutputsOnExport: boolean;
  onIncludeOutputsChange: (next: boolean) => void;
  onExport: (includeOutputs: boolean) => WorkflowExport;
  onImport: (payload: WorkflowExport) => void;
}

// ── Custom node data ──

interface WorkflowNodeData {
  label: string;
  method: string;
  transport: string;
  status: WorkflowNode["status"];
  output: unknown;
  callCount: number;
  callTarget: number | null;
  executionOrder: number | null;
  incomingCount: number;
  outgoingCount: number;
  isSelected: boolean;
  onOpenSettings: () => void;
  onDelete: () => void;
  [key: string]: unknown;
}

// ── Status dot ──

function statusClass(status: WorkflowNode["status"]): string {
  if (status === "running") return "bg-warning";
  if (status === "success") return "bg-success";
  if (status === "error") return "bg-error";
  return "bg-foreground/45";
}

// ── Handle style (invisible dots, just connection points) ──

const handleStyle = { background: "transparent", width: 8, height: 8, border: "none" };

// ── Custom node component ──

function WorkflowNodeCard({ data }: NodeProps<Node<WorkflowNodeData>>) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-[color-mix(in_srgb,var(--surface-soft)_84%,black_16%)] shadow-[0_16px_28px_-20px_black] select-none",
        data.isSelected
          ? "border-primary/90 ring-2 ring-primary/35"
          : "border-border/90",
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      {/* Handles on all 4 sides for directional edges */}
      <Handle type="target" position={Position.Left} id="left" style={handleStyle} />
      <Handle type="target" position={Position.Top} id="top" style={handleStyle} />
      <Handle type="target" position={Position.Right} id="right-in" style={handleStyle} />
      <Handle type="target" position={Position.Bottom} id="bottom-in" style={handleStyle} />
      <Handle type="source" position={Position.Right} id="right" style={handleStyle} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={handleStyle} />
      <Handle type="source" position={Position.Left} id="left-out" style={handleStyle} />
      <Handle type="source" position={Position.Top} id="top-out" style={handleStyle} />

      <div className="flex h-full flex-col justify-between p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 overflow-hidden">
            <p className="truncate text-xs font-semibold tracking-wide text-foreground">
              {data.label}
            </p>
            <p className="truncate text-[11px] italic text-foreground/45">{data.method}</p>
            <p className="text-[11px] text-foreground/65">
              {data.incomingCount} in / {data.outgoingCount} out
            </p>
          </div>
          <div className="text-right">
            <span className="rounded border border-border/70 bg-black/35 px-2 py-0.5 font-mono text-[11px] text-foreground/80">
              {data.callCount} / {data.callTarget === null ? "-" : data.callTarget}
            </span>
            <p className="mt-1 text-[11px] text-foreground/50">
              #{data.executionOrder ?? "-"}
            </p>
          </div>
        </div>

        {data.method === "Value Aggregator" &&
        data.output != null &&
        typeof data.output === "object" &&
        "accumulated" in (data.output as Record<string, unknown>) ? (
          <p className="truncate text-center font-mono text-sm font-semibold text-primary">
            {String((data.output as { accumulated: unknown }).accumulated)}
          </p>
        ) : data.method === "Arithmetic" &&
          data.output != null &&
          typeof data.output === "object" &&
          "result" in (data.output as Record<string, unknown>) ? (
          <p className="truncate text-center font-mono text-sm font-semibold text-primary">
            {String((data.output as { result: unknown }).result)}
          </p>
        ) : data.method === "List" ? (
          <p className="truncate text-center font-mono text-[11px] text-foreground/50">
            {Array.isArray(data.output) ? `${data.output.length} items` : "0 items"}
          </p>
        ) : null}

        <div className="space-y-1">
          {data.transport !== "custom" && (
            <span
              className={cn(
                "inline-block rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase leading-none",
                data.transport === "websocket"
                  ? "bg-yellow-500/20 text-yellow-400"
                  : "bg-blue-500/20 text-blue-400",
              )}
            >
              {data.transport === "websocket" ? "WSS" : "POST"}
            </span>
          )}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  data.status === "running" && data.method === "WebSocket"
                    ? "bg-success"
                    : statusClass(data.status),
                )}
              />
              <span className="text-[11px] uppercase tracking-wide text-foreground/70">
                {data.status === "running" && data.method === "WebSocket"
                  ? "live"
                  : data.status}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <QuickTooltip content="Delete node">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 w-7 p-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    data.onDelete();
                  }}
                  aria-label="Delete node"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </QuickTooltip>
              <QuickTooltip content="Node settings">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-7 p-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    data.onOpenSettings();
                  }}
                  aria-label="Open node settings"
                >
                  <Settings className="h-3.5 w-3.5" />
                </Button>
              </QuickTooltip>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  workflow: WorkflowNodeCard,
};

// ── Toolbar controls ──

interface CanvasControlsProps {
  isExecuting: boolean;
  hasActiveWebSockets: boolean;
  hasNodes: boolean;
  onExecuteAll: () => void;
  onStop: () => void;
  onExecuteFromSelected: () => void;
  onReset: () => void;
  includeOutputsOnExport: boolean;
  onIncludeOutputsChange: (next: boolean) => void;
  onExport: (includeOutputs: boolean) => WorkflowExport;
  onImport: (payload: WorkflowExport) => void;
}

function CanvasControls({
  isExecuting,
  hasActiveWebSockets,
  hasNodes,
  onExecuteAll,
  onStop,
  onExecuteFromSelected,
  onReset,
  includeOutputsOnExport,
  onIncludeOutputsChange,
  onExport,
  onImport,
}: CanvasControlsProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <>
      {/* View controls — left */}
      <div className="absolute left-3 top-3 z-30 flex items-center gap-1.5">
        <QuickTooltip content="Zoom in">
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => zoomIn({ duration: 200 })}
            aria-label="Zoom in"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </QuickTooltip>
        <QuickTooltip content="Zoom out">
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => zoomOut({ duration: 200 })}
            aria-label="Zoom out"
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
        </QuickTooltip>
        <QuickTooltip content="Fit to screen">
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => fitView({ padding: 0.2, duration: 300 })}
            aria-label="Fit to screen"
          >
            <Maximize className="h-3.5 w-3.5" />
          </Button>
        </QuickTooltip>
      </div>

      {/* Execution & import/export — right */}
      <div className="absolute right-3 top-3 z-30 flex items-center gap-1.5">
        <QuickTooltip content="Execute all">
          <Button
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onExecuteAll}
            disabled={isExecuting || !hasNodes}
            aria-label="Execute all"
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        </QuickTooltip>
        <QuickTooltip content="Stop">
          <Button
            size="sm"
            className="h-8 w-8 p-0"
            variant="destructive"
            onClick={onStop}
            disabled={!isExecuting && !hasActiveWebSockets}
            aria-label="Stop"
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        </QuickTooltip>
        <QuickTooltip content="Execute from current node">
          <Button
            size="sm"
            className="h-8 w-8 p-0"
            variant="outline"
            onClick={onExecuteFromSelected}
            disabled={isExecuting || !hasNodes}
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
            onClick={onReset}
            disabled={isExecuting || !hasNodes}
            aria-label="Reset"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </QuickTooltip>

        <div className="mx-1 h-5 w-px bg-border/50" />

        <ImportExport
          includeOutputs={includeOutputsOnExport}
          onIncludeOutputsChange={onIncludeOutputsChange}
          onExport={onExport}
          onImport={onImport}
        />
      </div>
    </>
  );
}

// ── Pick best handle pair based on relative position of source/target ──

function getHandleIds(
  sourcePos: { x: number; y: number },
  targetPos: { x: number; y: number },
): { sourceHandle: string; targetHandle: string } {
  const dx = (targetPos.x + NODE_WIDTH / 2) - (sourcePos.x + NODE_WIDTH / 2);
  const dy = (targetPos.y + NODE_HEIGHT / 2) - (sourcePos.y + NODE_HEIGHT / 2);

  if (Math.abs(dx) >= Math.abs(dy)) {
    // Mostly horizontal
    if (dx >= 0) {
      return { sourceHandle: "right", targetHandle: "left" };
    }
    return { sourceHandle: "left-out", targetHandle: "right-in" };
  }
  // Mostly vertical
  if (dy >= 0) {
    return { sourceHandle: "bottom", targetHandle: "top" };
  }
  return { sourceHandle: "top-out", targetHandle: "bottom-in" };
}

// ── Inner canvas (needs ReactFlowProvider above it) ──

function NodeGraphCanvasInner({
  nodes: workflowNodes,
  selectedNodeId,
  connections,
  callCountsByNodeId,
  callTargetsByNodeId,
  executionOrderByNodeId,
  onSelectNode,
  onOpenNodeSettings,
  onDeleteNode,
  onMoveNode,
  isExecuting,
  hasActiveWebSockets,
  onExecuteAll,
  onStop,
  onExecuteFromSelected,
  onReset,
  includeOutputsOnExport,
  onIncludeOutputsChange,
  onExport,
  onImport,
}: NodeGraphCanvasProps) {
  // Precompute incoming/outgoing counts
  const { incomingCounts, outgoingCounts } = useMemo(() => {
    const inc: Record<string, number> = {};
    const out: Record<string, number> = {};
    for (const c of connections) {
      inc[c.toNodeId] = (inc[c.toNodeId] ?? 0) + 1;
      out[c.fromNodeId] = (out[c.fromNodeId] ?? 0) + 1;
    }
    return { incomingCounts: inc, outgoingCounts: out };
  }, [connections]);

  // Build React Flow nodes from workflow data
  const rfNodesFromProps = useMemo<Node<WorkflowNodeData>[]>(
    () =>
      workflowNodes.map((node) => ({
        id: node.id,
        type: "workflow",
        position: { x: node.position.x, y: node.position.y },
        selected: node.id === selectedNodeId,
        draggable: true,
        data: {
          label: node.name || node.method,
          method: node.method,
          transport: getMethodEntry(node.method)?.transport ?? "jsonrpc",
          status: node.status,
          output: node.output,
          callCount: callCountsByNodeId[node.id] ?? 0,
          callTarget: Object.prototype.hasOwnProperty.call(callTargetsByNodeId, node.id)
            ? callTargetsByNodeId[node.id]
            : 0,
          executionOrder: Object.prototype.hasOwnProperty.call(executionOrderByNodeId, node.id)
            ? executionOrderByNodeId[node.id]
            : null,
          incomingCount: incomingCounts[node.id] ?? 0,
          outgoingCount: outgoingCounts[node.id] ?? 0,
          isSelected: node.id === selectedNodeId,
          onOpenSettings: () => onOpenNodeSettings(node.id),
          onDelete: () => onDeleteNode(node.id),
        },
      })),
    [
      workflowNodes,
      selectedNodeId,
      callCountsByNodeId,
      callTargetsByNodeId,
      executionOrderByNodeId,
      incomingCounts,
      outgoingCounts,
      onOpenNodeSettings,
      onDeleteNode,
    ],
  );

  // Local controlled nodes state — React Flow mutates this during drag for smooth 60fps movement
  const [rfNodes, setRfNodes] = useState<Node<WorkflowNodeData>[]>(rfNodesFromProps);

  // Sync from props when workflow data changes (but not during drag)
  useEffect(() => {
    setRfNodes(rfNodesFromProps);
  }, [rfNodesFromProps]);

  // Build a position lookup from current local state (includes live drag positions)
  const positionById = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const n of rfNodes) {
      map.set(n.id, n.position);
    }
    return map;
  }, [rfNodes]);

  // Map connections → React Flow edges with directional handles
  const rfEdges = useMemo<Edge[]>(
    () =>
      connections.map((conn, i) => {
        const sourcePos = positionById.get(conn.fromNodeId) ?? { x: 0, y: 0 };
        const targetPos = positionById.get(conn.toNodeId) ?? { x: 0, y: 0 };
        const { sourceHandle, targetHandle } = getHandleIds(sourcePos, targetPos);

        return {
          id: conn.id,
          source: conn.fromNodeId,
          target: conn.toNodeId,
          sourceHandle,
          targetHandle,
          type: "default",
          style: { stroke: EDGE_COLORS[i % EDGE_COLORS.length], strokeWidth: 2.3, opacity: 0.92 },
          data: { paramName: conn.paramName, path: conn.path },
        };
      }),
    [connections, positionById],
  );

  // Apply all node changes (position during drag, selection, etc.) to local state
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      setRfNodes((nds) => applyNodeChanges(changes, nds) as Node<WorkflowNodeData>[]);

      // Forward selection changes
      for (const change of changes) {
        if (change.type === "select" && change.selected) {
          onSelectNode(change.id);
        }
      }
    },
    [onSelectNode],
  );

  // Commit final position to store on drag end
  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, node) => {
      onMoveNode(node.id, { x: node.position.x, y: node.position.y });
    },
    [onMoveNode],
  );

  return (
    <div className="h-[680px] overflow-hidden rounded-xl border border-border shadow-[0_20px_40px_-24px_var(--panel-shadow)]">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        defaultViewport={{ x: 120, y: 90, zoom: 1 }}
        minZoom={0.45}
        maxZoom={2.4}
        snapToGrid
        snapGrid={[16, 16]}
        fitView={false}
        proOptions={{ hideAttribution: true }}
        selectionOnDrag={false}
        selectNodesOnDrag={false}
        nodesDraggable
        panOnDrag
        zoomOnScroll
        className="!bg-[#120e1d]"
      >
        <Background variant={BackgroundVariant.Dots} color="rgba(180,120,255,0.25)" gap={24} size={1.5} />
        <CanvasControls
          isExecuting={isExecuting}
          hasActiveWebSockets={hasActiveWebSockets}
          hasNodes={workflowNodes.length > 0}
          onExecuteAll={onExecuteAll}
          onStop={onStop}
          onExecuteFromSelected={onExecuteFromSelected}
          onReset={onReset}
          includeOutputsOnExport={includeOutputsOnExport}
          onIncludeOutputsChange={onIncludeOutputsChange}
          onExport={onExport}
          onImport={onImport}
        />
      </ReactFlow>
    </div>
  );
}

// ── Exported wrapper with provider ──

export function NodeGraphCanvas(props: NodeGraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <NodeGraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
