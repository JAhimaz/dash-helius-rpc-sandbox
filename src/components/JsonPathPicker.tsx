"use client";

import { useMemo, useState } from "react";

import { formatPathForDisplay, enumeratePaths } from "@/lib/path";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QuickTooltip } from "@/components/ui/quick-tooltip";

interface SourceNode {
  id: string;
  name: string;
  output?: unknown;
}

interface JsonPathPickerProps {
  sourceNodes: SourceNode[];
  selectedNodeId?: string;
  selectedPath?: string;
  onChange: (value: { nodeId: string; path: string }) => void;
}

export function JsonPathPicker({
  sourceNodes,
  selectedNodeId,
  selectedPath,
  onChange,
}: JsonPathPickerProps) {
  const [query, setQuery] = useState("");

  const activeNode = useMemo(
    () => sourceNodes.find((node) => node.id === selectedNodeId) ?? sourceNodes[0],
    [selectedNodeId, sourceNodes],
  );

  const paths = useMemo(() => {
    if (!activeNode || activeNode.output === undefined) {
      return [];
    }

    return enumeratePaths(activeNode.output);
  }, [activeNode]);

  const filteredPaths = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return paths;
    }

    return paths.filter((path) => path.toLowerCase().includes(needle));
  }, [paths, query]);

  return (
    <div className="space-y-2 rounded-md border border-border bg-background/60 p-3">
      <div className="grid gap-1">
        <Label htmlFor="ref-node-select">Reference Node</Label>
        <select
          id="ref-node-select"
          className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          value={activeNode?.id ?? ""}
          onChange={(event) => {
            onChange({
              nodeId: event.target.value,
              path: "",
            });
          }}
        >
          {sourceNodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-1">
        <Label htmlFor="ref-path-search">Path Search</Label>
        <Input
          id="ref-path-search"
          placeholder="Search result[0].pubkey"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="max-h-28 overflow-auto rounded-md border border-border bg-background p-1">
        {activeNode?.output === undefined ? (
          <p className="p-2 text-xs text-foreground/65">Run the selected node to generate selectable JSON paths.</p>
        ) : filteredPaths.length === 0 ? (
          <p className="p-2 text-xs text-foreground/65">No paths match the search filter.</p>
        ) : (
          <ul className="space-y-1">
            {filteredPaths.map((path) => {
              const isSelected = path === selectedPath;
              return (
                <li key={path}>
                  <QuickTooltip
                    content={`Use ${formatPathForDisplay(path)} from ${activeNode?.name ?? "selected node"}`}
                    className="block w-full"
                  >
                    <Button
                      className="h-auto w-full justify-start px-2 py-1 text-left"
                      variant={isSelected ? "default" : "secondary"}
                      size="sm"
                      aria-label={`Use ${formatPathForDisplay(path)} from ${activeNode?.name ?? "selected node"}`}
                      onClick={() => {
                        if (!activeNode) {
                          return;
                        }
                        onChange({
                          nodeId: activeNode.id,
                          path,
                        });
                      }}
                    >
                      {formatPathForDisplay(path)}
                    </Button>
                  </QuickTooltip>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selectedNodeId && selectedPath ? (
        <p className="text-xs text-foreground/75">
          {sourceNodes.find((node) => node.id === selectedNodeId)?.name ?? "Node"}
          {" -> "}
          {formatPathForDisplay(selectedPath)}
        </p>
      ) : null}
    </div>
  );
}
