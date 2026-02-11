"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface QuickTooltipProps {
  content: string;
  children: ReactNode;
  className?: string;
}

export function QuickTooltip({ content, children, className }: QuickTooltipProps) {
  return (
    <span className={cn("group/tooltip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 translate-y-1 whitespace-nowrap rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground opacity-0 shadow-lg transition-all delay-0 duration-75 ease-out group-focus-within/tooltip:translate-y-0 group-focus-within/tooltip:opacity-100 group-focus-within/tooltip:delay-75 group-hover/tooltip:translate-y-0 group-hover/tooltip:opacity-100 group-hover/tooltip:delay-75"
      >
        {content}
      </span>
    </span>
  );
}
