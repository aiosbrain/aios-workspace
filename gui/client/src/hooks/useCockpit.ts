import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../components/ui/sonner";
import { createApi } from "../lib/api";
import { resolveGuiToken, connectErrorMessage } from "../lib/token";
import { formatResultMeta } from "../lib/format";
import { buildMessagesFromEvents } from "../lib/transcript";
import { DEFAULT_CAPS, normalizeCapabilities, type Capabilities } from "../types/runtime";
import type {
  ServerEvent,
  Usage,
  ConfigResponse,
  SessionListResponse,
  SessionTranscriptResponse,
} from "../types/protocol";
import type { UiMessage, PendingPermission } from "../types/messages";

export type ViewKey = "chat" | "tasks" | "review" | "maturity" | "cost" | "loop" | "settings";

/**
 * Visible socket lifecycle. `connected` (boolean) is kept for existing consumers and is
 * just `status === "connected"`. "draft" = no live session yet; "reconnecting" = an
 * established session dropped and we're backing off; "offline" = retries exhausted
 * (a manual Retry is offered). No infinite silent "Connecting…".
 */
export type ConnectionStatus =
  | "draft"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  // The session was taken over by a newer connection (another tab). Deliberately NOT
  // auto-reconnecting — that would steal it straight back. Retry = take it back.
  | "superseded";

const RECONNECT_MAX_ATTEMPTS = 6;
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 10_000;

const token = resolveGuiToken();
const api = createApi(token);

/**
 * The master cockpit hook: owns the single agent WebSocket, the chat message
 * stream, and all per-session state. Ported faithfully from the legacy App.jsx
 * connect()/handlers, with one BYOA change — runtime behaviour is driven by the
 * `capabilities` from the `hello` event (DEFAULT_CAPS until it arrives), never by
 * the runtime name.
 */
