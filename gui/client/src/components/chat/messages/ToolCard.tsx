import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { ToolMessage } from "../../../types/messages";
import { summarizeInput } from "../../../lib/tool";
import { cn } from "../../../lib/cn";

const PRE_BASE =
  "m-0 max-h-[260px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-normal";

export function ToolCard({ tool }: { tool: ToolMessage }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeInput(tool.name, tool.input);
  const state = tool.isError ? "error" : tool.result === null ? "running" : "done";
  return (
    <div className="self-stretch rounded-lg border border-border-visible bg-secondary">
      <button
        className="flex w-full cursor-pointer items-center gap-2 bg-transparent px-3 py-2 text-left font-mono text-[13px] text-foreground"
        onClick={() => setOpen(!open)}
      >
        <span className="text-muted-foreground" aria-hidden>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="font-semibold text-primary">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
        <span
          className={cn("text-[11px]", tool.isError ? "text-destructive" : "text-muted-foreground")}
        >
          {state}
        </span>
      </button>
      {open && (
        <div className="border-t border-border-visible px-3 py-2.5">
          <pre className={cn(PRE_BASE, "text-muted-foreground")}>
            {JSON.stringify(tool.input, null, 2).slice(0, 2000)}
          </pre>
          {tool.result != null && (
            <pre className={cn(PRE_BASE, "mt-2 text-foreground")}>{tool.result}</pre>
          )}
        </div>
      )}
    </div>
  );
}
