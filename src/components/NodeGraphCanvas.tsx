"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, Settings, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { QuickTooltip } from "@/components/ui/quick-tooltip";
import type { WorkflowNode } from "@/store/workflowStore";
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
}

interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

interface NodeDragState {
  nodeId: string;
  startClientX: number;
  startClientY: number;
  startNodeX: number;
  startNodeY: number;
}

interface CanvasPanState {
  startClientX: number;
  startClientY: number;
  startViewportX: number;
  startViewportY: number;
}

function clampZoom(value: number): number {
  return Math.min(2.4, Math.max(0.45, value));
}

function statusClass(status: WorkflowNode["status"]): string {
  if (status === "running") {
    return "bg-warning";
  }
  if (status === "success") {
    return "bg-success";
  }
  if (status === "error") {
    return "bg-error";
  }
  return "bg-foreground/45";
}

function connectorOffset(index: number, count: number): number {
  return (index - (count - 1) / 2) * 12;
}

export function NodeGraphCanvas({
  nodes,
  selectedNodeId,
  connections,
  callCountsByNodeId,
  callTargetsByNodeId,
  executionOrderByNodeId,
  onSelectNode,
  onOpenNodeSettings,
  onDeleteNode,
  onMoveNode,
}: NodeGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<NodeDragState | null>(null);
  const panStateRef = useRef<CanvasPanState | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({ x: 120, y: 90, zoom: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [hoveredEdgeTooltip, setHoveredEdgeTooltip] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);

  const nodeById = useMemo(
    () => new globalThis.Map<string, WorkflowNode>(nodes.map((node) => [node.id, node])),
    [nodes],
  );

  const outgoingByNodeId = useMemo(() => {
    const map = new globalThis.Map<string, NodeGraphConnection[]>();
    for (const connection of connections) {
      const list = map.get(connection.fromNodeId) ?? [];
      list.push(connection);
      map.set(connection.fromNodeId, list);
    }
    return map;
  }, [connections]);

  const incomingByNodeId = useMemo(() => {
    const map = new globalThis.Map<string, NodeGraphConnection[]>();
    for (const connection of connections) {
      const list = map.get(connection.toNodeId) ?? [];
      list.push(connection);
      map.set(connection.toNodeId, list);
    }
    return map;
  }, [connections]);

  const worldBounds = useMemo(() => {
    const maxX = nodes.reduce((largest, node) => Math.max(largest, node.position.x + NODE_WIDTH + 260), 2200);
    const maxY = nodes.reduce((largest, node) => Math.max(largest, node.position.y + NODE_HEIGHT + 220), 1500);
    return {
      width: maxX,
      height: maxY,
    };
  }, [nodes]);

  const zoomAt = (clientX: number, clientY: number, zoomFactor: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    setViewport((current) => {
      const currentZoom = current.zoom;
      const nextZoom = clampZoom(current.zoom * zoomFactor);
      if (Math.abs(nextZoom - currentZoom) < 0.0001) {
        return current;
      }

      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const worldX = (localX - current.x) / currentZoom;
      const worldY = (localY - current.y) / currentZoom;

      return {
        x: localX - worldX * nextZoom,
        y: localY - worldY * nextZoom,
        zoom: nextZoom,
      };
    });
  };

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (dragStateRef.current) {
        const dragState = dragStateRef.current;
        const deltaX = (event.clientX - dragState.startClientX) / viewport.zoom;
        const deltaY = (event.clientY - dragState.startClientY) / viewport.zoom;
        onMoveNode(dragState.nodeId, {
          x: dragState.startNodeX + deltaX,
          y: dragState.startNodeY + deltaY,
        });
        return;
      }

      if (panStateRef.current) {
        const panState = panStateRef.current;
        setViewport((current) => ({
          ...current,
          x: panState.startViewportX + (event.clientX - panState.startClientX),
          y: panState.startViewportY + (event.clientY - panState.startClientY),
        }));
      }
    };

    const handleMouseUp = () => {
      dragStateRef.current = null;
      panStateRef.current = null;
      setIsDragging(false);
      setIsPanning(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [onMoveNode, viewport.zoom]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative h-[680px] overflow-hidden rounded-xl border border-border shadow-[0_20px_40px_-24px_var(--panel-shadow)]",
        isPanning ? "cursor-grabbing" : isDragging ? "cursor-move" : "cursor-default",
      )}
      style={{
        backgroundColor: "#120e1d",
        backgroundImage:
          "linear-gradient(rgba(180,120,255,0.11) 1px, transparent 1px), linear-gradient(90deg, rgba(180,120,255,0.11) 1px, transparent 1px)",
        backgroundSize: `${32 * viewport.zoom}px ${32 * viewport.zoom}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      onWheel={(event) => {
        event.preventDefault();
        const zoomFactor = event.deltaY > 0 ? 0.92 : 1.08;
        zoomAt(event.clientX, event.clientY, zoomFactor);
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) {
          return;
        }

        const target = event.target as HTMLElement;
        if (target.closest("[data-node-card='true']") || target.closest("[data-graph-control='true']")) {
          return;
        }

        panStateRef.current = {
          startClientX: event.clientX,
          startClientY: event.clientY,
          startViewportX: viewport.x,
          startViewportY: viewport.y,
        };
        setIsPanning(true);
      }}
    >
      <div className="absolute left-3 top-3 z-30 flex items-center gap-2" data-graph-control="true">
        <span className="rounded border border-border bg-black/45 px-2 py-1 text-[11px] text-foreground/80">
          Zoom {Math.round(viewport.zoom * 100)}%
        </span>
        <QuickTooltip content="Zoom in">
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => {
              const rect = containerRef.current?.getBoundingClientRect();
              if (!rect) {
                return;
              }
              zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.1);
            }}
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
            onClick={() => {
              const rect = containerRef.current?.getBoundingClientRect();
              if (!rect) {
                return;
              }
              zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 0.9);
            }}
            aria-label="Zoom out"
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
        </QuickTooltip>
      </div>

      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <svg
          className="absolute left-0 top-0"
          width={worldBounds.width}
          height={worldBounds.height}
          viewBox={`0 0 ${worldBounds.width} ${worldBounds.height}`}
          fill="none"
        >
          {connections.map((connection, index) => {
            const source = nodeById.get(connection.fromNodeId);
            const target = nodeById.get(connection.toNodeId);
            if (!source || !target) {
              return null;
            }

            const outgoing = outgoingByNodeId.get(source.id) ?? [];
            const incoming = incomingByNodeId.get(target.id) ?? [];
            const outgoingIndex = outgoing.findIndex((candidate) => candidate.id === connection.id);
            const incomingIndex = incoming.findIndex((candidate) => candidate.id === connection.id);

            const startX = source.position.x + NODE_WIDTH;
            const startY = source.position.y + NODE_HEIGHT / 2 + connectorOffset(outgoingIndex, Math.max(1, outgoing.length));
            const endX = target.position.x;
            const endY = target.position.y + NODE_HEIGHT / 2 + connectorOffset(incomingIndex, Math.max(1, incoming.length));
            const controlDistance = Math.max(70, Math.abs(endX - startX) * 0.4);
            const pathD = `M ${startX} ${startY} C ${startX + controlDistance} ${startY}, ${endX - controlDistance} ${endY}, ${endX} ${endY}`;
            const color = EDGE_COLORS[index % EDGE_COLORS.length];

            return (
              <g key={connection.id}>
                <path d={pathD} stroke="transparent" strokeWidth={14} fill="none">
                  <title>{`output.${connection.path} -> ${connection.paramName}`}</title>
                </path>
                <path
                  d={pathD}
                  stroke="transparent"
                  strokeWidth={14}
                  fill="none"
                  onMouseMove={(event) => {
                    const rect = containerRef.current?.getBoundingClientRect();
                    if (!rect) {
                      return;
                    }

                    setHoveredEdgeTooltip({
                      x: event.clientX - rect.left + 12,
                      y: event.clientY - rect.top + 12,
                      text: `output.${connection.path} -> ${connection.paramName}`,
                    });
                  }}
                  onMouseLeave={() => setHoveredEdgeTooltip(null)}
                />
                <path d={pathD} stroke={color} strokeWidth={2.3} fill="none" opacity={0.92} />
              </g>
            );
          })}
        </svg>

        {nodes.map((node) => {
          const hasTarget = Object.prototype.hasOwnProperty.call(callTargetsByNodeId, node.id);
          const target = hasTarget ? callTargetsByNodeId[node.id] : 0;
          const hasExecutionOrder = Object.prototype.hasOwnProperty.call(executionOrderByNodeId, node.id);
          const executionOrder = hasExecutionOrder ? executionOrderByNodeId[node.id] : null;
          const callCount = callCountsByNodeId[node.id] ?? 0;
          const outgoingCount = outgoingByNodeId.get(node.id)?.length ?? 0;
          const incomingCount = incomingByNodeId.get(node.id)?.length ?? 0;

          return (
            <article
              key={node.id}
              data-node-card="true"
              className={cn(
                "absolute rounded-lg border bg-[color-mix(in_srgb,var(--surface-soft)_84%,black_16%)] shadow-[0_16px_28px_-20px_black]",
                selectedNodeId === node.id ? "border-primary/90 ring-2 ring-primary/35" : "border-border/90",
              )}
              style={{
                left: node.position.x,
                top: node.position.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
              }}
              onMouseDown={(event) => {
                if (event.button !== 0) {
                  return;
                }

                const targetElement = event.target as HTMLElement;
                if (targetElement.closest("[data-graph-control='true']")) {
                  return;
                }

                event.stopPropagation();
                onSelectNode(node.id);
                dragStateRef.current = {
                  nodeId: node.id,
                  startClientX: event.clientX,
                  startClientY: event.clientY,
                  startNodeX: node.position.x,
                  startNodeY: node.position.y,
                };
                setIsDragging(true);
              }}
            >
              <div className="flex h-full flex-col justify-between p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold tracking-wide text-foreground">{node.method}</p>
                    <p className="text-[11px] text-foreground/65">{incomingCount} in / {outgoingCount} out</p>
                  </div>
                  <div className="text-right">
                    <span className="rounded border border-border/70 bg-black/35 px-2 py-0.5 font-mono text-[11px] text-foreground/80">
                      {callCount} / {target === null ? "-" : target}
                    </span>
                    <p className="mt-1 text-[11px] text-foreground/50">#{executionOrder ?? "-"}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2.5 w-2.5 rounded-full", statusClass(node.status))} />
                    <span className="text-[11px] uppercase tracking-wide text-foreground/70">{node.status}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <QuickTooltip content="Delete node">
                      <Button
                        size="sm"
                        variant="destructive"
                        data-graph-control="true"
                        className="h-7 w-7 p-0"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteNode(node.id);
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
                        data-graph-control="true"
                        className="h-7 w-7 p-0"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectNode(node.id);
                          onOpenNodeSettings(node.id);
                        }}
                        aria-label="Open node settings"
                      >
                        <Settings className="h-3.5 w-3.5" />
                      </Button>
                    </QuickTooltip>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {hoveredEdgeTooltip ? (
        <div
          className="pointer-events-none absolute z-40 rounded-md border border-border bg-black/85 px-2 py-1 text-xs text-foreground"
          style={{
            left: hoveredEdgeTooltip.x,
            top: hoveredEdgeTooltip.y,
          }}
        >
          {hoveredEdgeTooltip.text}
        </div>
      ) : null}
    </div>
  );
}
