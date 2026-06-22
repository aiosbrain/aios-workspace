import React, { useEffect, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, EyebrowLabel } from "@aios-alpha/ui";

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
];
const CONTEXT_WINDOW = 200_000; // both offered models

// Force every markdown link to open externally WITHOUT a Referer, so the
// cockpit URL's ?token=… is never leaked to the destination site.
const MD_COMPONENTS = {
  a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
};

function fmtK(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}
function fmtUsd(n) {
  return `$${Number(n).toFixed(n < 0.1 ? 4 : 2)}`;
}

// "turn done" line, shared by the live stream and transcript replay so they read
// identically. total_cost_usd may be cumulative across a session — show a per-turn
// delta when it clearly is (prevCost>0, non-negative), else treat it as the turn's cost.
function formatResultMeta(usage, cost_usd, prevCost) {
  const parts = [];
  if (usage)
    parts.push(`${fmtK(usage.input_tokens || 0)} in / ${fmtK(usage.output_tokens || 0)} out`);
  if (typeof cost_usd === "number") {
    const delta = cost_usd - prevCost;
    parts.push(
      prevCost > 0 && delta >= 0
        ? `+${fmtUsd(delta)} (session ${fmtUsd(cost_usd)})`
        : fmtUsd(cost_usd)
    );
  }
  return `turn done${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

// Fold a stored transcript (array of WS events) into a messages[] for replay.
// Differs from the live handler: echo_user BECOMES a user message here (live
// ignores it because the UI already rendered it optimistically), and historical
// permission_request events are dropped — never shown as live approval prompts.
function buildMessagesFromEvents(events) {
  const msgs = [];
  let lastUsage = null,
    prevCost = 0;
  for (const ev of events) {
    switch (ev.type) {
      case "echo_user":
        msgs.push({ kind: "user", text: ev.text });
        break;
      case "delta": {
        const last = msgs[msgs.length - 1];
        if (last?.kind === "assistant" && last.streaming) last.text += ev.text;
        else msgs.push({ kind: "assistant", text: ev.text, streaming: true });
        break;
      }
      case "assistant_done": {
        const last = msgs[msgs.length - 1];
        if (last?.kind === "assistant") last.streaming = false;
        break;
      }
      case "tool_use":
        msgs.push({ kind: "tool", name: ev.name, input: ev.input, id: ev.id, result: null });
        break;
      case "tool_result": {
        const t = [...msgs].reverse().find((m) => m.kind === "tool" && m.id === ev.id);
        if (t) {
          t.result = ev.text;
          t.isError = ev.is_error;
        }
        break;
      }
      case "usage":
        lastUsage = ev.usage;
        break;
      case "warning":
        msgs.push({ kind: "meta", text: `⚠ ${ev.message}` });
        break;
      case "result":
        msgs.push({ kind: "meta", text: formatResultMeta(lastUsage, ev.cost_usd, prevCost) });
        if (typeof ev.cost_usd === "number") prevCost = ev.cost_usd;
        lastUsage = null;
        break;
      default:
        break; // hello, model, session, permission_request, memory_* → not replayed
      // (memory notices are live-only; their undo CAS isn't valid on replay)
    }
  }
  const last = msgs[msgs.length - 1];
  if (last?.kind === "assistant") last.streaming = false; // never leave a stale cursor
  return msgs;
}

/**
 * Minimal local cockpit for an aios-workspace repo.
 * One WebSocket = one Claude Agent SDK session with the repo as cwd —
 * skills, rules, and the guard hook fire exactly as in Claude Code.
 */

const GUI_TOKEN_KEY = "aios.gui.token";

// Persist the localhost session token so a refresh to / still works. The server
// mints a random token at startup; the first visit must use ?token=… from the
// terminal, after which we reuse it for this browser tab/session.
function resolveGuiToken() {
  const fromUrl = new URLSearchParams(window.location.search).get("token") || "";
  if (fromUrl) {
    try {
      sessionStorage.setItem(GUI_TOKEN_KEY, fromUrl);
    } catch {
      /* storage blocked */
    }
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(GUI_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

const token = resolveGuiToken();

function connectErrorMessage(reason) {
  if (!token) {
    return "Missing session token — open the full link printed by `npm run gui` once, then refresh";
  }
  return `${reason} — if you restarted the GUI, open the new link from \`npm run gui\``;
}

