"use client";

import { useEffect, useRef, useState } from "react";
import { FileDown, FileUp, X } from "lucide-react";

import { formatZodError, parseWorkflowImport, type WorkflowExport } from "@/lib/workflowSchema";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { QuickTooltip } from "@/components/ui/quick-tooltip";

interface ImportExportProps {
  includeOutputs: boolean;
  onIncludeOutputsChange: (next: boolean) => void;
  onExport: (includeOutputs: boolean) => WorkflowExport;
  onImport: (payload: WorkflowExport) => void;
}

export function ImportExport({
  includeOutputs,
  onIncludeOutputsChange,
  onExport,
  onImport,
}: ImportExportProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState<string>("");
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [fileName, setFileName] = useState(
    () => `helius-flow-${new Date().toISOString().slice(0, 10)}`,
  );

  // Close dropdown on outside click
  useEffect(() => {
    if (!showExportPanel) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowExportPanel(false);
      }
    };
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [showExportPanel]);

  const doExport = () => {
    const payload = onExport(includeOutputs);
    const safeName = fileName.trim() || "helius-flow-export";
    const fullName = safeName.endsWith(".json") ? safeName : `${safeName}.json`;

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fullName;
    anchor.click();
    URL.revokeObjectURL(url);

    setMessage("Exported!");
    setShowExportPanel(false);
    setTimeout(() => setMessage(""), 2000);
  };

  const importWorkflow = async (file: File) => {
    setMessage("");

    try {
      const raw = await file.text();
      const json = JSON.parse(raw) as unknown;
      const parsed = parseWorkflowImport(json);

      if (!parsed.success) {
        setMessage(`Import failed: ${formatZodError(parsed.error).join("; ")}`);
        return;
      }

      onImport(parsed.data);
      setMessage("Imported!");
      setTimeout(() => setMessage(""), 2000);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Unknown import error";
      setMessage(`Import failed: ${messageText}`);
    }
  };

  return (
    <div className="relative flex items-center gap-1.5">
      <QuickTooltip content="Export workflow">
        <Button
          size="sm"
          className="h-8 w-8 p-0"
          variant="outline"
          onClick={() => {
            setShowExportPanel((v) => !v);
            setMessage("");
          }}
          aria-label="Export workflow"
        >
          <FileUp className="h-3.5 w-3.5" />
        </Button>
      </QuickTooltip>
      <QuickTooltip content="Import workflow">
        <Button
          size="sm"
          className="h-8 w-8 p-0"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Import workflow"
        >
          <FileDown className="h-3.5 w-3.5" />
        </Button>
      </QuickTooltip>

      <input
        ref={fileInputRef}
        hidden
        accept="application/json"
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void importWorkflow(file);
          }
          event.currentTarget.value = "";
        }}
      />

      {/* Export dropdown */}
      {showExportPanel && (
        <div
          ref={dropdownRef}
          className="absolute right-0 top-full mt-2 w-72 rounded-lg border border-border bg-background/95 p-3 shadow-xl backdrop-blur-sm"
        >
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-foreground">Export Workflow</p>
            <button
              className="rounded p-0.5 text-foreground/50 hover:text-foreground"
              onClick={() => setShowExportPanel(false)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <label className="mb-1.5 block text-[11px] text-foreground/60">File name</label>
          <Input
            className="mb-3 h-8 text-xs"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            placeholder="my-workflow"
            onKeyDown={(e) => {
              if (e.key === "Enter") doExport();
            }}
          />

          <label className="mb-3 flex items-center gap-2 text-xs text-foreground/80">
            <Checkbox
              checked={includeOutputs}
              onChange={(event) => onIncludeOutputsChange(event.target.checked)}
            />
            Include outputs in export
          </label>

          <Button size="sm" className="w-full" onClick={doExport}>
            <FileUp className="mr-1.5 h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      )}

      {message && (
        <span className="ml-1 text-[11px] text-foreground/60">{message}</span>
      )}
    </div>
  );
}
