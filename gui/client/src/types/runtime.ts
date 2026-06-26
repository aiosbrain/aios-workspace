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
};
