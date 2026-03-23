"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { JsonPathPicker } from "@/components/JsonPathPicker";
import { getByPath } from "@/lib/path";
import { Input } from "@/components/ui/input";
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
const CUSTOM_LITERAL_SENTINEL = "__custom_input__";

/** Fields that are fixed choices and should never allow a Reference source. */
const LITERAL_ONLY_FIELDS = new Set(["operation", "code"]);

const PREDEFINED_LITERAL_OPTIONS: Record<string, string[]> = {
  commitment: ["processed", "confirmed", "finalized"],
  encoding: ["base58", "base64", "base64+zstd", "jsonParsed", "json"],
  operation: ["add", "subtract", "multiply", "divide"],
  subscriptionmethod: [
    "accountSubscribe",
    "logsSubscribe",
    "programSubscribe",
    "slotSubscribe",
    "rootSubscribe",
    "signatureSubscribe",
    "blockSubscribe",
  ],
};

interface DynamicField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

const WS_SUBSCRIPTION_FIELDS: Record<string, DynamicField[]> = {
  accountSubscribe: [
    { name: "pubkey", type: "string", required: true, description: "Account public key to monitor." },
    { name: "commitment", type: "string", required: false, description: "Commitment level. finalized | confirmed | processed" },
    { name: "encoding", type: "string", required: false, description: "Encoding format. base58 | base64 | base64+zstd | jsonParsed" },
  ],
  logsSubscribe: [
    { name: "filter", type: "string", required: true, description: "Filter type: \"all\", \"allWithVotes\", or a program public key." },
    { name: "commitment", type: "string", required: false, description: "Commitment level. finalized | confirmed | processed" },
  ],
  programSubscribe: [
    { name: "programId", type: "string", required: true, description: "Program public key." },
    { name: "commitment", type: "string", required: false, description: "Commitment level. finalized | confirmed | processed" },
    { name: "encoding", type: "string", required: false, description: "Encoding format. base58 | base64 | base64+zstd | jsonParsed" },
    { name: "filters", type: "json", required: false, description: "Array of filter objects. e.g. [{\"dataSize\": 80}]" },
  ],
  signatureSubscribe: [
    { name: "signature", type: "string", required: true, description: "Transaction signature to monitor." },
    { name: "commitment", type: "string", required: false, description: "Commitment level. finalized | confirmed | processed" },
  ],
  blockSubscribe: [
    { name: "filter", type: "string", required: true, description: "Filter: \"all\" or a JSON object like {\"mentionsAccountOrProgram\": \"<pubkey>\"}." },
    { name: "commitment", type: "string", required: false, description: "Commitment level. finalized | confirmed | processed" },
    { name: "encoding", type: "string", required: false, description: "Encoding format. base58 | base64 | base64+zstd | jsonParsed" },
  ],
  slotSubscribe: [],
  rootSubscribe: [],
};

function getPresetOptions(fieldName: string): string[] | undefined {
  const normalizedFieldName = fieldName.trim().toLowerCase();
  const direct = PREDEFINED_LITERAL_OPTIONS[normalizedFieldName];
  if (direct) {
    return direct;
  }

  const tail = normalizedFieldName.split(".").at(-1);
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

function LiteralTextarea({
  storeValue,
  onChange,
  placeholder,
  className,
}: {
  storeValue: unknown;
  onChange: (value: unknown) => void;
  placeholder?: string;
  className?: string;
}) {
  const [localValue, setLocalValue] = useState(() => serializeLiteral(storeValue));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setLocalValue(serializeLiteral(storeValue));
    }
  }, [storeValue]);

  return (
    <Textarea
      className={className}
      value={localValue}
      onChange={(event) => {
        setLocalValue(event.target.value);
        onChange(parseLiteralInput(event.target.value));
      }}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={() => {
        focusedRef.current = false;
        setLocalValue(serializeLiteral(storeValue));
      }}
      placeholder={placeholder}
    />
  );
}

