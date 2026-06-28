import { createContext, useContext, type ReactNode } from "react";
import { useCockpit, type CockpitState } from "../hooks/useCockpit";

/**
 * One provider owns the cockpit state (a single agent WebSocket + session). It is
 * exposed through three typed selector hooks so call sites read only what they need:
 *   useConnection() — transport/identity (token, api, repo, role)
 *   useRuntime()    — BYOA runtime + capabilities (the one place the UI asks
 *                     "what can this agent do?")
 *   useSession()    — chat stream + per-session state + actions
 */
const CockpitContext = createContext<CockpitState | null>(null);

export function CockpitProvider({ children }: { children: ReactNode }) {
  const value = useCockpit();
  return <CockpitContext.Provider value={value}>{children}</CockpitContext.Provider>;
}

function useCockpitContext(): CockpitState {
  const ctx = useContext(CockpitContext);
  if (!ctx) throw new Error("cockpit hooks must be used within <CockpitProvider>");
  return ctx;
}

export function useConnection() {
  const { token, api, repo, role } = useCockpitContext();
  return { token, api, repo, role };
}

export function useRuntime() {
  const { runtime, capabilities, safetyNote } = useCockpitContext();
  return { runtime, capabilities, safetyNote };
}

export function useSession() {
  const {
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
    usage,
    chats,
    currentSession,
    changeModel,
    newChat,
    openChat,
    sendMessage,
    respondPermission,
    respondPermissionOption,
    undoMemory,
    loadChats,
    retryConnection,
  } = useCockpitContext();
  return {
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
    usage,
    chats,
    currentSession,
    changeModel,
    newChat,
    openChat,
    sendMessage,
    respondPermission,
    respondPermissionOption,
    undoMemory,
    loadChats,
    retryConnection,
  };
}
