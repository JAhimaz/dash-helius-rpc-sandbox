"use client";

import { useMemo } from "react";
import { ArrowDown, Link2, Map as MapIcon, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { QuickTooltip } from "@/components/ui/quick-tooltip";
import type { WorkflowNode } from "@/store/workflowStore";

interface NodeMapModalProps {
  open: boolean;
  nodes: WorkflowNode[];
  onClose: () => void;
}

interface NodeConnection {
  fromNodeId: string;
  toNodeId: string;
  paramName: string;
  path: string;
}

function buildConnections(nodes: WorkflowNode[]): NodeConnection[] {
  const connections: NodeConnection[] = [];

  for (const node of nodes) {
    for (const param of node.params) {
      if (param.value.type !== "ref") {
        continue;
      }

      connections.push({
        fromNodeId: param.value.nodeId,
        toNodeId: node.id,
        paramName: param.name,
        path: param.value.path,
      });
    }
  }

  return connections;
}

export function NodeMapModal({ open, nodes, onClose }: NodeMapModalProps) {
  const nodeById = useMemo(() => new globalThis.Map(nodes.map((node) => [node.id, node])), [nodes]);
  const connections = useMemo(() => buildConnections(nodes), [nodes]);

  const incomingByNodeId = useMemo(() => {
    const map = new globalThis.Map<string, NodeConnection[]>();
    for (const connection of connections) {
      const list = map.get(connection.toNodeId) ?? [];
      list.push(connection);
      map.set(connection.toNodeId, list);
    }
    return map;
  }, [connections]);

  const outgoingByNodeId = useMemo(() => {
    const map = new globalThis.Map<string, NodeConnection[]>();
    for (const connection of connections) {
      const list = map.get(connection.fromNodeId) ?? [];
      list.push(connection);
      map.set(connection.fromNodeId, list);
    }
    return map;
  }, [connections]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={onClose}
      role="presentation"
    >
      <section
        className="max-h-[88vh] w-full max-w-4xl overflow-hidden rounded-xl border border-border bg-background shadow-2xl shadow-black/40"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <MapIcon className="h-5 w-5 text-primary" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">Node Map</h2>
          </div>
          <QuickTooltip content="Close">
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0"
              onClick={onClose}
              aria-label="Close node map"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </QuickTooltip>
        </header>

        <div className="max-h-[calc(88vh-57px)] overflow-auto p-4">
          {nodes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-background/50 p-6 text-center text-sm text-foreground/70">
              Add nodes to generate a connection map.
            </div>
          ) : (
            <div className="space-y-3">
              {nodes.map((node, index) => {
                const incoming = incomingByNodeId.get(node.id) ?? [];
                const outgoing = outgoingByNodeId.get(node.id) ?? [];
                const previousNode = index > 0 ? nodes[index - 1] : undefined;

                return (
                  <div key={node.id} className="space-y-3">
                    <article className="rounded-lg border border-border bg-background/60 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-primary/40 bg-primary/20 text-xs font-semibold text-primary">
                            {index + 1}
                          </span>
                          <p className="truncate text-sm font-semibold text-foreground">{node.name}</p>
                          <span className="rounded border border-primary/35 bg-primary/15 px-2 py-0.5 text-xs text-primary">
                            {node.method}
                          </span>
                        </div>
                        <span className="rounded border border-border bg-background/50 px-2 py-0.5 text-[11px] uppercase tracking-wide text-foreground/70">
                          {node.status}
                        </span>
                      </div>

                      <div className="mt-3 grid gap-3 md:grid-cols-3">
                        <div className="rounded-md border border-border bg-background/40 p-2">
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-foreground/65">Execution Flow</p>
                          <p className="text-xs text-foreground/80">
                            {previousNode ? `Runs after ${previousNode.name}` : "Workflow starts here"}
                          </p>
                        </div>

                        <div className="rounded-md border border-border bg-background/40 p-2">
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-foreground/65">Receives Data</p>
                          {incoming.length === 0 ? (
                            <p className="text-xs text-foreground/70">No referenced inputs.</p>
                          ) : (
                            <ul className="space-y-1">
                              {incoming.map((connection) => {
                                const source = nodeById.get(connection.fromNodeId);
                                return (
                                  <li key={`${connection.fromNodeId}-${connection.toNodeId}-${connection.paramName}`} className="text-xs text-foreground/80">
                                    {connection.paramName} ← {(source?.name ?? connection.fromNodeId)}.{connection.path}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>

                        <div className="rounded-md border border-border bg-background/40 p-2">
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-foreground/65">Sends Data</p>
                          {outgoing.length === 0 ? (
                            <p className="text-xs text-foreground/70">No downstream references.</p>
                          ) : (
                            <ul className="space-y-1">
                              {outgoing.map((connection) => {
                                const target = nodeById.get(connection.toNodeId);
                                return (
                                  <li key={`${connection.fromNodeId}-${connection.toNodeId}-${connection.paramName}`} className="flex items-center gap-1 text-xs text-foreground/80">
                                    <Link2 className="h-3 w-3 text-primary/80" />
                                    {target?.name ?? connection.toNodeId}.{connection.paramName} ← {connection.path}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      </div>
                    </article>

                    {index < nodes.length - 1 ? (
                      <div className="flex justify-center">
                        <ArrowDown className="h-4 w-4 text-foreground/45" />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
