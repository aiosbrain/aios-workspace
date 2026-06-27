import { useState } from "react";
import { Plus, Search, Blocks, Zap, UploadCloud, Settings, FolderGit2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useConnection, useRuntime, useSession } from "../../state/cockpit";
import type { ViewKey } from "../../hooks/useCockpit";
import { groupChatsByRecency } from "../../lib/recency";
import type { SessionSummary } from "../../types/protocol";
import { ThemeToggle } from "./ThemeToggle";

// Secondary tools — utilities, kept compact below the (primary) chat history.
const TOOLS: { key: ViewKey; label: string; icon: LucideIcon }[] = [
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
  const [query, setQuery] = useState("");

  const isDraft = currentSession === null;
  const isEmptyDraft = isDraft && messages.length === 0 && !input.trim() && !connected && !busy;
  const repoName = repo ? repo.split("/").filter(Boolean).pop() : "workspace";

  const q = query.trim().toLowerCase();
  const filtered = q
    ? chats.filter((c) => (c.title || "").toLowerCase().includes(q))
    : null;
  const groups = filtered ? null : groupChatsByRecency(chats);

  const ChatItem = (c: SessionSummary) => (
    <button
      key={c.id}
      className={`chat-item${c.id === currentSession && view === "chat" ? " on" : ""}`}
      onClick={() => openChat(c.id)}
      title={c.title || "(untitled)"}
    >
      {c.title || "New chat"}
    </button>
  );

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

      <div className="side-actions">
        <button className="side-action" onClick={newChat} disabled={isEmptyDraft}>
          <Plus size={16} /> New chat
          <kbd className="side-kbd">⌘N</kbd>
        </button>
        <div className="side-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
          />
        </div>
      </div>

      <div className="side-chats">
        <div className="side-project" title={repo}>
          <FolderGit2 size={14} />
          <span className="side-project-name">{repoName}</span>
          {runtime && (
            <span className="runtime-badge" title={`Agent runtime: ${runtime}`}>
              <span className="runtime-dot" />
              {runtime}
            </span>
          )}
        </div>

        {filtered ? (
          filtered.length ? (
            <div className="chat-group">{filtered.map(ChatItem)}</div>
          ) : (
            <div className="side-empty">No chats match “{query}”.</div>
          )
        ) : groups && groups.length ? (
          groups.map((g) => (
            <div className="chat-group" key={g.label}>
              <div className="chat-group-label">{g.label}</div>
              {g.chats.map(ChatItem)}
            </div>
          ))
        ) : (
          <div className="side-empty">No chats yet — start one above.</div>
        )}
      </div>

      <nav className="side-tools">
        {TOOLS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={`side-link${view === key ? " on" : ""}`}
            onClick={() => setView(key)}
          >
            <Icon size={15} strokeWidth={2} /> {label}
          </button>
        ))}
      </nav>

      <div className="side-foot">
        <ThemeToggle />
        <div
          className="privacy"
          title="Your keys are encrypted on this machine and never sent to the team brain."
        >
          🔒 Keys stay on this machine
        </div>
      </div>
    </aside>
  );
}
