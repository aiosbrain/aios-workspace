import type { MemoryMessage } from "../../../types/messages";

export function MemoryCard({
  message,
  onUndo,
}: {
  message: MemoryMessage;
  onUndo: (id: string) => void;
}) {
  return (
    <div className="flex max-w-[92%] flex-wrap items-center gap-1.5 self-center rounded-md border border-[var(--accent-line)] bg-[var(--accent-soft)] px-[11px] py-1.5 text-xs text-muted-foreground">
      💾 Memory updated ·{" "}
      <code className="rounded-[5px] bg-secondary px-[5px] py-px text-[11.5px]">
        {message.file}
      </code>{" "}
      — {message.summary}
      <span className="opacity-70"> (takes effect next session)</span>
      {message.undone ? (
        <span className="text-emerald"> · undone</span>
      ) : message.undoFailed ? (
        <span className="text-destructive"> · undo unavailable (file changed)</span>
      ) : (
        <button
          className="ml-1 cursor-pointer rounded-[7px] border border-border-visible bg-secondary px-2.5 py-0.5 text-[11.5px] font-semibold text-foreground hover:border-primary"
          onClick={() => onUndo(message.id)}
        >
          undo
        </button>
      )}
    </div>
  );
}
