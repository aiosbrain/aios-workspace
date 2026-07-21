import { useState } from "react";
import {
  Plus,
  Search,
  UploadCloud,
  FolderGit2,
  Activity,
  ListChecks,
  Coins,
  Repeat,
  Inbox,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  Bot,
  Mail,
  Hash,
  Send,
  MessageCircle,
} from "lucide-react";
import { useConnection, useSession } from "../../state/cockpit";
import { groupChatsByRecency } from "../../lib/recency";
import { shortcutLabel } from "../../lib/shortcuts";
import { cn } from "../../lib/cn";
import type { SessionSummary } from "../../types/protocol";
import type { CommsChannel } from "../comms/channel-filter";

const SIDE_KBD =
  "ml-auto font-mono text-[10px] text-muted-foreground bg-muted border border-border-visible rounded-sm px-[5px] py-px";
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card";

export function shouldDisableNewChat(view: string, isEmptyDraft: boolean): boolean {
  return view === "chat" && isEmptyDraft;
}

export function Sidebar() {
  const { repo } = useConnection();
  const {
    view,
    setView,
    commsChannel = "all",
    setCommsChannel,
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
  const [commsOpen, setCommsOpen] = useState(true);
  const [buildOpen, setBuildOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const commsItems: { channel: CommsChannel; label: string; Glyph: typeof Inbox }[] = [
    { channel: "all", label: "Inbox (all)", Glyph: Inbox },
    { channel: "claude", label: "Claude", Glyph: Bot },
    { channel: "gmail", label: "Gmail", Glyph: Mail },
    { channel: "slack", label: "Slack", Glyph: Hash },
    { channel: "telegram", label: "Telegram", Glyph: Send },
    { channel: "whatsapp", label: "WhatsApp", Glyph: MessageCircle },
  ];

  const statusTitle: Record<string, string> = {
    draft: "Draft",
    connecting: "Connecting…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
    offline: "Offline",
  };

  const isDraft = currentSession === null;
  const isEmptyDraft = isDraft && messages.length === 0 && !input.trim() && !connected && !busy;
  const newChatDisabled = shouldDisableNewChat(view, isEmptyDraft);
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
          : "bg-muted-foreground"
  );
  const connectionLabel = statusTitle[connectionStatus] ?? (isDraft ? "Draft" : "Connecting...");

  const ChatItem = (c: SessionSummary) => (
    <button
      key={c.id}
      className={cn(
        "block w-full truncate rounded-[8px] border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground",
        FOCUS_RING,
        c.id === currentSession &&
          view === "chat" &&
          "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
      )}
      onClick={() => openChat(c.id)}
      title={c.title || "(untitled)"}
    >
      {c.title || "New chat"}
    </button>
  );

  return (
    <aside className="flex h-full min-h-0 w-[232px] shrink-0 flex-col gap-1 overflow-hidden border-r border-border-visible bg-card px-3 py-4">
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-3.5 font-sans text-base font-semibold tracking-[var(--aios-tracking-snug)]">
        <span className="brand-mark h-[26px] w-[26px] shrink-0 rounded-md" />
        AIOS Workspace
        <span
          className={dotClass}
          title={connectionLabel}
          aria-label={`Connection status: ${connectionLabel}`}
          role="status"
        />
      </div>

      {(connectionStatus === "reconnecting" || connectionStatus === "offline") && (
        <div
          className={cn(
            "mx-3 mb-2 flex items-center gap-2 rounded-md border border-border-visible bg-secondary px-2.5 py-1.5 text-xs text-muted-foreground",
            connectionStatus === "offline" &&
              "border-[color-mix(in_srgb,var(--aios-destructive)_45%,var(--aios-border-visible))] text-destructive"
          )}
          role="status"
        >
          <span>{connectionStatus === "offline" ? "Connection lost" : "Reconnecting…"}</span>
          {connectionStatus === "offline" && (
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
        className="mb-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto border-b border-border-visible pb-2"
        aria-label="Workspace"
      >
        <button
          className={cn(
            "flex w-full cursor-pointer items-center gap-1 rounded-md px-2.5 pt-1 pb-[3px] text-left font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground hover:bg-muted hover:text-foreground",
            FOCUS_RING
          )}
          onClick={() => setCommsOpen((open) => !open)}
          aria-expanded={commsOpen}
          aria-controls="sidebar-comms"
        >
          {commsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Comms
        </button>
        {commsOpen && (
          <div id="sidebar-comms">
            {commsItems.map(({ channel, label, Glyph }) => (
              <button
                key={channel}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-transparent bg-transparent px-2.5 py-[6px] text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                  channel !== "all" && "pl-7",
                  FOCUS_RING,
                  view === "comms" &&
                    commsChannel === channel &&
                    "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
                )}
                onClick={() => {
                  setCommsChannel?.(channel);
                  setView("comms");
                }}
                aria-current={view === "comms" && commsChannel === channel ? "page" : undefined}
              >
                <Glyph size={15} strokeWidth={2} /> {label}
              </button>
            ))}
          </div>
        )}
        <button
          className={cn(
            "mt-1 flex w-full cursor-pointer items-center gap-1 rounded-md px-2.5 pt-1 pb-[3px] text-left font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground hover:bg-muted hover:text-foreground",
            FOCUS_RING
          )}
          onClick={() => setBuildOpen((open) => !open)}
          aria-expanded={buildOpen}
          aria-controls="sidebar-build"
        >
          {buildOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Build
        </button>
        {buildOpen && (
          <div id="sidebar-build" className="flex flex-col">
            <div className="flex items-center gap-0.5">
              <button
                className={cn(
                  "flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                  FOCUS_RING,
                  view === "chat" &&
                    "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
                )}
                onClick={() => setView("chat")}
              >
                <MessageSquare size={15} strokeWidth={2} /> Chat
              </button>
              <button
                type="button"
                className={cn(
                  "grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
                  FOCUS_RING
                )}
                onClick={() => setChatOpen((open) => !open)}
                aria-expanded={chatOpen}
                aria-controls="sidebar-chat-section"
                aria-label={chatOpen ? "Collapse Chat" : "Expand Chat"}
              >
                {chatOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            </div>
            {chatOpen && (
              <div
                id="sidebar-chat-section"
                data-testid="sidebar-chat-section"
                className="ml-5 mb-1 flex min-h-0 flex-col gap-1 border-l border-border-visible pl-2"
              >
                <button
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md bg-transparent px-2 py-1.5 text-left text-[13px] font-medium text-foreground hover:bg-muted disabled:cursor-default disabled:opacity-50",
                    FOCUS_RING
                  )}
                  onClick={newChat}
                  disabled={newChatDisabled}
                >
                  <Plus size={14} /> New chat
                  <span className={SIDE_KBD}>{shortcutLabel("newChat")}</span>
                </button>
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted focus-within:bg-muted",
                    "focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 focus-within:ring-offset-card"
                  )}
                >
                  <Search size={14} className="shrink-0" />
                  <input
                    className="min-w-0 flex-1 border-none bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search chats"
                    aria-label="Search chats"
                  />
                </div>

                <div className="min-h-0 max-h-[34vh] overflow-y-auto pr-1">
                  <div
                    className="flex items-center gap-[7px] px-2 pt-1 pb-1 font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground"
                    title={repo}
                  >
                    <FolderGit2 size={13} className="shrink-0" />
                    <span className="min-w-0 flex-[0_1_auto] truncate">{repoName}</span>
                  </div>

                  {filtered ? (
                    filtered.length ? (
                      <div className="mb-1 flex flex-col gap-px">{filtered.map(ChatItem)}</div>
                    ) : (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No chats match “{query}”.
                      </div>
                    )
                  ) : groups && groups.length ? (
                    groups.map((g) => (
                      <div className="mb-1 flex flex-col gap-px" key={g.label}>
                        <div className="px-2 pt-1 pb-[3px] font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
                          {g.label}
                        </div>
                        {g.chats.map(ChatItem)}
                      </div>
                    ))
                  ) : (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No chats yet — start one above.
                    </div>
                  )}
                </div>
              </div>
            )}
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
                view === "cost" &&
                  "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
              )}
              onClick={() => setView("cost")}
            >
              <Coins size={15} strokeWidth={2} /> Cost
            </button>
            <button
              className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-transparent bg-transparent px-2.5 py-[7px] text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                FOCUS_RING,
                view === "loop" &&
                  "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground"
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
          </div>
        )}
      </nav>

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
