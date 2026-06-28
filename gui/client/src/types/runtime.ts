/**
 * BYOA (bring-your-own-agent) capability model.
 *
 * The cockpit is runtime-agnostic: it drives claude-code, hermes/openclaw (ACP),
 * codex, opencode, … via server-side adapters. The UI must NEVER branch on the
 * runtime *name* — it reads a capability flag here instead, so adding a new runtime
 * needs zero client changes. The server fills `capabilities` in the `hello` event
 * from its registry (scripts/runtimes.mjs); when absent (older server) the client
 * falls back to DEFAULT_CAPS.
 */

export interface ModelOption {
  id: string;
  label: string;
}

/** A composer approval-mode choice (e.g. claude-sdk SDK permission modes). */
export interface ApprovalModeOption {
  /** Wire id sent back on `user_message.approvalMode` (e.g. "default", "acceptEdits"). */
  id: string;
  label: string;
}

/** A composer reasoning-effort choice. Scaffold only — no backend wiring yet. */
export interface ReasoningLevel {
  id: string;
  label: string;
}

export interface Capabilities {
  /** "boolean" → allow/deny (Claude); "options" → runtime-supplied choices (ACP/OpenCode). */
  permissionStyle: "boolean" | "options";
  /** Whether the model picker is shown. */
  modelSwitching: boolean;
  /** Runtime-resolved selectable models. Empty → no picker. */
  models: ModelOption[];
  /** Whether the runtime reports token usage (drives the context meter). */
  tokenUsage: boolean;
  /** Context-window denominator for the meter; null → hide the bar. */
  contextWindow: number | null;
  /** Whether end-of-turn cost is reported. */
  costTracking: boolean;
  /** Whether the background memory reviewer is available (toast + Settings toggle). */
  memoryReviewer: boolean;
  /**
   * Runtime-supplied approval modes for the composer selector. Empty → no selector.
   * Only an upgraded server advertises these; the client NEVER infers them from the
   * runtime name, and DEFAULT_CAPS leaves this empty (an old server that omits
   * `hello.capabilities` cannot honor a mid-session `approvalMode`).
   */
  approvalModes: ApprovalModeOption[];
  /** Scaffold: reasoning-effort choices. Empty → no control. No backend wiring yet. */
  reasoningLevels: ReasoningLevel[];
  /** Scaffold: whether file attachment is offered. No backend wiring yet. */
  fileAttach: boolean;
}

/**
 * Claude-shaped fallback used when the server omits `hello.capabilities`.
 * Mirrors the legacy hardcoded assumptions (200k window, Sonnet/Opus, boolean perms)
 * so behaviour against an un-upgraded server is unchanged.
 */
export const DEFAULT_CAPS: Capabilities = {
  permissionStyle: "boolean",
  modelSwitching: true,
  models: [
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
  ],
  tokenUsage: true,
  contextWindow: 200_000,
  costTracking: true,
  memoryReviewer: true,
  // Interactive capabilities an old server can't honor stay OFF in the fallback:
  // a server that omits `hello.capabilities` ignores `approvalMode`, so showing a
  // selector here would be a dead control. Only upgraded runtimeCapabilities() lights it.
  approvalModes: [],
  reasoningLevels: [],
  fileAttach: false,
};
