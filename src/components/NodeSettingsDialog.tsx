"use client";

import { Play, PlayCircle, Trash2, X } from "lucide-react";

import { ParamEditor } from "@/components/ParamEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { QuickTooltip } from "@/components/ui/quick-tooltip";
import type { MethodRegistryEntry } from "@/lib/methodRegistry";
import type { ParamValue } from "@/lib/workflowSchema";
import type { NodeRepeat, WorkflowNode } from "@/store/workflowStore";

interface NodeSettingsDialogProps {
  open: boolean;
  node?: WorkflowNode;
  methodEntry?: MethodRegistryEntry;
  sourceNodes: Array<{ id: string; name: string; output?: unknown }>;
  callCount: number;
  callTarget: number | null;
  onClose: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onRunNode: () => void;
  onRunFromHere: () => void;
  onParamChange: (paramName: string, value: ParamValue) => void;
  onRawParamsChange: (raw: string) => void;
  onRepeatChange: (value: Partial<NodeRepeat>) => void;
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

export function NodeSettingsDialog({
  open,
  node,
  methodEntry,
  sourceNodes,
  callCount,
  callTarget,
  onClose,
  onRename,
  onDelete,
  onRunNode,
  onRunFromHere,
  onParamChange,
  onRawParamsChange,
  onRepeatChange,
}: NodeSettingsDialogProps) {
  const outputText =
    node?.output === undefined
      ? "No output yet. Run node to see response."
      : stringifyOutput(node.output);

  if (!open || !node) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={onClose} role="presentation">
      <section
        className="max-h-[90vh] w-full max-w-6xl overflow-hidden rounded-xl border border-border bg-background shadow-2xl shadow-black/45"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="rounded border border-primary/40 bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
              {node.method}
            </span>
            <Input
              value={node.name}
              onChange={(event) => onRename(event.target.value)}
              className="h-8 max-w-sm text-xs"
              placeholder="Node Name"
              aria-label="Node name"
            />
            <span className="rounded border border-border bg-background/50 px-2 py-0.5 font-mono text-[11px] text-foreground/75">
              {callCount} / {callTarget === null ? "-" : callTarget}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(node.status)}>{node.status}</Badge>
            <QuickTooltip content="Delete this node">
              <Button size="sm" variant="destructive" className="h-8 w-8 p-0" onClick={onDelete} aria-label="Delete this node">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </QuickTooltip>
            <QuickTooltip content="Close">
              <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={onClose} aria-label="Close settings">
                <X className="h-3.5 w-3.5" />
              </Button>
            </QuickTooltip>
          </div>
        </header>

        <div className="max-h-[calc(90vh-57px)] overflow-auto p-4">
          <div className="mb-4 rounded-md border border-border bg-background/55 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs text-foreground/85">
              <Checkbox
                checked={node.repeat.enabled}
                onChange={(event) => onRepeatChange({ enabled: event.target.checked })}
                aria-label="Enable repeat run"
              />
              <span>Enable repeat</span>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-foreground/80">
              <label className="flex items-center gap-2">
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

              <label className="flex items-center gap-2">
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

              <label className="flex items-center gap-2">
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
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex h-[520px] flex-col rounded-md border border-border bg-background/60 p-3">
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

            <div className="flex h-[520px] flex-col rounded-md border border-border bg-background/60 p-3">
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

          <div className="mt-4 flex flex-wrap gap-2">
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
        </div>
      </section>
    </div>
  );
}
