"use client";

import { useRef, useState } from "react";
import { FileDown, FileUp } from "lucide-react";

import { formatZodError, parseWorkflowImport, type WorkflowExport } from "@/lib/workflowSchema";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

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
  const [message, setMessage] = useState<string>("");

  const exportWorkflow = () => {
    const payload = onExport(includeOutputs);
    const fileName = `helius-workflow-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);

    setMessage("Workflow exported.");
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
      setMessage("Workflow imported.");
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Unknown import error";
      setMessage(`Import failed: ${messageText}`);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-xs text-foreground/80">
        <Checkbox
          checked={includeOutputs}
          onChange={(event) => onIncludeOutputsChange(event.target.checked)}
        />
        Include outputs in export
      </label>

      <Button
        size="sm"
        className="h-8 w-8 p-0"
        variant="outline"
        onClick={exportWorkflow}
        title="Export workflow"
        aria-label="Export workflow"
      >
        <FileUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        className="h-8 w-8 p-0"
        variant="outline"
        onClick={() => fileInputRef.current?.click()}
        title="Import workflow"
        aria-label="Import workflow"
      >
        <FileDown className="h-3.5 w-3.5" />
      </Button>

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

      {message ? <p className="text-xs text-foreground/70">{message}</p> : null}
    </div>
  );
}