export default function App() {
  const [repo, setRepo] = useState("");
  const [runtime, setRuntime] = useState(""); // agent_runtime driving this session
  const [safetyNote, setSafetyNote] = useState(null); // write-guard tier note from server
  const [view, setView] = useState("chat"); // "chat" | "review" | "integrations" | "team"
  const [role, setRole] = useState(null); // brain member role; only lead/admin see Team
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState([]); // {kind, ...}
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState([]); // pending approval requests
  const [model, setModel] = useState(MODELS[0].id); // selected model (Sonnet 4.6 default)
  const [usage, setUsage] = useState(null); // latest token usage → context meter
  const [chats, setChats] = useState([]); // past sessions for the sidebar
  const [currentSession, setCurrentSession] = useState(null); // active chat id
  const wsRef = useRef(null);
  const bottomRef = useRef(null);
  const composerRef = useRef(null); // footer textarea — chips pre-fill + focus it
  const usageRef = useRef(null); // latest usage for the result line (state is async)
  const prevCostRef = useRef(0); // session cost so far, to show a per-turn delta
  const connectSeqRef = useRef(0); // ignore close/open callbacks from superseded sockets

  // Who am I? Only a brain lead/admin sees the Team (publish) surface.
  useEffect(() => {
    fetch(`/api/me?token=${token}`)
      .then((r) => r.json())
      .then((d) => setRole(d.me?.role || null))
      .catch(() => {});
  }, []);

  // Keep repo chrome populated even while a fresh draft has not opened a WebSocket.
  useEffect(() => {
    fetch("/api/info")
      .then((r) => r.json())
      .then((d) => setRepo(d.repo || ""))
      .catch(() => {});
  }, []);

  // Restore the persisted model choice (agent_model in aios.yaml), if it's one we offer.
  useEffect(() => {
    fetch(`/api/config?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (MODELS.some((m) => m.id === d.model)) setModel(d.model);
        setRuntime(d.runtime || "");
      })
      .catch(() => {});
  }, []);

  const changeModel = useCallback((m) => {
    setModel(m); // applies to the NEXT send (sent on each user_message → SDK setModel)
    fetch(`/api/config/model?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m }),
    }).catch(() => {});
  }, []);

  const append = useCallback((m) => setMessages((prev) => [...prev, m]), []);

  // Update or create the streaming assistant message
  const appendDelta = useCallback((text) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { kind: "assistant", text, streaming: true }];
    });
  }, []);

  const finishAssistant = useCallback(() => {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === prev.length - 1 && m.kind === "assistant" ? { ...m, streaming: false } : m
      )
    );
  }, []);

  const loadChats = useCallback(async () => {
    try {
      const r = await fetch(`/api/sessions?token=${token}`);
      const d = await r.json();
      setChats(d.sessions || []);
      return d;
    } catch {
      return { sessions: [], lastSelected: null };
    }
  }, []);

  // Open (or reopen) a WebSocket. With a sessionId, the server resumes that chat's
  // SDK session so prior context is intact; without one it mints a fresh chat.
  const connect = useCallback(
    (sessionId) => {
      if (!token) {
        return Promise.reject(new Error(connectErrorMessage("Cannot connect")));
      }
      try {
        wsRef.current?.close();
      } catch {
        /* already closed */
      }
      const seq = ++connectSeqRef.current;
      setConnected(false);
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const qs = sessionId ? `&session=${encodeURIComponent(sessionId)}` : "";
      const ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${token}${qs}`);
      wsRef.current = ws;
      const opened = new Promise((resolve, reject) => {
        let didOpen = false;
        const fail = (reason) => {
          if (didOpen || connectSeqRef.current !== seq) return;
          reject(new Error(connectErrorMessage(reason)));
        };
        ws.onopen = () => {
          didOpen = true;
          if (connectSeqRef.current === seq) setConnected(true);
          resolve(ws);
        };
        ws.onerror = () => fail("WebSocket connection failed");
        ws.onclose = () => {
          if (connectSeqRef.current === seq) setConnected(false);
          fail("WebSocket connection closed before opening");
        };
      });
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case "hello":
            setRepo(msg.repo);
            setRuntime(msg.runtime || "");
            setSafetyNote(msg.safetyNote || null);
            setCurrentSession(msg.sessionId);
            loadChats();
            break;
          case "echo_user":
            loadChats(); // server registered/updated session on user_message
            break; // user bubble already rendered optimistically
          case "delta":
            appendDelta(msg.text);
            break;
          case "assistant_done":
            finishAssistant();
            break;
          case "tool_use":
            append({ kind: "tool", name: msg.name, input: msg.input, id: msg.id, result: null });
            break;
          case "tool_result":
            setMessages((prev) =>
              prev.map((m) =>
                m.kind === "tool" && m.id === msg.id
                  ? { ...m, result: msg.text, isError: msg.is_error }
                  : m
              )
            );
            break;
          case "permission_request":
            setPermissions((prev) => [...prev, msg]);
            break;
          case "usage":
            usageRef.current = msg.usage;
            setUsage(msg.usage);
            break;
          case "model": // server confirms an in-session switch — keep the picker in sync
            if (MODELS.some((m) => m.id === msg.model)) setModel(msg.model);
            break;
          case "warning":
            append({ kind: "meta", text: `⚠ ${msg.message}` });
            break;
          case "result":
            setBusy(false);
            append({
              kind: "meta",
              text: formatResultMeta(usageRef.current, msg.cost_usd, prevCostRef.current),
            });
            if (typeof msg.cost_usd === "number") prevCostRef.current = msg.cost_usd;
            loadChats(); // first turn just set this chat's title
            break;
          case "error":
            setBusy(false);
            append({ kind: "meta", text: `error: ${msg.message}`, error: true });
            break;
          case "memory_updated": // background reviewer saved a fact (takes effect next session)
            append({ kind: "memory", id: msg.id, file: msg.file, summary: msg.summary });
            break;
          case "memory_undone":
            setMessages((prev) =>
              prev.map((m) =>
                m.kind === "memory" && m.id === msg.id
                  ? { ...m, undone: msg.ok, undoFailed: !msg.ok }
                  : m
              )
            );
            break;
          default:
            break;
        }
      };
      return opened;
    },
    [append, appendDelta, finishAssistant, loadChats]
  );

  // Reset the per-chat meters when switching chats.
  const resetChatState = useCallback(() => {
    setBusy(false);
    setPermissions([]);
    usageRef.current = null;
    setUsage(null);
    prevCostRef.current = 0;
  }, []);

  const newChat = useCallback(() => {
    connectSeqRef.current++;
    try {
      wsRef.current?.close();
    } catch {
      /* already closed */
    }
    wsRef.current = null;
    setConnected(false);
    resetChatState();
    setMessages([]);
    setInput("");
    setCurrentSession(null);
    setView("chat");
  }, [resetChatState]);

  // Replay a stored transcript, then resume its SDK session for new turns.
  const openChat = useCallback(
    async (id) => {
      resetChatState();
      setView("chat");
      try {
        const r = await fetch(`/api/sessions/${id}?token=${token}`);
        const d = await r.json();
        const events = d.events || [];
        setMessages(buildMessagesFromEvents(events));
        // Continue the cost/context meters from where the transcript left off.
        let lastCost = 0,
          lastUsage = null;
        for (const ev of events) {
          if (ev.type === "usage") lastUsage = ev.usage;
          if (ev.type === "result" && typeof ev.cost_usd === "number") lastCost = ev.cost_usd;
        }
        prevCostRef.current = lastCost;
        usageRef.current = lastUsage;
        setUsage(lastUsage);
      } catch {
        setMessages([]);
      }
      setCurrentSession(id);
      connect(id).catch((e) => append({ kind: "meta", text: `error: ${e.message}`, error: true }));
    },
    [append, connect, resetChatState]
  );

  // On launch, restore a real saved chat if there is one; otherwise stay in a local draft.
  useEffect(() => {
    loadChats().then((d) => {
      const validLast = d.lastSelected && (d.sessions || []).some((c) => c.id === d.lastSelected);
      if (validLast) openChat(d.lastSelected);
      else {
        resetChatState();
        setMessages([]);
        setCurrentSession(null);
        setView("chat");
      }
    });
    return () => {
      connectSeqRef.current++;
      try {
        wsRef.current?.close();
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, permissions]);

  const sendMessage = async (override) => {
    const text = (typeof override === "string" ? override : input).trim();
    if (!text) return;
    const openSocket = wsRef.current?.readyState === WebSocket.OPEN ? wsRef.current : null;
    if (!openSocket && currentSession !== null) return;
    append({ kind: "user", text });
    setInput("");
    setBusy(true);
    try {
      const ws = openSocket || (await connect());
      ws.send(JSON.stringify({ type: "user_message", text, model }));
    } catch (e) {
      setBusy(false);
      // The message never left the client (connect/send failed). Roll back the optimistic
      // user bubble and restore the text so the turn can be retried, instead of leaving an
      // orphaned bubble that looks sent.
      setMessages((prev) =>
        prev[prev.length - 1]?.kind === "user" && prev[prev.length - 1]?.text === text
          ? prev.slice(0, -1)
          : prev
      );
      setInput((cur) => cur || text);
      append({ kind: "meta", text: `error: ${e.message}`, error: true });
    }
  };

  const respondPermission = (id, allow) => {
    wsRef.current?.send(JSON.stringify({ type: "permission_response", id, allow }));
    setPermissions((prev) => prev.filter((p) => p.id !== id));
  };

  // Undo a background-reviewer memory write (compare-and-swap on the server).
  const undoMemory = (id) => {
    wsRef.current?.send(JSON.stringify({ type: "memory_undo", id }));
  };

  // Option-based runtimes (ACP) reply with one of the agent's own option IDs.
  const respondPermissionOption = (id, optionId) => {
    wsRef.current?.send(JSON.stringify({ type: "permission_response", id, optionId }));
    setPermissions((prev) => prev.filter((p) => p.id !== id));
  };

  const sortedChats = [...chats].sort((a, b) =>
    (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "")
  );
  const activeChat =
    currentSession &&
    sortedChats.find((c) => c.id === currentSession && String(c.title || "").trim());
  const historyChats = sortedChats.filter((c) => c.id !== activeChat?.id);
  const isDraft = currentSession === null;
  const isEmptyDraft = isDraft && messages.length === 0 && !input.trim() && !connected && !busy;
  const draftConnecting = isDraft && busy && !connected;
  const composerDisabled = draftConnecting || (!connected && !isDraft);
  const canStartMessage = !composerDisabled;

  return (
    <div className="app">
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
          <button
            className={`side-link${view === "chat" ? " on" : ""}`}
            onClick={() => setView("chat")}
          >
            {NAV_ICONS.chat} Chat
          </button>
          <button
            className={`side-link${view === "integrations" ? " on" : ""}`}
            onClick={() => setView("integrations")}
          >
            {NAV_ICONS.integrations} Integrations
          </button>
          <button
            className={`side-link${view === "skills" ? " on" : ""}`}
            onClick={() => setView("skills")}
          >
            {NAV_ICONS.skills} Skills
          </button>
          <button
            className={`side-link${view === "review" ? " on" : ""}`}
            onClick={() => setView("review")}
          >
            {NAV_ICONS.review} Review &amp; Push
          </button>
          {(role === "admin" || role === "lead") && (
            <button
              className={`side-link${view === "team" ? " on" : ""}`}
              onClick={() => setView("team")}
            >
              {NAV_ICONS.team} Team
            </button>
          )}
          <button
            className={`side-link${view === "settings" ? " on" : ""}`}
            onClick={() => setView("settings")}
          >
            {NAV_ICONS.settings} Settings
          </button>
        </nav>
        <div className="side-chats">
          <div className="chat-list">
            {activeChat && (
              <button
                className="chat-item on"
                onClick={() => openChat(activeChat.id)}
                title={activeChat.title}
              >
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
              + New chat
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

      <div className="app-main">
        {view === "review" && <ReviewPanel />}
        {view === "team" && <TeamPanel />}
        {view === "settings" && (
          <SettingsPanel model={model} onModelChange={changeModel} onPersonalityApplied={newChat} />
        )}
        {view === "integrations" && (
          <IntegrationsPanel
            onTryInChat={(prompt) => {
              setView("chat");
              setInput(prompt);
            }}
          />
        )}
        {view === "skills" && <SkillsPanel />}

        {view === "chat" && (
          <>
            <div className="chat-head">
              <label className="model-pick">
                <span>Model</span>
                <select value={model} disabled={busy} onChange={(e) => changeModel(e.target.value)}>
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <main>
              {!token && (
                <div className="safety-banner">
                  Missing session token. Open the full link printed by <code>npm run gui</code> once
                  — after that, refreshing this page will keep working in this tab.
                </div>
              )}
              {safetyNote && (
                <div
                  className="safety-banner"
                  title="Writes the agent makes through its own shell run after the turn ends are scanned, not blocked beforehand."
                >
                  ⚠ {safetyNote}
                </div>
              )}
              {messages.length === 0 && (
                <div className="empty">
                  <EyebrowLabel className="empty-eyebrow">Start a turn</EyebrowLabel>
                  <div className="empty-chips">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="empty-chip"
                      disabled={!canStartMessage}
                      onClick={() => sendMessage("what changed this week?")}
                    >
                      what changed this week?
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="empty-chip"
                      disabled={!canStartMessage}
                      onClick={() => {
                        setInput("Draft my profile from this link: ");
                        composerRef.current?.focus();
                      }}
                    >
                      draft from a link
                    </Button>
                  </div>
                </div>
              )}
              {messages.map((m, i) => {
                if (m.kind === "user")
                  return (
                    <div key={i} className="msg user">
                      {m.text}
                    </div>
                  );
                if (m.kind === "assistant")
                  return (
                    <div key={i} className={`msg assistant${m.streaming ? " streaming" : ""}`}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                        {m.text}
                      </ReactMarkdown>
                    </div>
                  );
                if (m.kind === "tool") return <ToolCard key={i} tool={m} />;
                if (m.kind === "memory")
                  return (
                    <div key={i} className="msg memory">
                      💾 Memory updated · <code>{m.file}</code> — {m.summary}
                      <span className="memory-sub"> (takes effect next session)</span>
                      {m.undone ? (
                        <span className="memory-done"> · undone</span>
                      ) : m.undoFailed ? (
                        <span className="memory-done"> · undo unavailable (file changed)</span>
                      ) : (
                        <button className="memory-undo" onClick={() => undoMemory(m.id)}>
                          undo
                        </button>
                      )}
                    </div>
                  );
                return (
                  <div key={i} className={`msg meta${m.error ? " error" : ""}`}>
                    {m.text}
                  </div>
                );
              })}
              {permissions.map((p) => (
                <div key={p.id} className="permission">
                  <div className="perm-head">
                    Approve <strong>{p.tool}</strong>?
                  </div>
                  <pre>{JSON.stringify(p.input, null, 2).slice(0, 1200)}</pre>
                  <div className="perm-actions">
                    {Array.isArray(p.options) && p.options.length ? (
                      p.options.map((o) => (
                        <button
                          key={o.optionId}
                          className={/deny|reject|cancel/i.test(o.kind || "") ? "deny" : "allow"}
                          onClick={() => respondPermissionOption(p.id, o.optionId)}
                        >
                          {o.name}
                        </button>
                      ))
                    ) : (
                      <>
                        <button className="allow" onClick={() => respondPermission(p.id, true)}>
                          Allow
                        </button>
                        <button className="deny" onClick={() => respondPermission(p.id, false)}>
                          Deny
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </main>

            <ContextMeter usage={usage} />

            <footer>
              <textarea
                ref={composerRef}
                value={input}
                placeholder={
                  !connected && !isDraft
                    ? "connecting…"
                    : messages.length === 0
                      ? "What are you working on?"
                      : "Message your workspace… (Enter to send, Shift+Enter for newline)"
                }
                disabled={composerDisabled}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
              />
              <button onClick={sendMessage} disabled={composerDisabled || !input.trim()}>
                {busy ? "…" : "Send"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

const NAV_ICONS = {
  chat: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  integrations: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  review: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V6M5 13l7-7 7 7" />
    </svg>
  ),
  team: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  skills: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 2L3 14h7l-1 8 10-12h-7z" />
    </svg>
  ),
  settings: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

// Dark is the workspace GUI's terminal-native default; light is opt-in.
// Tiny localStorage + classList toggle (no next-themes — this is plain Vite/React).
const THEME_KEY = "aios.gui.theme";

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch {
      /* storage blocked */
    }
  };
  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle color theme"
    >
      <span className="theme-toggle-icon">{dark ? "☾" : "☀"}</span>
      {dark ? "Dark" : "Light"}
    </button>
  );
}

function SettingsPanel({ model, onModelChange, onPersonalityApplied }) {
  const [personalities, setPersonalities] = useState(null);
  const [current, setCurrent] = useState(null);
  const [saving, setSaving] = useState(false);
  const [memReview, setMemReview] = useState(null); // null = loading
  const [runtime, setRuntime] = useState("");

  useEffect(() => {
    fetch(`/api/personalities?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        setPersonalities(d.personalities || []);
        setCurrent(d.current);
      })
      .catch(() => setPersonalities([]));
    fetch(`/api/config?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        setMemReview(d.memoryReview !== false);
        setRuntime(d.runtime || "");
      })
      .catch(() => setMemReview(true));
  }, []);

  const toggleMemReview = async () => {
    const next = !memReview;
    setMemReview(next);
    try {
      await fetch(`/api/config/memory-review?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
    } catch {
      setMemReview(!next);
    } // revert on failure
  };

  const pick = async (id) => {
    if (id === current || saving) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/config/personality?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personality: id }),
      });
      const d = await r.json();
      if (d.ok) {
        setCurrent(id);
        onPersonalityApplied();
      } // new chat so the persona applies
    } catch {
      /* leave selection */
    }
    setSaving(false);
  };

  return (
    <div className="integrations">
      <div className="int-head">
        <div>
          <h2>Settings</h2>
          <p className="int-sub">
            Pick the default model and the agent's personality. Personality is a style layer
            appended to the system prompt — it never overrides your rules, CLAUDE.md, or skills.
          </p>
        </div>
      </div>

      <h3 className="int-section">Default model</h3>
      <label className="model-pick">
        <span>Model</span>
        <select value={model} onChange={(e) => onModelChange(e.target.value)}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <h3 className="int-section">Personality</h3>
      {!personalities ? (
        <div className="empty">
          <p>loading…</p>
        </div>
      ) : (
        <div className="int-grid">
          {personalities.map((p) => (
            <div key={p.id} className={`int-card${p.id === current ? " wired" : ""}`}>
              <div className="int-card-top">
                <span className="int-name">{p.name}</span>
                <span className={`int-status ${p.id === current ? "wired" : ""}`}>
                  {p.id === current ? "● active" : "○"}
                </span>
              </div>
              <p className="int-summary">{p.description}</p>
              <div className="int-card-foot">
                <span className="int-transport">style only</span>
                <button
                  className="int-connect"
                  disabled={saving || p.id === current}
                  onClick={() => pick(p.id)}
                >
                  {p.id === current ? "Active" : "Use"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="int-foot">
        Changing personality starts a new chat so the new voice takes effect.
      </p>

      <h3 className="int-section">Memory</h3>
      <label className="mem-toggle">
        <input
          type="checkbox"
          checked={!!memReview}
          disabled={memReview === null || runtime !== "claude-code"}
          onChange={toggleMemReview}
        />
        <span>Auto-update my workspace memory after each turn</span>
      </label>
      <p className="int-sub">
        A fast model (Haiku) conservatively saves durable facts to{" "}
        <code>.claude/memory/USER.md</code> / <code>WORKSPACE.md</code> — you get a 💾 notice with
        an undo, and changes take effect next session. Secrets are never sent or saved.
        {runtime && runtime !== "claude-code" ? (
          <>
            {" "}
            Unavailable on the <code>{runtime}</code> runtime (claude-code only).
          </>
        ) : null}
      </p>
    </div>
  );
}

const RISK_LABEL = { low: "low risk", elevated: "review", high: "high risk" };

function SkillsPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [acting, setActing] = useState(null); // id currently installing/removing
  const [rowErr, setRowErr] = useState({}); // id → error message
  const [review, setReview] = useState(null); // { id, name } of skill under review

  const load = useCallback(() => {
    setError(null);
    fetch(`/api/skills?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Install/uninstall. `consent` is sent for community installs (official ignores it).
  const act = async (id, action, consent) => {
    setActing(id);
    setRowErr((p) => ({ ...p, [id]: null }));
    try {
      const r = await fetch(`/api/skills/${id}/${action}?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(consent ? { consent } : {}),
      });
      const d = await r.json();
      if (!d.ok) {
        setRowErr((p) => ({ ...p, [id]: d.error || "failed" }));
        return false;
      }
      setReview(null);
      load();
      return true;
    } catch (e) {
      setRowErr((p) => ({ ...p, [id]: e.message }));
      return false;
    } finally {
      setActing(null);
    }
  };

  if (error)
    return (
      <div className="integrations">
        <div className="msg meta error">error: {error}</div>
      </div>
    );
  if (!data)
    return (
      <div className="integrations">
        <div className="empty">
          <p>loading skills…</p>
        </div>
      </div>
    );

  // group official skills by category
  const groups = {};
  for (const s of data.skills) (groups[s.category] ||= []).push(s);
  const marketplace = data.marketplace || [];
  const community = data.community || [];
  const installedCount = data.skills.filter((s) => s.installed).length;

  // Trust → human badge. official is hash-locked; marketplace is first-party vetted but
  // fetch-on-install (so a Review step runs the advisory scan); community is unverified.
  const TRUST_BADGE = {
    official: "official · Apache-2.0",
    marketplace: "marketplace · official",
    community: "community · unverified",
  };

  const card = (s) => {
    const isCommunity = s.trust === "community";
    const isMarketplace = s.trust === "marketplace";
    const reviewed = isCommunity || isMarketplace; // both go through the Review modal
    return (
      <div key={s.id} className={`int-card${s.installed ? " wired" : ""}`}>
        <div className="int-card-top">
          <span className="int-name">{s.name}</span>
          <span className={`int-status ${s.installed ? "wired" : ""}`}>
            {s.installed ? "● installed" : "○ available"}
          </span>
        </div>
        <p className="int-summary">{s.description}</p>
        <div className="skill-caps">
          {s.capabilities?.bundles_code ? (
            <span className="cap code" title={(s.capabilities.code_files || []).join(", ")}>
              ⚙ runs code
              {s.capabilities.code_files ? ` (${(s.capabilities.code_files || []).length})` : ""}
            </span>
          ) : (
            !reviewed && <span className="cap">text-only</span>
          )}
          <span className={`cap trust ${s.trust}`}>{TRUST_BADGE[s.trust] || s.trust}</span>
        </div>
        <div className="int-card-foot">
          <span className="int-transport">{s.category}</span>
          {s.installed ? (
            <button
              className="wiz-secondary"
              disabled={acting === s.id}
              onClick={() => act(s.id, "uninstall")}
            >
              {acting === s.id ? "…" : "Remove"}
            </button>
          ) : reviewed ? (
            <button
              className="int-connect"
              disabled={acting === s.id}
              onClick={() => setReview({ id: s.id, name: s.name, trust: s.trust })}
            >
              Review &amp; install
            </button>
          ) : (
            <button
              className="int-connect"
              disabled={acting === s.id}
              onClick={() => act(s.id, "install")}
            >
              {acting === s.id ? "Installing…" : "Install"}
            </button>
          )}
        </div>
        {rowErr[s.id] && <p className="skill-err">{rowErr[s.id]}</p>}
      </div>
    );
  };

  return (
    <div className="integrations">
      <div className="int-head">
        <div>
          <h2>Skills</h2>
          <p className="int-sub">
            Official Anthropic skills are vendored from <code>anthropics/skills</code> and
            hash-locked — one-click install into <code>.claude/skills/</code>. Marketplace skills
            come from Anthropic's official plugin directory (<code>claude-plugins-official</code>):
            first-party vetted, but fetched-on-install at a pinned commit and byte-verified against
            the catalog. Community skills carry no first-party provenance and require your review.
            Scanning is <strong>advisory</strong> — provenance and your own review are the real
            safeguard.
          </p>
        </div>
        <div className="int-progress">
          {installedCount} of {data.skills.length} installed
        </div>
      </div>

      {Object.keys(groups)
        .sort()
        .map((cat) => (
          <React.Fragment key={cat}>
            <h3 className="int-section">{cat}</h3>
            <div className="int-grid">{groups[cat].map(card)}</div>
          </React.Fragment>
        ))}

      {marketplace.length > 0 && (
        <>
          <h3 className="int-section">Marketplace — Anthropic official plugins</h3>
          <div className="int-grid">{marketplace.map(card)}</div>
          <p className="int-foot">
            ↪ Marketplace skills are first-party (Anthropic) but <strong>fetched on install</strong>{" "}
            from <code>claude-plugins-official</code> at a pinned commit. The fetched bytes are
            byte-verified against the catalog before anything lands in <code>.claude/skills/</code>{" "}
            — a tampered or drifted upstream is refused. Installing needs network access.
          </p>
        </>
      )}

      {community.length > 0 && (
        <>
          <h3 className="int-section int-section-muted">
            Community — unverified (scan + consent required)
          </h3>
          <div className="int-grid">{community.map(card)}</div>
          <p className="int-foot">
            ⚠ Community skills are not vendored or first-party. Installing one runs its bundled
            instructions/code in your workspace — treat it like installing software from a stranger.
          </p>
        </>
      )}

      {review && (
        <SkillReviewModal
          skill={review}
          acting={acting === review.id}
          rowErr={rowErr[review.id]}
          onClose={() => setReview(null)}
          onInstall={(consent) => act(review.id, "install", consent)}
        />
      )}

      {data.referenced?.length > 0 && (
        <>
          <h3 className="int-section int-section-muted">Documents — available in Claude</h3>
          <div className="int-grid">
            {data.referenced.map((s) => (
              <div key={s.id} className="int-card">
                <div className="int-card-top">
                  <span className="int-name">{s.name}</span>
                </div>
                <p className="int-summary">{s.description}</p>
                <div className="int-card-foot">
                  <span className="int-transport">official · hosted</span>
                  <a
                    className="int-connect"
                    href={data.referenced_docs_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Enable in Claude ↗
                  </a>
                </div>
              </div>
            ))}
          </div>
          <p className="int-foot">
            These document skills are Anthropic-hosted (proprietary license) — used inside Claude,
            not copied here.
          </p>
        </>
      )}
    </div>
  );
}

// Review & install modal for a reviewed skill (marketplace OR community). Fetches the
// advisory scan, lists findings (file:line), and gates install behind consent. Community
// `high` risk additionally requires typing the skill id; marketplace is first-party vetted
// (fetched-on-install + byte-verified), so it is a simple accept with no typed confirm.
function SkillReviewModal({ skill, acting, rowErr, onClose, onInstall }) {
  const [scan, setScan] = useState(null);
  const [scanErr, setScanErr] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [typed, setTyped] = useState("");
  const isMarketplace = skill.trust === "marketplace";

  useEffect(() => {
    setScan(null);
    setScanErr(null);
    fetch(`/api/skills/${skill.id}/scan?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setScan(d);
      })
      .catch((e) => setScanErr(e.message));
  }, [skill.id]);

  const needsTyped = scan?.requiresTypedConfirm; // server: community high-risk only
  const canInstall = accepted && (!needsTyped || typed === skill.id) && !acting;
  const consent = { accepted: true, ...(needsTyped ? { typed } : {}) };

  return (
    <div className="wiz-overlay" onClick={onClose}>
      <div className="wiz skill-review" onClick={(e) => e.stopPropagation()}>
        <div className="wiz-head">
          <h3>Review &amp; install — {skill.name}</h3>
          <button className="wiz-x" onClick={onClose}>
            ✕
          </button>
        </div>

        {scanErr && (
          <div className="wiz-error">
            {isMarketplace ? "fetch / verify" : "scan"} failed: {scanErr}
          </div>
        )}
        {!scan && !scanErr && (
          <div className="wiz-validating">
            {isMarketplace ? "Fetching + verifying skill…" : "Scanning skill…"}
          </div>
        )}

        {scan && (
          <>
            <div className="skill-review-head">
              <span className={`risk-badge ${scan.riskClass}`}>
                {RISK_LABEL[scan.riskClass] || scan.riskClass}
              </span>
              <span className="skill-review-meta">
                {scan.counts.high} high-severity of {scan.counts.total} findings ·{" "}
                {scan.counts.code_files} code file{scan.counts.code_files === 1 ? "" : "s"}
              </span>
            </div>
            {isMarketplace ? (
              <p className="wiz-note">
                This skill is <strong>marketplace · official</strong> (Anthropic's
                <code>claude-plugins-official</code> directory). It was fetched at a pinned commit
                and byte-verified against the catalog. The scan below is <strong>advisory</strong> —
                review it, then install.
              </p>
            ) : (
              <p className="wiz-note">
                This skill is <strong>community · unverified</strong> with no first-party
                provenance. The scan below is <strong>advisory</strong> — it can miss obfuscated
                behavior. Install only if you trust the source.
              </p>
            )}

            <div className="skill-findings">
              {scan.findings.length === 0 ? (
                <p className="skill-finding ok">No findings — instructions only, no code.</p>
              ) : (
                scan.findings.map((f, i) => (
                  <div key={i} className={`skill-finding ${f.severity}`}>
                    <span className="skill-finding-loc">
                      {f.file}:{f.line}
                    </span>
                    <span className="skill-finding-rule">{f.rule}</span>
                    <code className="skill-finding-snip">{f.snippet}</code>
                  </div>
                ))
              )}
            </div>

            <label className="skill-consent">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>
                {isMarketplace
                  ? "I reviewed the findings and want to install this marketplace skill."
                  : "I reviewed the findings and accept the risk of installing this unverified skill."}
              </span>
            </label>
            {needsTyped && (
              <div className="skill-typed">
                <p className="wiz-note skill-typed-warn">
                  ⚠ This skill scanned <strong>HIGH risk</strong>. Type
                  <code>{skill.id}</code> to confirm.
                </p>
                <input
                  className="wiz-text"
                  placeholder={skill.id}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
            )}

            {rowErr && <div className="wiz-error">{rowErr}</div>}
            <div className="wiz-done-actions">
              <button className="wiz-go" disabled={!canInstall} onClick={() => onInstall(consent)}>
                {acting ? "Installing…" : isMarketplace ? "Install" : "Install anyway"}
              </button>
              <button className="wiz-secondary" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ContextMeter({ usage }) {
  // Approximate context occupancy = the prompt fed on the latest turn
  // (fresh input + cached tokens). Labeled "est." because it's a proxy, not a
  // live token count, and is absent until the first turn reports usage.
  const ctx = usage
    ? (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0)
    : null;
  const pct = ctx == null ? 0 : Math.min(100, Math.round((ctx / CONTEXT_WINDOW) * 100));
  return (
    <div
      className="ctx-meter"
      title="Estimated context used (input + cached tokens) on the last turn, out of the model's window. Approximate."
    >
      <div className="ctx-bar">
        <div className="ctx-fill" style={{ width: `${pct}%` }} />
      </div>
      <span>context (est.) {ctx == null ? "—" : `~${fmtK(ctx)} / ${fmtK(CONTEXT_WINDOW)}`}</span>
    </div>
  );
}

function ReviewPanel() {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setOutput("");
    try {
      const res = await fetch(`/api/review?token=${token}`);
      if (!res.ok) throw new Error(`review failed (${res.status})`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPlan(data);
      // default: select every pushable (new + modified) file
      const all = [...(data.items.new || []), ...(data.items.modified || [])].map((i) => i.rel);
      setSelected(new Set(all));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (rel) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });

  const push = async (dryRun) => {
    setBusy(true);
    setOutput("");
    try {
      const res = await fetch(`/api/push?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [...selected], dryRun }),
      });
      const data = await res.json();
      setOutput(data.output || data.error || "(no output)");
      if (!dryRun && data.ok) load(); // refresh status after a real push
    } catch (e) {
      setOutput(`error: ${e.message}`);
    }
    setBusy(false);
  };

  if (error)
    return (
      <div className="review">
        <div className="msg meta error">error: {error}</div>
        <button className="rev-btn" onClick={load}>
          Retry
        </button>
      </div>
    );
  if (!plan)
    return (
      <div className="review">
        <div className="empty">
          <p>loading status…</p>
        </div>
      </div>
    );

  const pushable = [
    ...(plan.items.new || []).map((i) => ({ ...i, state: "new" })),
    ...(plan.items.modified || []).map((i) => ({ ...i, state: "modified" })),
  ];

  return (
    <div className="review">
      <div className="rev-head">
        <span>
          {plan.project} → {plan.brain_url || "offline"}
        </span>
        <span className="rev-actions">
          <button className="rev-btn" onClick={load} disabled={busy}>
            Refresh
          </button>
          <button className="rev-btn" onClick={() => push(true)} disabled={busy || !selected.size}>
            Dry-run
          </button>
          <button
            className="rev-btn primary"
            onClick={() => push(false)}
            disabled={busy || !selected.size}
          >
            Push {selected.size} selected
          </button>
        </span>
      </div>

      {pushable.length === 0 ? (
        <div className="empty">
          <p>Nothing to push — all eligible files are clean.</p>
        </div>
      ) : (
        <ul className="rev-list">
          {pushable.map((i) => (
            <li key={i.rel} className="rev-item">
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(i.rel)}
                  onChange={() => toggle(i.rel)}
                />
                <span className="rev-path">{i.rel}</span>
                <span className="rev-tags">
                  [{i.kind}, {i.tier}] {i.state === "new" ? "NEW" : "MOD"}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {plan.items.blocked?.length > 0 && (
        <div className="rev-blocked">
          <div className="rev-blocked-head">blocked ({plan.items.blocked.length}) — never sync</div>
          {plan.items.blocked.map((b) => (
            <div key={b.rel} className="rev-blocked-item">
              {b.rel} — {b.reason}
            </div>
          ))}
        </div>
      )}

      <div className="rev-clean">clean (already synced): {plan.items.clean?.length || 0}</div>
      {output && <pre className="rev-output">{output}</pre>}
    </div>
  );
}

const SUGGESTED = {
  notion: "Summarize my most recent Notion page.",
  granola: "Pull my recent Granola meeting notes into the inbox.",
  slack: "Catch me up on my unread Slack messages.",
  jira: "Show me the Jira issues assigned to me.",
  linear: "List my open Linear issues for this cycle.",
  firecrawl: "Read this page and pull out the key facts: <url>",
};

function IntegrationsPanel({ onTryInChat }) {
  const [connectors, setConnectors] = useState(null);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(null); // connector being connected

  const load = useCallback(async () => {
    setError(null);
    try {
      // /api/blueprint refreshes the team's tool set then returns team-aware connectors;
      // fall back to /api/connectors if the brain isn't reachable.
      let res = await fetch(`/api/blueprint?token=${token}`);
      let data = res.ok ? await res.json() : null;
      if (!data || !data.connectors) {
        res = await fetch(`/api/connectors?token=${token}`);
        data = await res.json();
      }
      setConnectors(data.connectors || []);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (error)
    return (
      <div className="integrations">
        <div className="msg meta error">error: {error}</div>
      </div>
    );
  if (!connectors)
    return (
      <div className="integrations">
        <div className="empty">
          <p>loading integrations…</p>
        </div>
      </div>
    );

  const wired = connectors.filter((c) => c.status === "wired").length;
  const team = connectors.filter((c) => c.team_enabled);
  const rest = connectors.filter((c) => !c.team_enabled);
  const showTeam = team.length > 0;

  const card = (c) => (
    <div key={c.id} className={`int-card${c.status === "wired" ? " wired" : ""}`}>
      <div className="int-card-top">
        <span className="int-name">{c.name}</span>
        <span className={`int-status ${c.status}`}>
          {c.status === "wired" ? "● connected" : "○ available"}
        </span>
      </div>
      <p className="int-summary">{c.summary}</p>
      <div className="int-card-foot">
        <span className="int-transport">
          {c.transport === "skill" ? "direct API skill" : "MCP"}
        </span>
        <button className="int-connect" onClick={() => setActive(c)}>
          {c.status === "wired" ? "Reconnect" : "Connect →"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="integrations">
      <div className="int-head">
        <div>
          <h2>Integrations</h2>
          <p className="int-sub">
            Connect your tools. We hand you the exact key page, check the key live, and lock it on
            this machine.
          </p>
        </div>
        <div className="int-progress">
          {wired} of {connectors.length} connected
        </div>
      </div>

      {showTeam && (
        <>
          <h3 className="int-section">
            Your team uses these {team.length} tool{team.length === 1 ? "" : "s"}
          </h3>
          <div className="int-grid">{team.map(card)}</div>
          <h3 className="int-section int-section-muted">More integrations</h3>
        </>
      )}
      <div className="int-grid">{(showTeam ? rest : connectors).map(card)}</div>
      <p className="int-foot">
        🔒 Every key is encrypted on this machine (dotenvx) and never sent to the team brain.
      </p>

      {active && (
        <ConnectWizard
          connector={active}
          onClose={() => setActive(null)}
          onConnected={() => {
            load();
          }}
          onTryInChat={onTryInChat}
        />
      )}
    </div>
  );
}

function ConnectWizard({ connector, onClose, onConnected, onTryInChat }) {
  // Pre-fill any field the team blueprint already set (e.g. the Jira site URL).
  const [secrets, setSecrets] = useState(() => {
    const init = {};
    for (const s of connector.secrets || []) {
      if (connector.instance && connector.instance[s.env]) init[s.env] = connector.instance[s.env];
    }
    return init;
  });
  const [reveal, setReveal] = useState({});
  const [phase, setPhase] = useState("collect"); // collect | validating | done | error
  const [result, setResult] = useState(null);
  const required = (connector.secrets || []).filter((s) => s.required);
  const filled = required.every((s) => (secrets[s.env] || "").trim());

  const connect = async () => {
    setPhase("validating");
    setResult(null);
    try {
      const vRes = await fetch(`/api/connectors/${connector.id}/store?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets }),
      });
      const data = await vRes.json();
      if (vRes.ok && data.ok) {
        setResult(data);
        setPhase("done");
        onConnected();
      } else {
        setResult(data.validation || data);
        setPhase("error");
      }
    } catch (e) {
      setResult({ error: e.message, checks: [] });
      setPhase("error");
    }
  };

  const checks = result?.checks || result?.validation?.checks || [];

  return (
    <div className="wiz-overlay" onClick={onClose}>
      <div className="wiz" onClick={(e) => e.stopPropagation()}>
        <div className="wiz-head">
          <span>Connect {connector.name}</span>
          <button className="wiz-x" onClick={onClose}>
            ✕
          </button>
        </div>

        {phase !== "done" && (
          <>
            <div className="wiz-step">
              <div className="wiz-step-n">1 · Get your key</div>
              {connector.docs?.token_create_url ? (
                <a
                  className="wiz-link"
                  href={connector.docs.token_create_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open {connector.name} to create a key →
                </a>
              ) : (
                <div className="wiz-inapp">Created in the {connector.name} app (no web page).</div>
              )}
              {connector.docs?.instructions && (
                <p className="wiz-note">{connector.docs.instructions}</p>
              )}
              {connector.scopes?.length > 0 && (
                <p className="wiz-scopes">
                  Give it these scopes: <strong>{connector.scopes.join(" · ")}</strong>
                </p>
              )}
            </div>

            <div className="wiz-step">
              <div className="wiz-step-n">2 · Paste &amp; check</div>
              {required.map((s) => (
                <div key={s.env} className="wiz-field">
                  <label>{s.label}</label>
                  <div className="wiz-input">
                    <input
                      type={reveal[s.env] ? "text" : "password"}
                      placeholder={s.placeholder || s.env}
                      value={secrets[s.env] || ""}
                      onChange={(e) => setSecrets({ ...secrets, [s.env]: e.target.value })}
                      autoComplete="off"
                      spellCheck="false"
                    />
                    <button
                      className="wiz-eye"
                      onClick={() => setReveal({ ...reveal, [s.env]: !reveal[s.env] })}
                    >
                      👁
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {phase === "validating" && <div className="wiz-validating">Checking it live…</div>}
            {checks.length > 0 && (
              <ul className="wiz-checks">
                {checks.map((ch, i) => (
                  <li key={i} className={ch.ok ? "ok" : "bad"}>
                    {ch.ok ? "✓" : "✗"} {ch.name} <span>— {ch.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            {phase === "error" && (
              <div className="wiz-error">
                Couldn’t connect{result?.error ? ` (${result.error})` : ""}.
                {connector.docs?.token_create_url && (
                  <a href={connector.docs.token_create_url} target="_blank" rel="noreferrer">
                    {" "}
                    Create a fresh key →
                  </a>
                )}
              </div>
            )}

            <button
              className="wiz-go"
              disabled={!filled || phase === "validating"}
              onClick={connect}
            >
              {phase === "validating" ? "Checking…" : "Connect"}
            </button>
          </>
        )}

        {phase === "done" && (
          <div className="wiz-done">
            <div className="wiz-done-badge">✓ Connected</div>
            <p>
              Connected to <strong>{connector.name}</strong>
              {result?.identity?.value ? (
                <>
                  {" "}
                  as <strong>{result.identity.value}</strong>
                </>
              ) : null}
              {result?.instance?.value ? (
                <>
                  {" "}
                  in <strong>{result.instance.value}</strong>
                </>
              ) : null}
              .
            </p>
            <p className="wiz-note">
              Your key is encrypted on this machine.{" "}
              {connector.transport === "skill"
                ? "A skill was installed to use it."
                : "An MCP server was wired up."}
            </p>
            <div className="wiz-done-actions">
              <button
                className="wiz-go"
                onClick={() =>
                  onTryInChat(
                    SUGGESTED[connector.id] || `Use ${connector.name} to help me with a task.`
                  )
                }
              >
                Try it in chat →
              </button>
              <button className="wiz-secondary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TeamPanel() {
  const [connectors, setConnectors] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [inst, setInst] = useState({}); // {id: {env: value}}
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [hint, setHint] = useState(null);

  const load = useCallback(async () => {
    setOutput("");
    try {
      const res = await fetch(`/api/blueprint?token=${token}`);
      const data = await res.json();
      const list = data.connectors || [];
      setConnectors(list);
      setSel(new Set(list.filter((c) => c.team_enabled).map((c) => c.id)));
      const iv = {};
      for (const c of list)
        for (const f of c.team_instance || []) {
          const v = c.instance?.[f.env];
          if (v) (iv[c.id] ||= {})[f.env] = v;
        }
      setInst(iv);
      setHint(
        data.ok
          ? null
          : "Connect this workspace to the brain (set AIOS_API_KEY + team_id) to publish for your team."
      );
    } catch (e) {
      setHint(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const toggle = (id) =>
    setSel((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const setField = (id, env, val) =>
    setInst((p) => ({ ...p, [id]: { ...(p[id] || {}), [env]: val } }));

  const publish = async () => {
    setBusy(true);
    setOutput("");
    const payload = {};
    for (const c of connectors)
      if (sel.has(c.id)) {
        payload[c.id] = {
          enabled: true,
          name: c.name,
          transport: c.transport,
          instance: inst[c.id] || {},
        };
      }
    try {
      const res = await fetch(`/api/blueprint/publish?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectors: payload }),
      });
      const data = await res.json();
      setOutput(data.output || data.error || "(no output)");
      if (data.ok) load();
    } catch (e) {
      setOutput(`error: ${e.message}`);
    }
    setBusy(false);
  };

  if (!connectors)
    return (
      <div className="integrations">
        <div className="empty">
          <p>loading team tools…</p>
        </div>
      </div>
    );

  return (
    <div className="integrations">
      <div className="int-head">
        <div>
          <h2>Team</h2>
          <p className="int-sub">
            Pick the tools your team uses and publish them once. Everyone gets a guided checklist —
            each person still supplies their own keys.
          </p>
        </div>
        <button className="int-connect" disabled={busy || !sel.size} onClick={publish}>
          {busy ? "Publishing…" : `Publish ${sel.size} to team`}
        </button>
      </div>
      {hint && <p className="msg meta">{hint}</p>}

      <div className="int-grid">
        {connectors.map((c) => (
          <div key={c.id} className={`int-card${sel.has(c.id) ? " wired" : ""}`}>
            <label className="team-row">
              <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="int-name">{c.name}</span>
              <span className="int-transport">
                {c.transport === "skill" ? "direct API" : "MCP"}
              </span>
            </label>
            <p className="int-summary">{c.summary}</p>
            {sel.has(c.id) &&
              (c.team_instance || []).map((f) => (
                <div key={f.env} className="wiz-field">
                  <label>{f.label}</label>
                  <div className="wiz-input">
                    <input
                      type="text"
                      placeholder={f.placeholder || f.env}
                      value={(inst[c.id] || {})[f.env] || ""}
                      onChange={(e) => setField(c.id, f.env, e.target.value)}
                    />
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>
      {output && <pre className="rev-output">{output}</pre>}
      <p className="int-foot">
        🔒 The blueprint carries only which tools + shared URLs — never anyone's keys.
      </p>
    </div>
  );
}

function ToolCard({ tool }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeInput(tool.name, tool.input);
  return (
    <div className={`tool${tool.isError ? " tool-error" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-summary">{summary}</span>
        <span className="tool-state">
          {tool.result === null ? "running" : tool.isError ? "error" : "done"}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          <pre>{JSON.stringify(tool.input, null, 2).slice(0, 2000)}</pre>
          {tool.result != null && <pre className="tool-result">{tool.result}</pre>}
        </div>
      )}
    </div>
  );
}

function summarizeInput(name, input) {
  if (!input) return "";
  if (input.file_path) return input.file_path;
  if (input.command) return String(input.command).slice(0, 80);
  if (input.pattern) return input.pattern;
  if (input.skill) return input.skill;
  const s = JSON.stringify(input);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}
