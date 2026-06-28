import { useState } from "react";
import { Plus, Search, UploadCloud, FolderGit2 } from "lucide-react";
import { useConnection, useSession } from "../../state/cockpit";
import { groupChatsByRecency } from "../../lib/recency";
import { shortcutLabel } from "../../lib/shortcuts";
import { cn } from "../../lib/cn";
import type { SessionSummary } from "../../types/protocol";

const SIDE_KBD =
  "ml-auto font-mono text-[10px] text-muted-foreground bg-muted border border-border-visible rounded-sm px-[5px] py-px";

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

  const dotClass = cn(
    "ml-auto h-[7px] w-[7px] rounded-full",
    connectionStatus === "reconnecting"
      ? "bg-primary animate-[conn-pulse_1s_ease-in-out_infinite]"
      : connectionStatus === "offline"
        ? "bg-destructive"
        : connected
          ? "bg-lime shadow-[0_0_8px_color-mix(in_srgb,var(--aios-accent)_60%,transparent)]"
          : "bg-muted-foreground",
  );

  const ChatItem = (c: SessionSummary) => (
    <button
      key={c.id}
      className={cn(
        "block w-full truncate rounded-[8px] border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground",
        c.id === currentSession &&
          view === "chat" &&
          "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground",
      )}
      onClick={() => openChat(c.id)}
      title={c.title || "(untitled)"}
    >
      {c.title || "New chat"}
    </button>
  );

  return (
    <aside className="flex w-[232px] shrink-0 flex-col gap-1 border-r border-border-visible bg-card px-3 py-4">
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-3.5 font-display text-base font-normal tracking-[var(--aios-tracking-snug)]">
        <span className="brand-mark h-[26px] w-[26px] shrink-0 rounded-md" />
        AIOS Workspace
        <span
          className={dotClass}
          title={statusTitle[connectionStatus] ?? (isDraft ? "Draft" : "Connecting…")}
        />
      </div>

      {(connectionStatus === "reconnecting" || connectionStatus === "offline") && (
        <div
          className={cn(
            "mx-3 mb-2 flex items-center gap-2 rounded-md border border-border-visible bg-secondary px-2.5 py-1.5 text-xs text-muted-foreground",
            connectionStatus === "offline" &&
              "border-[color-mix(in_srgb,var(--aios-destructive)_45%,var(--aios-border-visible))] text-destructive",
          )}
          role="status"
        >
          <span>{connectionStatus === "offline" ? "Connection lost" : "Reconnecting…"}</span>
          {connectionStatus === "offline" && (
            <button
              className="ml-auto cursor-pointer rounded-sm border border-border-visible bg-muted px-2.5 py-0.5 font-mono text-xs text-foreground transition-colors hover:border-[var(--accent-line)] hover:bg-[var(--accent-soft)]"
              onClick={retryConnection}
            >
              Retry
            </button>
          )}
        </div>
      )}

      <div className="mb-2 flex flex-col gap-1.5">
        <button
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-md bg-transparent px-2.5 py-2 text-left text-sm font-medium text-foreground hover:bg-muted disabled:cursor-default disabled:opacity-50"
          onClick={newChat}
          disabled={isEmptyDraft}
        >
          <Plus size={16} /> New chat
          <span className={SIDE_KBD}>{shortcutLabel("newChat")}</span>
        </button>
        <div className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-muted-foreground hover:bg-muted focus-within:bg-muted">
          <Search size={15} className="shrink-0" />
          <input
            className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
          />
          <span className={SIDE_KBD} title="Open command palette">
            {shortcutLabel("palette")}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        <div
          className="flex items-center gap-[7px] px-2 pt-1 pb-1.5 font-mono text-[11px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground"
          title={repo}
        >
          <FolderGit2 size={14} className="shrink-0" />
          <span className="min-w-0 flex-[0_1_auto] truncate">{repoName}</span>
        </div>

        {filtered ? (
          filtered.length ? (
            <div className="mb-2.5 flex flex-col gap-px">{filtered.map(ChatItem)}</div>
          ) : (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">
              No chats match “{query}”.
            </div>
          )
        ) : groups && groups.length ? (
          groups.map((g) => (
            <div className="mb-2.5 flex flex-col gap-px" key={g.label}>
              <div className="px-2.5 pt-1.5 pb-[3px] font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
                {g.label}
              </div>
              {g.chats.map(ChatItem)}
            </div>
          ))
        ) : (
          <div className="px-2.5 py-2 text-xs text-muted-foreground">
            No chats yet — start one above.
          </div>
        )}
      </div>

      <nav className="mt-2 flex flex-col gap-px border-t border-border-visible pt-2">
        <button
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
            view === "review" && "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground",
          )}
          onClick={() => setView("review")}
        >
          <UploadCloud size={15} strokeWidth={2} /> Review &amp; Push
        </button>
      </nav>

      <button
        className={cn(
          "mt-2 flex w-full cursor-pointer items-center gap-2.5 border-t border-border-visible bg-transparent px-2 py-2.5 text-left text-foreground hover:bg-muted",
          view === "settings" && "bg-[var(--accent-soft)]",
        )}
        onClick={() => setView("settings")}
      >
        <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-violet font-mono text-[13px] font-semibold text-primary-foreground">
          {initial}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold">Settings</span>
          <span className="text-[11px] text-muted-foreground">Account &amp; integrations</span>
        </span>
      </button>
    </aside>
  );
}
