import { useCallback, useEffect, useRef, useState } from "react";
import { createApi } from "../lib/api";
import { resolveGuiToken, connectErrorMessage } from "../lib/token";
import { formatResultMeta } from "../lib/format";
import { buildMessagesFromEvents } from "../lib/transcript";
import { DEFAULT_CAPS, type Capabilities } from "../types/runtime";
import type {
  ServerEvent,
  Usage,
  ConfigResponse,
  SessionListResponse,
  SessionTranscriptResponse,
} from "../types/protocol";
import type { UiMessage, PendingPermission } from "../types/messages";

export type ViewKey = "chat" | "review" | "settings";

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
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [model, setModel] = useState(DEFAULT_CAPS.models[0]?.id ?? "");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [chats, setChats] = useState<SessionListResponse["sessions"]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const usageRef = useRef<Usage | null>(null); // latest usage for the result line (state is async)
  const prevCostRef = useRef(0); // session cost so far, for a per-turn delta
  const connectSeqRef = useRef(0); // ignore callbacks from superseded sockets
  const capsRef = useRef<Capabilities>(DEFAULT_CAPS); // fresh caps inside the ws handler
  capsRef.current = capabilities;

  const append = useCallback((m: UiMessage) => setMessages((prev) => [...prev, m]), []);

  const appendDelta = useCallback((text: string) => {
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

  const loadChats = useCallback(async (): Promise<SessionListResponse> => {
    try {
      const d = await api.get<SessionListResponse>("/api/sessions");
      setChats(d.sessions || []);
      return d;
    } catch {
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
      try {
        wsRef.current?.close();
      } catch {
        /* already closed */
      }
      const seq = ++connectSeqRef.current;
      setConnected(false);
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
            setCapabilities(msg.capabilities ?? DEFAULT_CAPS);
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
              { id: msg.id, tool: msg.tool, input: msg.input, options: msg.options },
            ]);
            break;
          case "usage":
            usageRef.current = msg.usage;
            setUsage(msg.usage);
            break;
          case "model": // server confirms an in-session switch — keep the picker in sync
            if (capsRef.current.models.some((m) => m.id === msg.model)) setModel(msg.model);
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
            append({ kind: "meta", text: `error: ${msg.message}` });
            break;
          case "memory_updated":
            append({
              kind: "memory",
              id: msg.id,
              file: msg.file,
              summary: msg.summary,
              count: msg.count,
            });
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

  // Replay a stored transcript, then resume its session for new turns.
  const openChat = useCallback(
    async (id: string) => {
      resetChatState();
      setView("chat");
      try {
        const d = await api.get<SessionTranscriptResponse>(`/api/sessions/${id}`);
        const events = d.events || [];
        setMessages(buildMessagesFromEvents(events));
        let lastCost = 0;
        let lastUsage: Usage | null = null;
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
      connect(id).catch((e: Error) => append({ kind: "meta", text: `error: ${e.message}` }));
    },
    [append, connect, resetChatState]
  );

  const changeModel = useCallback((m: string) => {
    setModel(m); // applies to the NEXT send (sent on each user_message → setModel)
    api.post("/api/config/model", { model: m }).catch(() => {});
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
        ws.send(JSON.stringify({ type: "user_message", text, model }));
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
    [append, connect, currentSession, input, model]
  );

  const respondPermission = useCallback((id: number, allow: boolean) => {
    wsRef.current?.send(JSON.stringify({ type: "permission_response", id, allow }));
    setPermissions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const respondPermissionOption = useCallback((id: number, optionId: string) => {
    wsRef.current?.send(JSON.stringify({ type: "permission_response", id, optionId }));
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
      .then((d) => setRepo(d.repo || ""))
      .catch(() => {});
    api
      .get<ConfigResponse>("/api/config")
      .then((d) => {
        // Seed capabilities from config so capability-gated chrome (model picker,
        // context meter, memory controls) is correct on first paint — before the
        // first WebSocket hello. Older servers omit this → keep DEFAULT_CAPS.
        const caps = d.capabilities ?? DEFAULT_CAPS;
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
    return () => {
      seqRef.current++;
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
    messages,
    input,
    setInput,
    busy,
    permissions,
    model,
    usage,
    chats,
    currentSession,
    // actions
    changeModel,
    newChat,
    openChat,
    sendMessage,
    respondPermission,
    respondPermissionOption,
    undoMemory,
    loadChats,
  };
}

export type CockpitState = ReturnType<typeof useCockpit>;