export function useCockpit() {
  // identity / chrome
  const [repo, setRepo] = useState("");
  const [role, setRole] = useState<string | null>(null);
  // runtime (BYOA)
  const [runtime, setRuntime] = useState("");
  const [capabilities, setCapabilities] = useState<Capabilities>(DEFAULT_CAPS);
  const [safetyNote, setSafetyNote] = useState<string | null>(null);
  // session / chat
  const [view, setView] = useState<ViewKey>("chat");
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("draft");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [model, setModel] = useState(DEFAULT_CAPS.models[0]?.id ?? "");
  const [approvalMode, setApprovalMode] = useState("default"); // session-scoped; default = ask
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sessionUsage, setSessionUsage] = useState<Usage | null>(null);
  const [chats, setChats] = useState<SessionListResponse["sessions"]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [chatsLoadFailed, setChatsLoadFailed] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const resultUsageRef = useRef<Usage | null>(null); // pending usage for the result line
  const prevCostRef = useRef(0); // session cost so far, for a per-turn delta
  const connectSeqRef = useRef(0); // ignore callbacks from superseded sockets
  const capsRef = useRef<Capabilities>(DEFAULT_CAPS); // fresh caps inside the ws handler
  capsRef.current = capabilities;
  const modelRef = useRef(model); // current model inside async callbacks (changeModel rollback)
  modelRef.current = model;
  const openChatSeqRef = useRef(0); // rapid chat switching: stale replay fetches must not win
  const changeModelSeqRef = useRef(0); // rapid model switching: stale failure replies must not roll back
  const msgUidRef = useRef(0); // monotonic uid per rendered message (stable React keys)
  const permissionsRef = useRef<PendingPermission[]>([]); // live view for disconnect cleanup
  permissionsRef.current = permissions;

  // Reconnect machinery (Phase 4): back off on an unexpected drop of an established session.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const currentSessionRef = useRef<string | null>(null); // session to resume on reconnect
  const scheduleReconnectRef = useRef<() => void>(() => {}); // set after connect() is defined

  // Drive both the rich status and the legacy boolean from one place.
  const applyConn = useCallback((status: ConnectionStatus) => {
    setConnectionStatus(status);
    setConnected(status === "connected");
  }, []);
  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // Keep the resume target current so the close handler reconnects to the right session.
  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);

  const append = useCallback(
    (m: UiMessage) => setMessages((prev) => [...prev, { ...m, uid: ++msgUidRef.current }]),
    []
  );

  const appendDelta = useCallback((text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { kind: "assistant", text, streaming: true, uid: ++msgUidRef.current }];
    });
  }, []);

  const finishAssistant = useCallback(() => {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === prev.length - 1 && m.kind === "assistant" ? { ...m, streaming: false } : m
      )
    );
  }, []);

  const loadChats = useCallback(async (): Promise<SessionListResponse> => {
    try {
      const d = await api.get<SessionListResponse>("/api/sessions");
      setChats(d.sessions || []);
      setChatsLoadFailed(false);
      return d;
    } catch {
      // Keep the last-good list; only flag the failure so an EMPTY sidebar can say
      // "couldn't load" instead of impersonating a workspace with no history.
      setChatsLoadFailed(true);
      return { sessions: [], lastSelected: null };
    }
  }, []);

  // Open (or reopen) a WebSocket. With a sessionId the server resumes that chat's
  // session so prior context is intact; without one it mints a fresh chat.
  const connect = useCallback(
    (sessionId?: string): Promise<WebSocket> => {
      if (!token) {
        return Promise.reject(new Error(connectErrorMessage("Cannot connect", token)));
      }
      clearReconnect(); // any pending retry is superseded by this (re)connect
      try {
        wsRef.current?.close();
      } catch {
        /* already closed */
      }
      const seq = ++connectSeqRef.current;
      applyConn(reconnectAttemptsRef.current > 0 ? "reconnecting" : "connecting");
      const ws = new WebSocket(api.wsUrl(sessionId));
      wsRef.current = ws;
      const opened = new Promise<WebSocket>((resolve, reject) => {
        let didOpen = false;
        const fail = (reason: string) => {
          if (didOpen || connectSeqRef.current !== seq) return;
          reject(new Error(connectErrorMessage(reason, token)));
        };
        ws.onopen = () => {
          didOpen = true;
          if (connectSeqRef.current === seq) {
            reconnectAttemptsRef.current = 0;
            clearReconnect();
            applyConn("connected");
          }
          resolve(ws);
        };
        ws.onerror = () => fail("WebSocket connection failed");
        ws.onclose = (ev) => {
          if (connectSeqRef.current !== seq) return; // superseded by a deliberate (re)connect
          setConnected(false);
          // The server denies every pending approval when a connection tears down —
          // leaving the cards up would invite decisions that can no longer apply.
          if (permissionsRef.current.length) {
            setPermissions([]);
            toast.warning(
              "The pending approval was cancelled — the connection dropped, so the run was denied it.",
              { id: "perm-cancelled" }
            );
          }
          // 4001 = the server closed us because this session was opened by a newer
          // connection (another tab, or a reconnect that superseded us). Reconnecting
          // would steal the session straight back, so park offline instead — the
          // user can Retry deliberately to take the session over again.
          if (ev.code === 4001) {
            applyConn("superseded");
            setBusy(false); // a mid-turn takeover must not strand the composer as busy
            toast.warning("This chat was opened in another tab or window — Retry to take it back.", {
              id: "session-superseded", // dedupe: repeated takeovers replace, not stack
            });
            fail("session superseded by a newer connection");
            return;
          }
          // Always settle on a terminal state — never leave a stuck "Connecting…". If there
          // is a session to resume (an established drop, a failed reconnect attempt, OR an
          // initial open failure for an existing chat) back off and retry; otherwise it was
          // a draft with nothing to resume, so fall back to the draft state.
          if (currentSessionRef.current) scheduleReconnectRef.current();
          else applyConn("draft");
          fail("WebSocket connection closed before opening"); // no-op once didOpen/superseded
        };
      });
      ws.onmessage = (e) => {
        let msg: ServerEvent;
        try {
          msg = JSON.parse(e.data as string) as ServerEvent;
        } catch {
          return;
        }
        switch (msg.type) {
          case "hello":
            setRepo(msg.repo);
            setRuntime(msg.runtime || "");
            setSafetyNote(msg.safetyNote || null);
            setCapabilities(normalizeCapabilities(msg.capabilities));
            setCurrentSession(msg.sessionId);
            loadChats();
            break;
          case "echo_user":
            loadChats(); // server registered/updated session on user_message
            break;
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
            setPermissions((prev) => [
              ...prev,
              {
                id: msg.id,
                tool: msg.tool,
                input: msg.input,
                options: msg.options,
                timeoutMs: msg.timeoutMs,
                receivedAt: Date.now(),
              },
            ]);
            break;
          case "usage":
            if (msg.scope === "session") setSessionUsage(msg.usage);
            else {
              // Unscoped events are legacy current-context events. Only current usage belongs
              // on the "turn done" line; a cumulative session total would mislabel the turn.
              resultUsageRef.current = msg.usage;
              setUsage(msg.usage);
            }
            break;
          case "model": // server confirms an in-session switch — keep the picker in sync
            if (capsRef.current.models.some((m) => m.id === msg.model)) setModel(msg.model);
            break;
          case "approval_mode": // server confirms an approval-mode switch — sync the selector
            if (capsRef.current.approvalModes.some((a) => a.id === msg.mode))
              setApprovalMode(msg.mode);
            break;
          case "warning":
            // Live → toast (replay reconstructs it inline; see lib/transcript.ts).
            toast.warning(msg.message);
            break;
          case "result":
            setBusy(false);
            // Keep the end-of-turn cost summary inline (it's the turn record, not clutter).
            append({
              kind: "meta",
              text: formatResultMeta(resultUsageRef.current, msg.cost_usd, prevCostRef.current),
            });
            resultUsageRef.current = null;
            if (typeof msg.cost_usd === "number") prevCostRef.current = msg.cost_usd;
            loadChats(); // first turn just set this chat's title
            break;
          case "error":
            setBusy(false);
            // Live → a longer-lived error toast so it isn't missed; replay keeps it inline.
            toast.error(msg.message, { duration: 10_000 });
            break;
          case "memory_updated": {
            // Live → toast with Undo (replay rebuilds the MemoryCard). The Undo sends the
            // same wire message as undoMemory(); inline wsRef.send avoids a forward ref.
            const undoId = msg.id;
            toast("Memory updated", {
              description: `${msg.file} — ${msg.summary}`,
              action: {
                label: "Undo",
                onClick: () =>
                  wsRef.current?.send(JSON.stringify({ type: "memory_undo", id: undoId })),
              },
            });
            break;
          }
          case "memory_undone":
            // No live card to mutate (it became a toast); confirm the outcome as a toast.
            if (msg.ok) toast.success("Memory change undone");
            else toast.error("Undo unavailable (file changed)");
            break;
          default:
            break;
        }
      };
      return opened;
    },
    [append, appendDelta, finishAssistant, loadChats, applyConn, clearReconnect]
  );

  // Exponential backoff (+jitter) reconnect to the active session. Stops at OFFLINE after
  // RECONNECT_MAX_ATTEMPTS; the UI offers a manual Retry from there.
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return; // already scheduled
    const attempt = reconnectAttemptsRef.current;
    if (attempt >= RECONNECT_MAX_ATTEMPTS) {
      applyConn("offline");
      // Fail honest: "server down" and "server restarted → this tab's token is stale"
      // look identical over the WS (both close before open). Probe an authed endpoint
      // once — a 401/403 means the server is UP and it's the LINK that expired.
      api
        .get("/api/me")
        .then(() => {})
        .catch((e: unknown) => {
          const status = (e as { status?: number })?.status;
          if (status === 401 || status === 403)
            toast.error(
              "The server restarted, so this tab's link is stale — open the fresh link printed by `npm run gui` (or the desktop app).",
              // Terminal + actionable: stays until dismissed; id dedupes across Retry ladders.
              { duration: Infinity, id: "stale-gui-link" }
            );
        });
      return;
    }
    reconnectAttemptsRef.current = attempt + 1;
    applyConn("reconnecting");
    const delay =
      Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt) +
      Math.floor(Math.random() * 250);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      const sid = currentSessionRef.current;
      if (!sid) {
        applyConn("offline");
        return;
      }
      connect(sid).catch(() => {
        /* its onclose will reschedule */
      });
    }, delay);
  }, [connect, applyConn]);

  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  // Manual recovery from the OFFLINE state: reset backoff and retry now.
  const retryConnection = useCallback(() => {
    clearReconnect();
    reconnectAttemptsRef.current = 0;
    const sid = currentSessionRef.current;
    if (sid) connect(sid).catch(() => {});
  }, [connect, clearReconnect]);

  const resetChatState = useCallback(() => {
    setBusy(false);
    setPermissions([]);
    resultUsageRef.current = null;
    setUsage(null);
    setSessionUsage(null);
    prevCostRef.current = 0;
  }, []);

  const newChat = useCallback(() => {
    connectSeqRef.current++;
    openChatSeqRef.current++; // a slow in-flight openChat replay must not hijack the fresh draft
    currentSessionRef.current = null;
    clearReconnect();
    reconnectAttemptsRef.current = 0;
    try {
      wsRef.current?.close();
    } catch {
      /* already closed */
    }
    wsRef.current = null;
    applyConn("draft");
    resetChatState();
    setMessages([]);
    setInput("");
    setApprovalMode("default"); // never carry an elevated mode into a fresh chat
    setCurrentSession(null);
    setView("chat");
  }, [resetChatState, applyConn, clearReconnect]);

  // Replay a stored transcript, then resume its session for new turns.
  const openChat = useCallback(
    async (id: string) => {
      clearReconnect();
      reconnectAttemptsRef.current = 0;
      currentSessionRef.current = id; // resume target before any close handler can fire
      const seq = ++openChatSeqRef.current; // rapid switching: only the newest open wins
      setApprovalMode("default"); // approval mode is session-scoped; never inherit it across chats
      resetChatState();
      setView("chat");
      try {
        const d = await api.get<SessionTranscriptResponse>(`/api/sessions/${id}`);
        if (openChatSeqRef.current !== seq) return; // a newer chat was opened while we fetched
        const events = d.events || [];
        setMessages(buildMessagesFromEvents(events).map((m) => ({ ...m, uid: ++msgUidRef.current })));
        let lastCost = 0;
        let contextUsage: Usage | null = null;
        let aggregateUsage: Usage | null = null;
        let pendingResultUsage: Usage | null = null;
        for (const ev of events) {
          if (ev.type === "usage") {
            if (ev.scope === "session") aggregateUsage = ev.usage;
            else {
              pendingResultUsage = ev.usage;
              contextUsage = ev.usage;
            }
          }
          if (ev.type === "result") {
            pendingResultUsage = null;
            if (typeof ev.cost_usd === "number") lastCost = ev.cost_usd;
          }
        }
        prevCostRef.current = lastCost;
        resultUsageRef.current = pendingResultUsage;
        setUsage(contextUsage);
        setSessionUsage(aggregateUsage);
      } catch {
        if (openChatSeqRef.current !== seq) return; // superseded — don't touch the newer chat
        // A failed replay must not masquerade as an empty chat — say so, and keep the
        // session resumable (new turns still work; history is just not shown).
        setMessages([
          {
            kind: "meta",
            text: "Couldn't load this chat's history — new messages will still work. Reopen the chat to retry.",
            uid: ++msgUidRef.current,
          },
        ]);
        toast.error("Failed to load chat history.");
      }
      if (openChatSeqRef.current !== seq) return;
      setCurrentSession(id);
      connect(id).catch((e: Error) => append({ kind: "meta", text: `error: ${e.message}` }));
    },
    [append, connect, resetChatState, clearReconnect]
  );

  const changeModel = useCallback((m: string) => {
    const prev = modelRef.current;
    const seq = ++changeModelSeqRef.current;
    setModel(m); // applies to the NEXT send (sent on each user_message → setModel)
    api.post("/api/config/model", { model: m }).catch(() => {
      // The picker must not lie: roll back if the server rejected the change — but only
      // if a newer switch hasn't superseded this one (out-of-order failure replies).
      if (changeModelSeqRef.current !== seq) return;
      setModel(prev);
      toast.error("Couldn't switch model — reverted.");
    });
  }, []);

  const sendMessage = useCallback(
    async (override?: string) => {
      const text = (typeof override === "string" ? override : input).trim();
      if (!text) return;
      const openSocket = wsRef.current?.readyState === WebSocket.OPEN ? wsRef.current : null;
      if (!openSocket && currentSession !== null) return;
      append({ kind: "user", text });
      setInput("");
      setBusy(true);
      try {
        const ws = openSocket || (await connect());
        const payload: {
          type: "user_message";
          text: string;
          model?: string;
          approvalMode?: string;
        } = { type: "user_message", text, model };
        if (capsRef.current.approvalModes.some((a) => a.id === approvalMode)) {
          payload.approvalMode = approvalMode;
        }
        ws.send(JSON.stringify(payload));
      } catch (e) {
        setBusy(false);
        // The message never left the client. Roll back the optimistic user bubble
        // and restore the text so the turn can be retried.
        setMessages((prev) =>
          prev[prev.length - 1]?.kind === "user" &&
          (prev[prev.length - 1] as { text?: string }).text === text
            ? prev.slice(0, -1)
            : prev
        );
        setInput((cur) => cur || text);
        append({ kind: "meta", text: `error: ${(e as Error).message}` });
      }
    },
    [append, connect, currentSession, input, model, approvalMode]
  );

  const respondPermission = useCallback((id: number, allow: boolean) => {
    wsRef.current?.send(JSON.stringify({ type: "permission_response", id, allow }));
    setPermissions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const respondPermissionOption = useCallback((id: number, optionId: string) => {
    wsRef.current?.send(JSON.stringify({ type: "permission_response", id, optionId }));
    setPermissions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // The server auto-denied this approval at its deadline — remove the dead card and
  // say what happened, so a late Allow can't look like it worked (it would be a no-op).
  const expirePermission = useCallback((id: number) => {
    if (!permissionsRef.current.some((p) => p.id === id)) return;
    toast.warning("The approval request timed out and was denied automatically.", {
      id: `perm-expired-${id}`,
    });
    setPermissions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const undoMemory = useCallback((id: string) => {
    wsRef.current?.send(JSON.stringify({ type: "memory_undo", id }));
  }, []);

  /* ---- boot effects (identity + config + restore last chat) ---- */

  useEffect(() => {
    api
      .get<{ me?: { role?: string } }>("/api/me")
      .then((d) => setRole(d.me?.role || null))
      .catch(() => {});
    api
      .get<{ repo?: string }>("/api/info")
      .then((d) => {
        const nextRepo = d.repo || "";
        setRepo(nextRepo);
        if (typeof document !== "undefined" && nextRepo) {
          const base = nextRepo.split("/").filter(Boolean).pop() || "AIOS Workspace";
          document.title = base
            .replace(/[-_]+/g, " ")
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
        }
      })
      .catch(() => {});
    api
      .get<ConfigResponse>("/api/config")
      .then((d) => {
        // Seed capabilities from config so capability-gated chrome (model picker,
        // context meter, memory controls) is correct on first paint — before the
        // first WebSocket hello. Older servers omit this → keep DEFAULT_CAPS.
        const caps = normalizeCapabilities(d.capabilities);
        setCapabilities(caps);
        if (caps.models.some((m) => m.id === d.model)) setModel(d.model);
        setRuntime(d.runtime || "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadChats().then((d) => {
      const validLast = !!d.lastSelected && (d.sessions || []).some((c) => c.id === d.lastSelected);
      if (validLast && d.lastSelected) openChat(d.lastSelected);
      else {
        resetChatState();
        setMessages([]);
        setCurrentSession(null);
        setView("chat");
      }
    });
    const seqRef = connectSeqRef;
    const ws = wsRef;
    const timer = reconnectTimerRef;
    return () => {
      seqRef.current++;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      try {
        ws.current?.close();
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    // connection / identity
    token,
    api,
    repo,
    role,
    // runtime (BYOA)
    runtime,
    capabilities,
    safetyNote,
    // session
    view,
    setView,
    connected,
    connectionStatus,
    messages,
    input,
    setInput,
    busy,
    permissions,
    model,
    approvalMode,
    setApprovalMode,
    usage,
    sessionUsage,
    chats,
    chatsLoadFailed,
    currentSession,
    // actions
    changeModel,
    newChat,
    openChat,
    sendMessage,
    respondPermission,
    respondPermissionOption,
    expirePermission,
    undoMemory,
    loadChats,
    retryConnection,
  };
}

export type CockpitState = ReturnType<typeof useCockpit>;
