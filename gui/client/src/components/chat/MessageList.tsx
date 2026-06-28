import { useEffect, useRef, type ReactNode } from "react";
import type { UiMessage, PendingPermission } from "../../types/messages";
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

  const handleScroll = () => {
    const el = mainRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, permissions]);

  return (
    <main ref={mainRef} onScroll={handleScroll}>
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
    </main>
  );
}
