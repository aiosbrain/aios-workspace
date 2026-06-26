import { MessageSquare, Blocks, Zap, UploadCloud, Settings, Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useConnection, useRuntime, useSession } from "../../state/cockpit";
import type { ViewKey } from "../../hooks/useCockpit";
import { ThemeToggle } from "./ThemeToggle";

const NAV: { key: ViewKey; label: string; icon: LucideIcon }[] = [
  { key: "chat", label: "Chat", icon: MessageSquare },
  { key: "integrations", label: "Integrations", icon: Blocks },
  { key: "skills", label: "Skills", icon: Zap },
  { key: "review", label: "Review & Push", icon: UploadCloud },
  { key: "settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const { repo } = useConnection();
  const { runtime } = useRuntime();
  const { view, setView, connected, chats, currentSession, openChat, newChat, input, busy, messages } =
    useSession();

  const sortedChats = [...chats].sort((a, b) =>
    (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""),
  );
  const activeChat =
    (currentSession && sortedChats.find((c) => c.id === currentSession && String(c.title || "").trim())) ||
    null;
  const historyChats = sortedChats.filter((c) => c.id !== activeChat?.id);
  const isDraft = currentSession === null;
  const isEmptyDraft = isDraft && messages.length === 0 && !input.trim() && !connected && !busy;

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" />
        AIOS Workspace
        <span
          className="brand-status"
          data-on={connected}
          title={connected ? "Connected" : isDraft ? "Draft" : "Connecting…"}
        />
      </div>

      <nav className="side-nav">
        {NAV.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={`side-link${view === key ? " on" : ""}`}
            onClick={() => setView(key)}
          >
            <Icon size={16} strokeWidth={2} /> {label}
          </button>
        ))}
      </nav>

      <div className="side-chats">
        <div className="chat-list">
          {activeChat && (
            <button className="chat-item on" onClick={() => openChat(activeChat.id)} title={activeChat.title}>
              {activeChat.title}
            </button>
          )}
          {historyChats.map((c) => (
            <button
              key={c.id}
              className={`chat-item${c.id === currentSession ? " on" : ""}`}
              onClick={() => openChat(c.id)}
              title={c.title || "(untitled)"}
            >
              {c.title || "New chat"}
            </button>
          ))}
          <button
            className={`side-newchat${isDraft ? " draft" : ""}`}
            onClick={newChat}
            disabled={isEmptyDraft}
          >
            <Plus size={14} /> New chat
          </button>
        </div>
      </div>

      <div className="side-foot">
        <ThemeToggle />
        {runtime && (
          <div className="runtime-badge" title={`Agent runtime: ${runtime}`}>
            <span className="runtime-dot" />
            {runtime}
          </div>
        )}
        <div
          className="privacy"
          title="Your keys are encrypted on this machine and never sent to the team brain."
        >
          🔒 Keys stay on this machine
        </div>
        <div className="repo" title={repo}>
          {repo}
        </div>
      </div>
    </aside>
  );
}
