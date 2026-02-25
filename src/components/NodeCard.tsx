"use client";

import { useMemo, useState } from "react";
import { ChevronDown, GripVertical, Play, PlayCircle, TimerReset, Trash2 } from "lucide-react";

import { ParamEditor } from "@/components/ParamEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { QuickTooltip } from "@/components/ui/quick-tooltip";
import type { MethodRegistryEntry } from "@/lib/methodRegistry";
import type { ParamValue } from "@/lib/workflowSchema";
import type { NodeRepeat, WorkflowNode } from "@/store/workflowStore";
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
  onRepeatChange: (value: Partial<NodeRepeat>) => void;
  callCount: number;
  callTarget: number | null;
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
  onRepeatChange,
  callCount,
  callTarget,
  onDragStart,
  onDragOver,
  onDrop,
}: NodeCardProps) {
  const [repeatPopoverOpen, setRepeatPopoverOpen] = useState(false);

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
            <div className="relative">
              <QuickTooltip content="Configure repeat run">
                <Button
                  size="sm"
                  variant={node.repeat.enabled ? "default" : "outline"}
                  className="h-8 w-8 p-0"
                  onClick={(event) => {
                    event.stopPropagation();
                    setRepeatPopoverOpen((value) => !value);
                  }}
                  aria-label="Configure repeat run"
                >
                  <TimerReset className="h-3.5 w-3.5" />
                </Button>
              </QuickTooltip>
              {repeatPopoverOpen ? (
                <div
                  className="absolute left-0 top-10 z-30 w-72 space-y-3 rounded-md border border-border bg-background/95 p-3 shadow-lg"
                  onClick={(event) => event.stopPropagation()}
                >
                  <label className="flex items-center gap-2 text-xs text-foreground/85">
                    <Checkbox
                      checked={node.repeat.enabled}
                      onChange={(event) => onRepeatChange({ enabled: event.target.checked })}
                      aria-label="Enable repeat run"
                    />
                    <span>Enable repeat</span>
                  </label>

                  <label className="flex items-center gap-2 text-xs text-foreground/80">
                    <span>Repeat</span>
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={node.repeat.count}
                      onChange={(event) => onRepeatChange({ count: Number(event.target.value) })}
                      disabled={!node.repeat.enabled}
                      className="h-8 w-20 text-xs"
                      aria-label="Repeat count"
                    />
                    <span>times</span>
                  </label>

                  <label className="flex items-center gap-2 text-xs text-foreground/80">
                    <span>every</span>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={node.repeat.interval}
                      onChange={(event) => onRepeatChange({ interval: Number(event.target.value) })}
                      disabled={!node.repeat.enabled}
                      className="h-8 w-20 text-xs"
                      aria-label="Repeat interval"
                    />
                    <select
                      value={node.repeat.unit}
                      onChange={(event) => onRepeatChange({ unit: event.target.value as NodeRepeat["unit"] })}
                      disabled={!node.repeat.enabled}
                      className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                      aria-label="Repeat interval unit"
                    >
                      <option value="milliseconds">milliseconds</option>
                      <option value="seconds">seconds</option>
                      <option value="minutes">minutes</option>
                    </select>
                  </label>

                  <label className="flex items-center gap-2 text-xs text-foreground/80">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={node.repeat.loopCount}
                      onChange={(event) => onRepeatChange({ loopCount: Number(event.target.value) })}
                      disabled={!node.repeat.enabled}
                      className="h-8 w-20 text-xs"
                      aria-label="Repeat loop count"
                    />
                    <span>times (0 for infinite)</span>
                  </label>
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded border border-border bg-background/50 px-2 py-0.5 font-mono text-[11px] text-foreground/75">
              {callCount} / {callTarget === null ? "-" : callTarget}
            </span>
            <Badge variant={statusVariant(node.status)}>{node.status}</Badge>
            <QuickTooltip content="Delete this node">
              <Button
                size="sm"
                variant="destructive"
                className="h-7 w-7 p-0"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
                aria-label="Delete this node"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </QuickTooltip>
            <QuickTooltip content={node.outputOpen ? "Collapse node details" : "Expand node details"}>
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
            </QuickTooltip>
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
              <QuickTooltip content="Run this node only">
                <Button size="sm" onClick={onRunNode} aria-label="Run this node only">
                  <Play className="h-3 w-3" />
                  Run Node
                </Button>
              </QuickTooltip>
              <QuickTooltip content="Run from this node through the rest of the workflow">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onRunFromHere}
                  aria-label="Run from this node through the rest of the workflow"
                >
                  <PlayCircle className="h-3 w-3" />
                  Run From Here
                </Button>
              </QuickTooltip>
            </div>
          </CardContent>
        </div>
      </div>
    </Card>
  );
}