export function ParamEditor({
  node,
  methodEntry,
  sourceNodes,
  onParamChange,
  onRawParamsChange,
}: ParamEditorProps) {
  const selectedSubscriptionMethod = useMemo(() => {
    if (methodEntry?.transport !== "websocket") return null;
    const param = node.params.find((p) => p.name === "subscriptionMethod");
    if (!param || param.value.type !== "literal") return null;
    const val = param.value.value;
    return typeof val === "string" && val !== CUSTOM_LITERAL_SENTINEL && val.length > 0 ? val : null;
  }, [methodEntry, node.params]);

  const tableSchema = useMemo(() => {
    if (methodEntry?.params?.kind !== "table") {
      return null;
    }

    if (methodEntry.transport === "websocket" && selectedSubscriptionMethod) {
      const dynamicFields = WS_SUBSCRIPTION_FIELDS[selectedSubscriptionMethod] ?? [];
      const staticFields = methodEntry.params.fields;
      const subscriptionMethodField = staticFields.find((f) => f.name === "subscriptionMethod");
      const extraParamsField = staticFields.find((f) => f.name === "extraParams");

      return {
        kind: "table" as const,
        fields: [
          ...(subscriptionMethodField ? [subscriptionMethodField] : []),
          ...dynamicFields,
          ...(extraParamsField ? [extraParamsField] : []),
        ],
      };
    }

    return methodEntry.params;
  }, [methodEntry, selectedSubscriptionMethod]);

  if (!tableSchema) {
    return (
      <div className="space-y-2 rounded-md border border-border bg-background/60 p-3">
        <Label htmlFor={`${node.id}-raw-params`}>Params (raw JSON)</Label>
        <Textarea
          id={`${node.id}-raw-params`}
          className="font-mono text-xs"
          value={node.rawParamsJson}
          onChange={(event) => onRawParamsChange(event.target.value)}
          placeholder='{"id":"assetMintAddress"}'
        />
        <p className="text-xs text-foreground/65">Unknown schema: enter params as valid JSON (object or array).</p>
      </div>
    );
  }

  if (methodEntry?.method === "Script") {
    const inputParam = node.params.find((p) => p.name === "input") ?? {
      name: "input",
      value: { type: "literal", value: null } as ParamValue,
    };
    const codeParam = node.params.find((p) => p.name === "code");
    const codeValue = codeParam?.value.type === "literal" && typeof codeParam.value.value === "string" ? codeParam.value.value : "";
    const isRef = inputParam.value.type === "ref";

    return (
      <div className="space-y-3">
        {/* Input data */}
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-foreground">Input</p>
              <p className="text-xs text-foreground/65">Data available as <code className="rounded bg-black/30 px-1">input</code> in the script.</p>
            </div>
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
              value={isRef ? "ref" : "literal"}
              onChange={(event) => {
                if (event.target.value === "ref") {
                  if (sourceNodes.length === 0) return;
                  onParamChange("input", { type: "ref", nodeId: sourceNodes[0]?.id ?? "", path: "" });
                } else {
                  onParamChange("input", { type: "literal", value: null });
                }
              }}
            >
              <option value="literal">Literal</option>
              <option value="ref" disabled={sourceNodes.length === 0}>Reference</option>
            </select>
          </div>
          {isRef && inputParam.value.type === "ref" ? (
            <JsonPathPicker
              sourceNodes={sourceNodes}
              selectedNodeId={inputParam.value.nodeId}
              selectedPath={inputParam.value.path}
              onChange={(value) => {
                onParamChange("input", { type: "ref", nodeId: value.nodeId, path: value.path });
              }}
            />
          ) : (
            <Textarea
              className="min-h-16 font-mono text-xs"
              value={inputParam.value.type === "literal" ? (typeof inputParam.value.value === "string" ? inputParam.value.value : JSON.stringify(inputParam.value.value ?? "", null, 2)) : ""}
              onChange={(event) => {
                let parsed: unknown = event.target.value;
                try { parsed = JSON.parse(event.target.value); } catch { /* keep as string */ }
                onParamChange("input", { type: "literal", value: parsed });
              }}
              placeholder="JSON value or leave empty"
            />
          )}
        </div>

        {/* Code editor */}
        <div className="space-y-2 rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium text-foreground">Code</p>
            <p className="text-xs text-foreground/65">
              JavaScript function body. Access data via <code className="rounded bg-black/30 px-1">input</code>. Use <code className="rounded bg-black/30 px-1">return</code> to set the output.
              Returning <code className="rounded bg-black/30 px-1">null</code> skips downstream nodes in a List iteration.
            </p>
          </div>
          <Textarea
            className="min-h-40 font-mono text-xs leading-relaxed"
            value={codeValue}
            onChange={(event) => onParamChange("code", { type: "literal", value: event.target.value })}
            placeholder={`// Example: find index of token program\nconst idx = input.transaction.message.accountKeys.findIndex(\n  k => k === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"\n);\nreturn idx >= 0 ? { tokenProgramIndex: idx, tx: input } : null;`}
            spellCheck={false}
          />
        </div>
      </div>
    );
  }

  if (methodEntry?.method === "Filter") {
    const FILTER_OPERATORS = [">", "<", ">=", "<=", "!=", "==", "contains", "not contains", "is null", "is not null"];

    const inputParam = node.params.find((p) => p.name === "input") ?? {
      name: "input",
      value: { type: "ref", nodeId: sourceNodes[0]?.id ?? "", path: "" } as ParamValue,
    };
    const pathParam = node.params.find((p) => p.name === "path");
    const operatorParam = node.params.find((p) => p.name === "operator");
    const compareToParam = node.params.find((p) => p.name === "compareTo");

    const pathValue = pathParam?.value.type === "literal" && typeof pathParam.value.value === "string" ? pathParam.value.value : "";
    const operatorValue = operatorParam?.value.type === "literal" && typeof operatorParam.value.value === "string" ? operatorParam.value.value : "";
    const compareToValue = compareToParam?.value.type === "literal" ? compareToParam.value.value : null;
    const hideCompareTo = operatorValue === "is null" || operatorValue === "is not null";

    // Get the array output from the selected source node to extract keys
    const inputRef = inputParam.value.type === "ref" ? inputParam.value : null;
    const selectedNodeId = inputRef?.nodeId ?? sourceNodes[0]?.id ?? "";
    const selectedSourceNode = sourceNodes.find((n) => n.id === selectedNodeId);
    const sourceOutput = selectedSourceNode?.output;

    // Filter always takes the full output as its array
    const resolvedArray = sourceOutput;
    const sampleItem = Array.isArray(resolvedArray) && resolvedArray.length > 0 ? resolvedArray[0] : null;

    // Extract dot-paths from the sample item (one level deep for simplicity)
    const availableKeys = useMemo(() => {
      if (!sampleItem || typeof sampleItem !== "object" || sampleItem === null) return [];
      const keys: string[] = [];
      const walk = (obj: Record<string, unknown>, prefix: string) => {
        for (const [key, val] of Object.entries(obj)) {
          const fullKey = prefix ? `${prefix}.${key}` : key;
          keys.push(fullKey);
          if (val && typeof val === "object" && !Array.isArray(val)) {
            walk(val as Record<string, unknown>, fullKey);
          }
        }
      };
      walk(sampleItem as Record<string, unknown>, "");
      return keys;
    }, [sampleItem]);

    return (
      <div className="space-y-3">
        {/* Source array (ref only — just pick the node) */}
        <div className="space-y-2 rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium text-foreground">Input Array</p>
            <p className="text-xs text-foreground/65">Select a node that outputs an array.</p>
          </div>
          <select
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            value={selectedNodeId}
            onChange={(event) => onParamChange("input", { type: "ref", nodeId: event.target.value, path: "" })}
          >
            {sourceNodes.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </select>
        </div>

        {/* Key to filter on */}
        <div className="space-y-2 rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium text-foreground">Key</p>
            <p className="text-xs text-foreground/65">Which property on each item to test.</p>
          </div>
          {availableKeys.length > 0 ? (
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
              value={pathValue}
              onChange={(event) => onParamChange("path", { type: "literal", value: event.target.value })}
            >
              <option value="">Select a key</option>
              {availableKeys.map((key) => (
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
          ) : (
            <Input
              className="font-mono text-xs"
              value={pathValue}
              onChange={(event) => onParamChange("path", { type: "literal", value: event.target.value })}
              placeholder="e.g. meta.err"
            />
          )}
        </div>

        {/* Operator */}
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm font-medium text-foreground">Operator</p>
          <select
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            value={operatorValue}
            onChange={(event) => onParamChange("operator", { type: "literal", value: event.target.value })}
          >
            <option value="">Select operator</option>
            {FILTER_OPERATORS.map((op) => (
              <option key={op} value={op}>{op}</option>
            ))}
          </select>
        </div>

        {/* Compare To */}
        {!hideCompareTo ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">Compare To</p>
              <p className="text-xs text-foreground/65">Value to compare against.</p>
            </div>
            <LiteralTextarea
              className="min-h-16 font-mono text-xs"
              storeValue={compareToValue}
              onChange={(value) => onParamChange("compareTo", { type: "literal", value })}
              placeholder="Value (JSON or plain text)"
            />
          </div>
        ) : null}
      </div>
    );
  }

  if (methodEntry?.method === "List") {
    const listParam = node.params.find((p) => p.name === "value") ?? {
      name: "value",
      value: { type: "literal", value: null } as ParamValue,
    };
    const isRef = listParam.value.type === "ref";
    const listValue = listParam.value.type === "literal" ? listParam.value.value : null;
    const items: unknown[] = Array.isArray(listValue) ? listValue : [];

    const updateItems = (next: unknown[]) => {
      onParamChange("value", { type: "literal", value: next });
    };

    return (
      <div className="space-y-3">
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-foreground">List Items</p>
              <p className="text-xs text-foreground/65">
                {isRef ? "Referencing an array from another node." : "Each row is one item in the array."}
              </p>
            </div>
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
              value={isRef ? "ref" : "literal"}
              onChange={(event) => {
                if (event.target.value === "ref") {
                  if (sourceNodes.length === 0) return;
                  onParamChange("value", { type: "ref", nodeId: sourceNodes[0]?.id ?? "", path: "" });
                } else {
                  onParamChange("value", { type: "literal", value: [] });
                }
              }}
            >
              <option value="literal">Manual</option>
              <option value="ref" disabled={sourceNodes.length === 0}>Reference</option>
            </select>
          </div>

          {isRef && listParam.value.type === "ref" ? (
            <JsonPathPicker
              sourceNodes={sourceNodes}
              selectedNodeId={listParam.value.nodeId}
              selectedPath={listParam.value.path}
              onChange={(value) => {
                onParamChange("value", { type: "ref", nodeId: value.nodeId, path: value.path });
              }}
            />
          ) : (
            <>
              <div className="space-y-2">
                {items.map((item, index) => (
                  <div key={`list-item-${index}`} className="flex items-center gap-2">
                    <span className="w-6 text-right font-mono text-[11px] text-foreground/40">{index + 1}</span>
                    <Input
                      className="flex-1 font-mono text-xs"
                      value={typeof item === "string" ? item : JSON.stringify(item)}
                      onChange={(event) => {
                        const next = [...items];
                        const raw = event.target.value.trim();
                        try {
                          next[index] = JSON.parse(raw);
                        } catch {
                          next[index] = event.target.value;
                        }
                        updateItems(next);
                      }}
                      placeholder="Value"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 w-8 shrink-0 p-0 text-foreground/50 hover:text-destructive"
                      onClick={() => {
                        const next = items.filter((_, i) => i !== index);
                        updateItems(next);
                      }}
                      aria-label="Remove item"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs"
                onClick={() => updateItems([...items, ""])}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add Item
              </Button>
            </>
          )}
        </div>
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
        const isBooleanField = field.type?.toLowerCase() === "boolean";
        const isLiteralOnly = LITERAL_ONLY_FIELDS.has(field.name.trim().toLowerCase());
        const presetOptions = getPresetOptions(field.name);
        const literalValue = param.value.type === "literal" ? param.value.value : null;
        const isPresetLiteral =
          presetOptions &&
          typeof literalValue === "string" &&
          presetOptions.includes(literalValue);
        const isCustomSentinel = typeof literalValue === "string" && literalValue === CUSTOM_LITERAL_SENTINEL;
        const presetSelectValue =
          literalValue === null || literalValue === undefined
            ? ""
            : isCustomSentinel || (typeof literalValue === "string" && literalValue === "")
              ? CUSTOM_LITERAL_OPTION
              : isPresetLiteral
                ? (literalValue as string)
                : typeof literalValue === "string" && literalValue.length > 0 && !isPresetLiteral
                  ? CUSTOM_LITERAL_OPTION
                  : "";

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

              {isLiteralOnly ? null : (
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
              )}
            </div>

            {param.value.type === "literal" ? (
              <div className="space-y-2">
                {isBooleanField ? (
                  <select
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                    value={
                      literalValue === true
                        ? "true"
                        : literalValue === false
                          ? "false"
                          : "null"
                    }
                    onChange={(event) => {
                      if (event.target.value === "true") {
                        onParamChange(field.name, {
                          type: "literal",
                          value: true,
                        });
                        return;
                      }

                      if (event.target.value === "false") {
                        onParamChange(field.name, {
                          type: "literal",
                          value: false,
                        });
                        return;
                      }

                      onParamChange(field.name, {
                        type: "literal",
                        value: null,
                      });
                    }}
                  >
                    <option value="null">null</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : null}

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
                          value: typeof literalValue === "string" && !isPresetLiteral && !isCustomSentinel ? literalValue : CUSTOM_LITERAL_SENTINEL,
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

                {!isBooleanField && (!presetOptions || presetSelectValue === CUSTOM_LITERAL_OPTION) ? (
                  <LiteralTextarea
                    className="min-h-16 font-mono text-xs"
                    storeValue={isCustomSentinel ? "" : param.value.value}
                    onChange={(value) => {
                      onParamChange(field.name, {
                        type: "literal",
                        value,
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
