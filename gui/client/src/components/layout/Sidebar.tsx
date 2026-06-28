import { useState } from "react";
import { Plus, Search, UploadCloud, FolderGit2 } from "lucide-react";
import { useConnection, useSession } from "../../state/cockpit";
import { groupChatsByRecency } from "../../lib/recency";
import type { SessionSummary } from "../../types/protocol";

export function Sidebar() {
  const { repo } = useConnection();
  const {
    view,
    setView,
    connected,
    connectionStatus,
    chats,
    currentSession,
    openChat,
    newChat,
    input,
    busy,
    messages,
    retryConnection,
  } = useSession();
  const [query, setQuery] = useState("");

  const statusTitle: Record<string, string> = {
    draft: "Draft",
    connecting: "Connecting…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
    offline: "Offline",
  };

  const isDraft = currentSession === null;
  const isEmptyDraft = isDraft && messages.length === 0 && !input.trim() && !connected && !busy;
  const repoName = repo ? repo.split("/").filter(Boolean).pop() : "workspace";
  const initial = (repoName?.[0] || "A").toUpperCase();

  const q = query.trim().toLowerCase();
  const filtered = q ? chats.filter((c) => (c.title || "").toLowerCase().includes(q)) : null;
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
          data-status={connectionStatus}
          title={statusTitle[connectionStatus] ?? (isDraft ? "Draft" : "Connecting…")}
        />
      </div>

      {(connectionStatus === "reconnecting" || connectionStatus === "offline") && (
        <div className="conn-banner" data-status={connectionStatus} role="status">
          <span>{connectionStatus === "offline" ? "Connection lost" : "Reconnecting…"}</span>
          {connectionStatus === "offline" && (
            <button className="conn-retry" onClick={retryConnection}>
              Retry
            </button>
          )}
        </div>
      )}

      <div className="side-actions">
        <button className="side-action" onClick={newChat} disabled={isEmptyDraft}>
          <Plus size={16} /> New chat
          <span className="side-kbd">⌘N</span>
        </button>
        <div className="side-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
          />
          <span className="side-kbd" title="Open command palette">
            ⌘K
          </span>
        </div>
      </div>

      <div className="side-chats">
        <div className="side-project" title={repo}>
          <FolderGit2 size={14} />
          <span className="side-project-name">{repoName}</span>
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
        <button
          className={`side-link${view === "review" ? " on" : ""}`}
          onClick={() => setView("review")}
        >
          <UploadCloud size={15} strokeWidth={2} /> Review &amp; Push
        </button>
      </nav>

      <button
        className={`side-account${view === "settings" ? " on" : ""}`}
        onClick={() => setView("settings")}
      >
        <span className="side-avatar">{initial}</span>
        <span className="side-account-text">
          <span className="side-account-title">Settings</span>
          <span className="side-account-sub">Account &amp; integrations</span>
        </span>
      </button>
    </aside>
  );
}
