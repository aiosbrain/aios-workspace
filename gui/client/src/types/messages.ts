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

export type UiMessage = UserMessage | AssistantMessage | ToolMessage | MemoryMessage | MetaMessage;

/** A pending interactive permission request awaiting the user's response. */
export interface PendingPermission {
  id: number;
  tool: string;
  input: unknown;
  options?: PermissionOption[];
}
