"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { formatPathForDisplay, getByPath } from "@/lib/path";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

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

interface PathEntry {
  path: string;
  label: string;
  indent: number;
  isArray: boolean;
  children?: PathEntry[];
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildArrayChildren(arr: unknown[], basePath: string, depth: number, maxDepth: number): PathEntry[] {
  const children: PathEntry[] = [];
  const sample = arr[0];

  // [each] -> key paths for iteration
  if (isObjectLike(sample)) {
    for (const key of Object.keys(sample)) {
      const childPath = basePath ? `${basePath}[].${key}` : `[].${key}`;
      const val = sample[key];
      const entry: PathEntry = {
        path: childPath,
        label: key,
        indent: depth,
        isArray: Array.isArray(val),
      };
      if (Array.isArray(val)) {
        entry.children = buildArrayChildren(val, childPath, depth + 1, maxDepth);
      } else if (isObjectLike(val) && depth < maxDepth) {
        entry.children = buildTree(val, childPath, depth + 1, maxDepth);
      }
      children.push(entry);
    }
  }

  // Individual indexed items
  const maxItems = Math.min(arr.length, 20);
  for (let i = 0; i < maxItems; i += 1) {
    const indexPath = `${basePath}[${i}]`;
    const item = arr[i];
    const entry: PathEntry = {
      path: indexPath,
      label: `[${i}]`,
      indent: depth,
      isArray: Array.isArray(item),
    };
    if (Array.isArray(item) && depth < maxDepth) {
      entry.children = buildArrayChildren(item, indexPath, depth + 1, maxDepth);
    } else if (isObjectLike(item) && depth < maxDepth) {
      entry.children = buildTree(item, indexPath, depth + 1, maxDepth);
    }
    children.push(entry);
  }

  return children;
}

function buildTree(obj: unknown, basePath: string, depth: number, maxDepth: number): PathEntry[] {
  if (depth > maxDepth) return [];
  const entries: PathEntry[] = [];

  if (Array.isArray(obj)) {
    return buildArrayChildren(obj, basePath, depth, maxDepth);
  }

  if (isObjectLike(obj)) {
    for (const [key, child] of Object.entries(obj)) {
      const nextPath = basePath ? `${basePath}.${key}` : key;
      const childIsArray = Array.isArray(child);
      const entry: PathEntry = {
        path: nextPath,
        label: key,
        indent: depth,
        isArray: childIsArray,
      };

      if (childIsArray) {
        entry.children = buildArrayChildren(child, nextPath, depth + 1, maxDepth);
      } else if (isObjectLike(child) && depth < maxDepth) {
        entry.children = buildTree(child, nextPath, depth + 1, maxDepth);
      }

      entries.push(entry);
    }
  }

  return entries;
}

function PathNode({
  entry,
  selectedPath,
  onSelect,
  isEachChild,
}: {
  entry: PathEntry;
  selectedPath?: string;
  onSelect: (path: string) => void;
  isEachChild?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = entry.children && entry.children.length > 0;
  const isSelected = entry.path === selectedPath;

  // Split children into [each] paths and indexed paths for arrays
  const eachChildren = hasChildren
    ? entry.children!.filter((c) => c.path.includes("[]"))
    : [];
  const indexedChildren = hasChildren
    ? entry.children!.filter((c) => !c.path.includes("[]"))
    : [];

  return (
    <li>
      <div
        className="flex items-center"
        style={{ paddingLeft: `${entry.indent * 16}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="flex h-6 w-5 shrink-0 items-center justify-center text-foreground/35 hover:text-foreground/60"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
            isSelected
              ? "bg-primary text-white outline-none"
              : "text-foreground/80 hover:bg-foreground/10",
          )}
          onClick={() => onSelect(entry.path)}
        >
          {isEachChild ? (
            <span className={cn(
              "shrink-0 rounded px-1 py-0.5 text-[10px] font-medium",
              isSelected ? "bg-white/20 text-white" : "bg-primary/10 text-primary",
            )}>each</span>
          ) : null}
          <span className="truncate font-mono">{entry.label}</span>
          {entry.isArray ? (
            <span className="ml-auto shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] text-foreground/40">array</span>
          ) : null}
        </button>
      </div>
      {expanded && hasChildren ? (
        <ul className="mt-0.5">
          {eachChildren.length > 0 ? (
            <>
              <li className="px-2 pt-1.5 pb-0.5" style={{ paddingLeft: `${(entry.indent + 1) * 16 + 20}px` }}>
                <span className="text-[10px] font-medium uppercase tracking-wider text-foreground/30">Each item</span>
              </li>
              <PathNode
                key={`${entry.path}[]`}
                entry={{ path: `${entry.path}[]`, label: "(full object)", indent: entry.indent + 1, isArray: false }}
                selectedPath={selectedPath}
                onSelect={onSelect}
                isEachChild
              />
              {eachChildren.map((child) => (
                <PathNode
                  key={child.path}
                  entry={{ ...child, indent: entry.indent + 1 }}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  isEachChild
                />
              ))}
            </>
          ) : null}
          {indexedChildren.length > 0 ? (
            <>
              {eachChildren.length > 0 ? (
                <li className="px-2 pt-2 pb-0.5" style={{ paddingLeft: `${(entry.indent + 1) * 16 + 20}px` }}>
                  <span className="text-[10px] font-medium uppercase tracking-wider text-foreground/30">By index</span>
                </li>
              ) : null}
              {indexedChildren.map((child) => (
                <PathNode
                  key={child.path}
                  entry={{ ...child, indent: entry.indent + 1 }}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                />
              ))}
            </>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function flatMatchesQuery(entry: PathEntry, needle: string): boolean {
  if (entry.path.toLowerCase().includes(needle) || entry.label.toLowerCase().includes(needle)) return true;
  if (entry.children) return entry.children.some((c) => flatMatchesQuery(c, needle));
  return false;
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

  const pathTree = useMemo(() => {
    if (!activeNode || activeNode.output === undefined) return [];
    return buildTree(activeNode.output, "", 0, 6);
  }, [activeNode]);

  const filteredTree = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return pathTree;
    return pathTree.filter((entry) => flatMatchesQuery(entry, needle));
  }, [pathTree, query]);

  const handleSelect = (path: string) => {
    if (!activeNode) return;
    onChange({ nodeId: activeNode.id, path });
  };

  return (
    <div className="space-y-2 rounded-md border border-border bg-background/60 p-3">
      <div className="grid gap-1">
        <Label htmlFor="ref-node-select" className="text-[11px] uppercase tracking-wide text-foreground/50">Source Node</Label>
        <select
          id="ref-node-select"
          className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          value={activeNode?.id ?? ""}
          onChange={(event) => onChange({ nodeId: event.target.value, path: "" })}
        >
          {sourceNodes.map((node) => (
            <option key={node.id} value={node.id}>{node.name}</option>
          ))}
        </select>
      </div>

      <div className="grid gap-1">
        <Label htmlFor="ref-path-search" className="text-[11px] uppercase tracking-wide text-foreground/50">Search</Label>
        <Input
          id="ref-path-search"
          placeholder="Filter paths..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 text-xs"
        />
      </div>

      <div className="max-h-48 overflow-auto rounded-md border border-border bg-[var(--surface-strong)] py-1">
        {activeNode?.output === undefined ? (
          <p className="p-3 text-center text-xs text-foreground/45">Run the source node first to see available paths.</p>
        ) : filteredTree.length === 0 ? (
          <p className="p-3 text-center text-xs text-foreground/45">No paths match.</p>
        ) : (
          <ul>
            <li>
              <div className="flex items-center">
                <span className="w-5 shrink-0" />
                <button
                  type="button"
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
                    selectedPath === ""
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground/80 hover:bg-foreground/10",
                  )}
                  onClick={() => handleSelect("")}
                >
                  <span className="truncate font-mono italic">(entire output)</span>
                </button>
              </div>
            </li>
            {filteredTree.map((entry) => (
              <PathNode
                key={entry.path}
                entry={entry}
                selectedPath={selectedPath}
                onSelect={handleSelect}
              />
            ))}
          </ul>
        )}
      </div>

      {selectedNodeId && selectedPath !== undefined ? (
        <div className="rounded border border-primary/25 bg-primary/10 px-2.5 py-1.5 text-xs text-primary">
          {sourceNodes.find((node) => node.id === selectedNodeId)?.name ?? "Node"}
          {selectedPath ? ` -> ${formatPathForDisplay(selectedPath)}` : " -> (entire output)"}
        </div>
      ) : null}
    </div>
  );
}
