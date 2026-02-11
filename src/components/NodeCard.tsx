"use client";

import { useMemo } from "react";
import { ChevronDown, GripVertical, Play, PlayCircle, Trash2 } from "lucide-react";

import { ParamEditor } from "@/components/ParamEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { MethodRegistryEntry } from "@/lib/methodRegistry";
import type { ParamValue } from "@/lib/workflowSchema";
import type { WorkflowNode } from "@/store/workflowStore";
import { cn } from "@/lib/utils";

interface NodeCardProps {
  node: WorkflowNode;
  selected: boolean;
  methodEntry?: MethodRegistryEntry;
  sourceNodes: Array<{ id: string; name: string; output?: unknown }>;
  onSelect: () => void;
  onRename: (name: string) => void;
  onRunNode: () => void;
  onRunFromHere: () => void;
  onDelete: () => void;
  onToggleExpand: () => void;
  onParamChange: (paramName: string, value: ParamValue) => void;
  onRawParamsChange: (raw: string) => void;
  onDragStart: () => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: () => void;
}

function statusVariant(status: WorkflowNode["status"]): "secondary" | "warning" | "success" | "destructive" {
  if (status === "running") {
    return "warning";
  }
  if (status === "success") {
    return "success";
  }
  if (status === "error") {
    return "destructive";
  }
  return "secondary";
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

export function NodeCard({
  node,
  selected,
  methodEntry,
  sourceNodes,
  onSelect,
  onRename,
  onRunNode,
  onRunFromHere,
  onDelete,
  onToggleExpand,
  onParamChange,
  onRawParamsChange,
  onDragStart,
  onDragOver,
  onDrop,
}: NodeCardProps) {
  const outputText = useMemo(() => {
    if (!node.outputOpen) {
      return "No output yet. Run node to see response.";
    }
    return node.output === undefined ? "No output yet. Run node to see response." : stringifyOutput(node.output);
  }, [node.output, node.outputOpen]);

  return (
    <Card
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onSelect}
      className={cn(
        "cursor-pointer border-2 transition",
        selected ? "border-primary shadow-lg shadow-primary/20" : "border-border",
      )}
    >
      <CardHeader className="gap-3">
        <div
          className="flex cursor-pointer flex-wrap items-center justify-between gap-3 rounded-md px-1 py-1 transition-colors duration-150 ease-in-out"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
            onToggleExpand();
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 text-foreground/65">
            <GripVertical className="h-4 w-4" />
            <span className="rounded border border-primary/35 bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
              {node.method}
            </span>
            <Input
              value={node.name}
              onChange={(event) => onRename(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              className="h-8 max-w-sm text-xs"
              placeholder="Node Name"
              aria-label="Node Name"
            />
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(node.status)}>{node.status}</Badge>
            <Button
              size="sm"
              variant="secondary"
              onClick={(event) => {
                event.stopPropagation();
                onToggleExpand();
              }}
              aria-label={node.outputOpen ? "Collapse node" : "Expand node"}
            >
              <ChevronDown className={cn("h-3 w-3 transition-transform duration-300", node.outputOpen ? "rotate-180" : "")} />
            </Button>
          </div>
        </div>
      </CardHeader>

      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-in-out",
          node.outputOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex h-[450px] flex-col rounded-md border border-border bg-background/60 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-foreground/65">Input</p>
                <div className="mt-3 min-h-0 flex-1 overflow-auto pr-1">
                  {methodEntry?.schema === "unknown" ? (
                    <p className="mb-3 rounded-md border border-warning/35 bg-warning/15 px-3 py-2 text-xs text-warning">
                      Schema unknown for this method. Params use raw JSON array and output is shown as raw JSON.
                    </p>
                  ) : null}
                  <ParamEditor
                    node={node}
                    methodEntry={methodEntry}
                    sourceNodes={sourceNodes}
                    onParamChange={onParamChange}
                    onRawParamsChange={onRawParamsChange}
                  />
                </div>
              </div>

              <div className="flex h-[450px] flex-col rounded-md border border-border bg-background/60 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-foreground/65">Output</p>
                <div className="mt-3 min-h-0 flex-1 overflow-auto pr-1">
                  {node.error ? (
                    <div className="mb-3 rounded-md border border-error/35 bg-error/15 px-3 py-2 text-xs text-error">
                      {node.error}
                    </div>
                  ) : null}
                  <pre className="min-h-full rounded-md border border-border bg-black/40 p-3 text-xs text-foreground">
                    {outputText}
                  </pre>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onRunNode}>
                <Play className="h-3 w-3" />
                Run Node
              </Button>
              <Button size="sm" variant="outline" onClick={onRunFromHere}>
                <PlayCircle className="h-3 w-3" />
                Run From Here
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </Button>
            </div>
          </CardContent>
        </div>
      </div>
    </Card>
  );
}
