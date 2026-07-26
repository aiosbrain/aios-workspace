import { useEffect, useState } from "react";
import {
  Plus,
  Search,
  UploadCloud,
  FolderGit2,
  Activity,
  ListChecks,
  Coins,
  Repeat,
  MessageSquare,
} from "lucide-react";
import { useConnection, useSession } from "../../state/cockpit";
import { groupChatsByRecency } from "../../lib/recency";
import { fmtAge } from "../../lib/format";
import { shortcutLabel } from "../../lib/shortcuts";
import { cn } from "../../lib/cn";
import type { SessionSearchResult, SessionSummary } from "../../types/protocol";

const SIDE_KBD =
  "ml-auto font-mono text-[10px] text-muted-foreground bg-muted border border-border-visible rounded-sm px-[5px] py-px";
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card";

export function shouldDisableNewChat(view: string, isEmptyDraft: boolean): boolean {
  return view === "chat" && isEmptyDraft;
}

export function Sidebar() {
  const { repo, api } = useConnection();
  const {
    view,
    setView,
    connected,
    connectionStatus,
    chats,
    chatsLoadFailed,
    currentSession,
    openChat,
    newChat,
    input,
    busy,
    messages,
    retryConnection,
  } = useSession();
  const [query, setQuery] = useState("");
  // Full-content hits from the server (same engine as the command palette — the two
  // search affordances must not silently differ in power). null = fall back to the
  // instant client-side title filter (empty query, or the endpoint failed).
  const [hits, setHits] = useState<SessionSearchResult[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .get<{ results: SessionSearchResult[] }>(`/api/sessions/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!cancelled) setHits(r.results || []);
        })
        .catch(() => {
          if (!cancelled) setHits(null); // fall back to the title filter
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, api]);

  const statusTitle: Record<string, string> = {
    draft: "Draft",
    connecting: "Connecting…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
    offline: "Offline",
    superseded: "Opened in another tab",
  };

  const isDraft = currentSession === null;
  const isEmptyDraft = isDraft && messages.length === 0 && !input.trim() && !connected && !busy;
  const newChatDisabled = shouldDisableNewChat(view, isEmptyDraft);
  const repoName = repo ? repo.split("/").filter(Boolean).pop() : "workspace";
  const initial = (repoName?.[0] || "A").toUpperCase();

  const q = query.trim().toLowerCase();
  const byId = new Map(chats.map((c) => [c.id, c]));
  // Server full-content hits win (same engine as ⌘K); title filter is the instant/offline fallback.
  const filtered = !q
    ? null
    : hits !== null
      ? hits.map((h) => ({ ...(byId.get(h.id) ?? { id: h.id, title: h.title, createdAt: "", updatedAt: "" }), snippet: h.snippet }))
      : chats.filter((c) => (c.title || "").toLowerCase().includes(q));
  const groups = filtered ? null : groupChatsByRecency(chats);

  const dotClass = cn(
    "ml-auto h-[7px] w-[7px] rounded-full",
    connectionStatus === "reconnecting"
      ? "bg-primary animate-[conn-pulse_1s_ease-in-out_infinite]"
      : connectionStatus === "offline" || connectionStatus === "superseded"
        ? "bg-destructive"
        : connected
          ? "bg-lime shadow-[0_0_8px_color-mix(in_srgb,var(--aios-accent)_60%,transparent)]"
          : "bg-muted-foreground"
  );
  const connectionLabel = statusTitle[connectionStatus] ?? (isDraft ? "Draft" : "Connecting...");

  const ChatItem = (c: SessionSummary & { snippet?: string }) => {
    const age = c.updatedAt ? Date.now() - Date.parse(c.updatedAt) : NaN;
    return (
      <button
        key={c.id}
        className={cn(
          "block w-full rounded-[8px] border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground",
          FOCUS_RING,
          c.id === currentSession &&
            view === "chat" &&
            "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
        )}
        onClick={() => openChat(c.id)}
        title={c.title || "(untitled)"}
      >
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate">{c.title || "New chat"}</span>
          {Number.isFinite(age) && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
              {fmtAge(age)}
            </span>
          )}
        </span>
        {c.snippet && (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/70">
            {c.snippet}
          </span>
        )}
      </button>
    );
  };

  return (
    <aside className="flex w-[232px] shrink-0 flex-col gap-1 border-r border-border-visible bg-card px-3 py-4">
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-3.5 font-display text-base font-normal tracking-[var(--aios-tracking-snug)]">
        <span className="brand-mark h-[26px] w-[26px] shrink-0 rounded-md" />
        AIOS Workspace
        <span
          className={dotClass}
          title={connectionLabel}
          aria-label={`Connection status: ${connectionLabel}`}
          role="status"
        />
      </div>

      {(connectionStatus === "reconnecting" ||
        connectionStatus === "offline" ||
        connectionStatus === "superseded") && (
        <div
          className={cn(
            "mx-3 mb-2 flex items-center gap-2 rounded-md border border-border-visible bg-secondary px-2.5 py-1.5 text-xs text-muted-foreground",
            connectionStatus === "offline" &&
              "border-[color-mix(in_srgb,var(--aios-destructive)_45%,var(--aios-border-visible))] text-destructive"
          )}
          role="status"
        >
          <span>
            {connectionStatus === "offline"
              ? "Connection lost"
              : connectionStatus === "superseded"
                ? "Opened in another tab"
                : "Reconnecting…"}
          </span>
          {(connectionStatus === "offline" || connectionStatus === "superseded") && (
            <button
              className={cn(
                "ml-auto cursor-pointer rounded-sm border border-border-visible bg-muted px-2.5 py-0.5 font-mono text-xs text-foreground transition-colors hover:border-[var(--accent-line)] hover:bg-[var(--accent-soft)]",
                FOCUS_RING
              )}
              onClick={retryConnection}
            >
              Retry
            </button>
          )}
        </div>
      )}

      <nav
        className="mb-2 flex shrink-0 flex-col gap-px border-b border-border-visible pb-2"
        aria-label="Workspace"
      >
        <div className="px-2.5 pt-1 pb-[3px] font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
          Build
        </div>
        <button
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
            FOCUS_RING,
            view === "chat" && "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
          )}
          onClick={() => setView("chat")}
        >
          <MessageSquare size={15} strokeWidth={2} /> Chat
        </button>
        <button
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
            FOCUS_RING,
            view === "tasks" &&
              "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
          )}
          onClick={() => setView("tasks")}
        >
          <ListChecks size={15} strokeWidth={2} /> Tasks
        </button>
        <button
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
            FOCUS_RING,
            view === "maturity" &&
              "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
          )}
          onClick={() => setView("maturity")}
        >
          <Activity size={15} strokeWidth={2} /> Maturity
        </button>
        <button
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
            FOCUS_RING,
            view === "cost" && "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
          )}
          onClick={() => setView("cost")}
        >
          <Coins size={15} strokeWidth={2} /> Cost
        </button>
        <button
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
            FOCUS_RING,
            view === "loop" && "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
          )}
          onClick={() => setView("loop")}
        >
          <Repeat size={15} strokeWidth={2} /> Operator Loop
        </button>
        <button
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
            FOCUS_RING,
            view === "review" &&
              "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
          )}
          onClick={() => setView("review")}
        >
          <UploadCloud size={15} strokeWidth={2} /> Team Brain Sync
        </button>
      </nav>

      <div className="mb-2 flex flex-col gap-1.5">
        <button
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 rounded-md bg-transparent px-2.5 py-2 text-left text-sm font-medium text-foreground hover:bg-muted disabled:cursor-default disabled:opacity-50",
            FOCUS_RING
          )}
          onClick={newChat}
          disabled={newChatDisabled}
        >
          <Plus size={16} /> New chat
          <span className={SIDE_KBD}>{shortcutLabel("newChat")}</span>
        </button>
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-muted-foreground hover:bg-muted focus-within:bg-muted",
            "focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 focus-within:ring-offset-card"
          )}
        >
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
            {chatsLoadFailed
              ? "Couldn't load chats — they'll reappear when the connection is back."
              : "No chats yet — start one above."}
          </div>
        )}
      </div>

      <button
        className={cn(
          "mt-2 flex w-full cursor-pointer items-center gap-2.5 border-t border-border-visible bg-transparent px-2 py-2.5 text-left text-foreground hover:bg-muted",
          FOCUS_RING,
          view === "settings" && "bg-[var(--accent-soft)]"
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
