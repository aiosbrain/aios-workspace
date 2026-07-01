import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import type { UiMessage, PendingPermission } from "../../types/messages";
import { scrollBehavior } from "../../lib/motion";
import { UserMessage } from "./messages/UserMessage";
import { AssistantMessage } from "./messages/AssistantMessage";
import { ToolCard } from "./messages/ToolCard";
import { MemoryCard } from "./messages/MemoryCard";
import { MetaMessage } from "./messages/MetaMessage";
import { PermissionCard } from "./PermissionCard";

interface MessageListProps {
  header: ReactNode;
  messages: UiMessage[];
  permissions: PendingPermission[];
  onUndoMemory: (id: string) => void;
  onRespond: (id: number, allow: boolean) => void;
  onRespondOption: (id: number, optionId: string) => void;
}

/**
 * Scrollable transcript. Smart auto-scroll: only snaps to the newest content when the
 * user is already near the bottom, so reading back through history isn't yanked away.
 */
export function MessageList({
  header,
  messages,
  permissions,
  onUndoMemory,
  onRespond,
  onRespondOption,
}: MessageListProps) {
  const mainRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Pill shows when the user has scrolled up and new content is arriving below them.
  const [showJump, setShowJump] = useState(false);

  const handleScroll = () => {
    const el = mainRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stickRef.current) setShowJump(false);
  };

  const jumpToLatest = () => {
    bottomRef.current?.scrollIntoView({ behavior: scrollBehavior() });
    stickRef.current = true;
    setShowJump(false);
  };

  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ behavior: scrollBehavior() });
    else setShowJump(true); // new content arrived while reading back
  }, [messages, permissions]);

  return (
    <main
      ref={mainRef}
      onScroll={handleScroll}
      className="mx-auto flex w-full max-w-[860px] flex-1 flex-col gap-2.5 overflow-y-auto p-5"
    >
      {header}
      {messages.map((m, i) => {
        switch (m.kind) {
          case "user":
            return <UserMessage key={i} message={m} />;
          case "assistant":
            return <AssistantMessage key={i} message={m} />;
          case "tool":
            return <ToolCard key={i} tool={m} />;
          case "memory":
            return <MemoryCard key={i} message={m} onUndo={onUndoMemory} />;
          case "meta":
            return <MetaMessage key={i} message={m} />;
        }
      })}
      {permissions.map((p) => (
        <PermissionCard
          key={p.id}
          permission={p}
          onRespond={onRespond}
          onRespondOption={onRespondOption}
        />
      ))}
      <div ref={bottomRef} />
      {showJump && (
        <button
          className="sticky bottom-4 mt-1 inline-flex animate-[jump-in_0.18s_ease-out] cursor-pointer items-center gap-1.5 self-center rounded-full bg-primary px-3.5 py-1.5 text-[13px] text-primary-foreground shadow-overlay transition-colors hover:bg-[var(--accent-hover)]"
          onClick={jumpToLatest}
          aria-label="Jump to latest"
        >
          <ArrowDown size={14} strokeWidth={2.5} /> Jump to latest
        </button>
      )}
    </main>
  );
}
