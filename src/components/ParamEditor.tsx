"use client";

import { useMemo } from "react";

import { JsonPathPicker } from "@/components/JsonPathPicker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { MethodRegistryEntry } from "@/lib/methodRegistry";
import type { ParamValue } from "@/lib/workflowSchema";
import type { WorkflowNode } from "@/store/workflowStore";

interface ParamEditorProps {
  node: WorkflowNode;
  methodEntry?: MethodRegistryEntry;
  sourceNodes: Array<{ id: string; name: string; output?: unknown }>;
  onParamChange: (paramName: string, value: ParamValue) => void;
  onRawParamsChange: (raw: string) => void;
}

const CUSTOM_LITERAL_OPTION = "__custom__";

const PREDEFINED_LITERAL_OPTIONS: Record<string, string[]> = {
  commitment: ["processed", "confirmed", "finalized"],
  encoding: ["base58", "base64", "base64+zstd", "jsonParsed", "json"],
};

function getPresetOptions(fieldName: string): string[] | undefined {
  const direct = PREDEFINED_LITERAL_OPTIONS[fieldName];
  if (direct) {
    return direct;
  }

  const tail = fieldName.split(".").at(-1);
  if (!tail) {
    return undefined;
  }

  return PREDEFINED_LITERAL_OPTIONS[tail];
}

function serializeLiteral(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseLiteralInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

export function ParamEditor({
  node,
  methodEntry,
  sourceNodes,
  onParamChange,
  onRawParamsChange,
}: ParamEditorProps) {
  const tableSchema = useMemo(() => {
    if (methodEntry?.params?.kind !== "table") {
      return null;
    }

    return methodEntry.params;
  }, [methodEntry]);

  if (!tableSchema) {
    return (
      <div className="space-y-2 rounded-md border border-border bg-background/60 p-3">
        <Label htmlFor={`${node.id}-raw-params`}>Params (raw JSON array)</Label>
        <Textarea
          id={`${node.id}-raw-params`}
          className="font-mono text-xs"
          value={node.rawParamsJson}
          onChange={(event) => onRawParamsChange(event.target.value)}
          placeholder='["address", { "encoding": "jsonParsed" }]'
        />
        <p className="text-xs text-foreground/65">Unknown schema: enter parameters as a JSON array.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tableSchema.fields.map((field) => {
        const param = node.params.find((entry) => entry.name === field.name) ?? {
          name: field.name,
          value: { type: "literal", value: null } as ParamValue,
        };
        const presetOptions = getPresetOptions(field.name);
        const literalValue = param.value.type === "literal" ? param.value.value : null;
        const isPresetLiteral =
          presetOptions &&
          typeof literalValue === "string" &&
          presetOptions.includes(literalValue);
        const presetSelectValue =
          literalValue === null || literalValue === undefined || literalValue === ""
            ? ""
            : isPresetLiteral
              ? (literalValue as string)
              : CUSTOM_LITERAL_OPTION;

        return (
          <div key={`${node.id}-${field.name}`} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-foreground">{field.name}</p>
                <p className="text-xs text-foreground/65">
                  {field.type ?? "unknown type"}
                  {field.required ? " / required" : " / optional"}
                </p>
              </div>

              <select
                className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                value={param.value.type}
                onChange={(event) => {
                  if (event.target.value === "ref") {
                    if (sourceNodes.length === 0) {
                      return;
                    }
                    const sourceNode = sourceNodes[0];
                    onParamChange(field.name, {
                      type: "ref",
                      nodeId: sourceNode?.id ?? "",
                      path: "",
                    });
                    return;
                  }

                  onParamChange(field.name, {
                    type: "literal",
                    value: null,
                  });
                }}
              >
                <option value="literal">Literal</option>
                <option value="ref" disabled={sourceNodes.length === 0}>
                  Reference
                </option>
              </select>
            </div>

            {param.value.type === "literal" ? (
              <div className="space-y-2">
                {presetOptions ? (
                  <select
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                    value={presetSelectValue}
                    onChange={(event) => {
                      if (event.target.value === "") {
                        onParamChange(field.name, {
                          type: "literal",
                          value: null,
                        });
                        return;
                      }

                      if (event.target.value === CUSTOM_LITERAL_OPTION) {
                        onParamChange(field.name, {
                          type: "literal",
                          value: typeof literalValue === "string" && !isPresetLiteral ? literalValue : "",
                        });
                        return;
                      }

                      onParamChange(field.name, {
                        type: "literal",
                        value: event.target.value,
                      });
                    }}
                  >
                    <option value="">Select preset value</option>
                    {presetOptions.map((option) => (
                      <option key={`${field.name}-${option}`} value={option}>
                        {option}
                      </option>
                    ))}
                    <option value={CUSTOM_LITERAL_OPTION}>Custom value</option>
                  </select>
                ) : null}

                {(!presetOptions || presetSelectValue === CUSTOM_LITERAL_OPTION) ? (
                  <Textarea
                    className="min-h-16 font-mono text-xs"
                    value={serializeLiteral(param.value.value)}
                    onChange={(event) => {
                      onParamChange(field.name, {
                        type: "literal",
                        value: parseLiteralInput(event.target.value),
                      });
                    }}
                    placeholder="JSON value or plain text"
                  />
                ) : null}
              </div>
            ) : (
              <JsonPathPicker
                sourceNodes={sourceNodes}
                selectedNodeId={param.value.nodeId}
                selectedPath={param.value.path}
                onChange={(value) => {
                  onParamChange(field.name, {
                    type: "ref",
                    nodeId: value.nodeId,
                    path: value.path,
                  });
                }}
              />
            )}

            {field.description ? <p className="text-xs text-foreground/65">{field.description}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
