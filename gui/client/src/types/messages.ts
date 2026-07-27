/** Client-side render models — what the chat stream and transcript replay produce. */
import type { PermissionOption } from "./protocol";

export interface UserMessage {
  kind: "user";
  text: string;
}
export interface AssistantMessage {
  kind: "assistant";
  text: string;
  streaming?: boolean;
}
export interface ToolMessage {
  kind: "tool";
  name: string;
  input: unknown;
  id: string;
  result: string | null;
  isError?: boolean;
}
export interface MemoryMessage {
  kind: "memory";
  id: string;
  file: string;
  summary: string;
  count?: number;
  undone?: boolean;
  undoFailed?: boolean;
}
export interface MetaMessage {
  kind: "meta";
  text: string;
}

/** Monotonic per-render uid — stable React list keys over a mutating stream. */
export type WithUid = { uid?: number };

export type UiMessage = (
  UserMessage | AssistantMessage | ToolMessage | MemoryMessage | MetaMessage
) &
  WithUid;

/** A pending interactive permission request awaiting the user's response. */
export interface PendingPermission {
  id: number;
  tool: string;
  input: unknown;
  options?: PermissionOption[];
  /** Server auto-denies after this long; drives the card's countdown. */
  timeoutMs?: number;
  /** Client-side arrival time (ms epoch) — countdown anchor. */
  receivedAt?: number;
}
