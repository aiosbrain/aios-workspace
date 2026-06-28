import type { MemoryMessage } from "../../../types/messages";

export function MemoryCard({
  message,
  onUndo,
}: {
  message: MemoryMessage;
  onUndo: (id: string) => void;
}) {
  return (
    <div className="msg memory">
      💾 Memory updated · <code>{message.file}</code> — {message.summary}
      <span className="memory-sub"> (takes effect next session)</span>
      {message.undone ? (
        <span className="memory-done"> · undone</span>
      ) : message.undoFailed ? (
        <span className="memory-done"> · undo unavailable (file changed)</span>
      ) : (
        <button className="memory-undo" onClick={() => onUndo(message.id)}>
          undo
        </button>
      )}
    </div>
  );
}
