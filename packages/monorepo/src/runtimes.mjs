// Canonical agent-runtime registry — the single source of truth shared by
// BYOA Phase 2 (`aios skills export`), Phase 3 (the GUI adapters), and the
// OGR04/OGR07 validators. Adding or renaming a runtime happens HERE only.
//
//   export: skill-export capability (layout + whether it runs the multi-agent
//           .workflow.js harness natively). null = not an export target.
//   gui:    GUI-drivable capability (which adapter driver, optional spawn
//           command). null = NOT GUI-drivable (e.g. a bare API loop with no
//           tool harness).

export const RUNTIMES = {
  "claude-code": {
    export: { layout: "claude", harness: true },
    gui: { driver: "claude-sdk" },
  },
  hermes: {
    export: { layout: "skillmd", harness: false },
    gui: { driver: "acp", command: ["hermes", "acp"] },
  },
  openclaw: {
    export: { layout: "skillmd", harness: false },
    gui: { driver: "acp", command: ["openclaw", "acp"] }, // `openclaw acp` = stdio ACP bridge (Gateway-backed)
  },
  codex: {
    export: { layout: "instructions", harness: false },
    gui: { driver: "codex" },
  },
  opencode: {
    export: { layout: "instructions", harness: false },
    gui: { driver: "opencode" },
  },
  "claude-api": {
    export: { layout: "instructions", harness: false },
    gui: null, // bare Claude API loop has no tool harness — not GUI-drivable
  },
};

export const RUNTIME_NAMES = Object.keys(RUNTIMES);

// Capability descriptor per GUI driver. Consumed by the GUI server to populate the
// additive `hello.capabilities` payload so the cockpit UI is capability-driven and
// NEVER branches on a runtime name. Adding a driver's caps happens HERE only.
//   permissionStyle: "boolean" (Claude allow/deny) | "options" (ACP/OpenCode choices)
//   modelSwitching:  whether the picker is shown (models injected by the server)
//   tokenUsage:      reports token usage → drives the context meter
//   contextWindow:   meter denominator; null hides the bar
//   costTracking:    reports end-of-turn cost
//   memoryReviewer:  background memory reviewer available (toast + Settings toggle)
//   approvalModes:   composer approval-mode choices [{id,label}]; [] hides the selector.
//                    The claude-sdk list is filled per-call in runtimeCapabilities() (it is
//                    env-gated — see claudeApprovalModes); other drivers stay [].
//   reasoningLevels: scaffold [{id,label}]; [] hides the control (no backend wiring yet).
//   fileAttach:      scaffold; whether file attachment is offered (no backend wiring yet).
export const DRIVER_CAPS = {
  "claude-sdk": {
    permissionStyle: "boolean",
    modelSwitching: true,
    tokenUsage: true,
    contextWindow: 200000,
    costTracking: true,
    memoryReviewer: true,
    approvalModes: [],
    reasoningLevels: [],
    fileAttach: false,
  },
  acp: {
    permissionStyle: "options",
    modelSwitching: false,
    tokenUsage: false,
    contextWindow: null,
    costTracking: false,
    memoryReviewer: false,
    approvalModes: [],
    reasoningLevels: [],
    fileAttach: false,
  },
  codex: {
    permissionStyle: "boolean",
    modelSwitching: false,
    tokenUsage: false,
    contextWindow: null,
    costTracking: false,
    memoryReviewer: false,
    approvalModes: [],
    reasoningLevels: [],
    fileAttach: false,
  },
  opencode: {
    permissionStyle: "options",
    // AIO-536: the picker is catalog-driven for opencode — the model list comes from
    // the local OpenCode server's own provider/model listing (whatever providers the
    // owner authenticated), with a seeded fallback. See RUNTIME_MODEL_CATALOGS.
    modelSwitching: true,
    tokenUsage: false,
    contextWindow: null,
    // AIO-536: the adapter reads the session's authoritative cost from the OpenCode
    // server API at turn end (never estimated; null when the read fails).
    costTracking: true,
    memoryReviewer: false,
    approvalModes: [],
    reasoningLevels: [],
    fileAttach: false,
  },
};

// ── per-runtime model catalogs (AIO-536) ─────────────────────────────────────
//
// The cockpit's model choice is catalog-driven, not hardcoded. Each GUI-drivable
// runtime that supports model switching declares a catalog HERE:
//
//   models       seed [{id,label,group?}] — the list shown when no dynamic listing
//                is available. For claude-code this IS the whole catalog.
//   defaultModel the id the adapter falls back to for an empty/unknown agent_model.
//   permissive   true → the runtime brokers arbitrary providers, so any well-formed
//                `provider/model` id is accepted even if it isn't in `models`
//                (matching OpenCode's own UX — its auth store decides what resolves).
//   dynamic      true → a runtime-specific resolver may REPLACE `models` at request
//                time (opencode reads the local server's /config/providers).
//
// A runtime with no entry here has no picker (DRIVER_CAPS.modelSwitching stays false).
export const RUNTIME_MODEL_CATALOGS = {
  "claude-code": {
    // Canonical Anthropic list — re-exported by the claude-code adapter as
    // MODEL_OPTIONS so the picker, the allow-list and the config API can't drift.
    // The Agent SDK path is Anthropic-only by nature, so this list is closed.
    models: [
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
    ],
    defaultModel: "claude-sonnet-4-6",
    permissive: false,
    dynamic: false,
  },
  opencode: {
    // Seeded fallback only — the live catalog comes from the OpenCode server.
    // qwen3.7-plus is the model the Team Brain runs (parity is a convention, not
    // shared config).
    models: [
      { id: "openrouter/qwen/qwen3.7-plus", label: "Qwen3.7 Plus", group: "openrouter" },
      { id: "openrouter/qwen/qwen3.7-max", label: "Qwen3.7 Max", group: "openrouter" },
    ],
    defaultModel: "openrouter/qwen/qwen3.7-plus",
    permissive: true,
    dynamic: true,
  },
};

/**
 * Is `id` a well-formed `provider/model` reference? Requires a non-empty provider
 * segment and a non-empty model segment (which may itself contain slashes, e.g.
 * `openrouter/qwen/qwen3.7-plus`), with no whitespace or control characters.
 * This is the ONLY shape a permissive runtime will accept — it is not a
 * "write anything" escape hatch.
 */
export function isWellFormedModelId(id) {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > 200) return false;
  if (/[\s"'\\]/.test(id)) return false;
  const i = id.indexOf("/");
  return i > 0 && i < id.length - 1;
}

/**
 * Resolve the model catalog for a runtime.
 *
 * @param {string} runtime
 * @param {Array<{id:string,label:string,group?:string}>|null} dynamicModels
 *   runtime-resolved list that REPLACES the seed when non-empty (opencode's live
 *   provider listing). Ignored for non-dynamic runtimes.
 * @returns {{runtime:string, models:Array, defaultModel:string, permissive:boolean, source:"static"|"dynamic"|"fallback"}}
 *   An unknown / non-switching runtime yields an empty catalog (no picker).
 */
export function modelCatalog(runtime, dynamicModels = null) {
  const spec = RUNTIME_MODEL_CATALOGS[runtime];
  if (!spec) {
    return { runtime, models: [], defaultModel: "", permissive: false, source: "static" };
  }
  const useDynamic = spec.dynamic && Array.isArray(dynamicModels) && dynamicModels.length > 0;
  return {
    runtime,
    models: useDynamic ? dynamicModels : spec.models,
    defaultModel: spec.defaultModel,
    permissive: !!spec.permissive,
    source: spec.dynamic ? (useDynamic ? "dynamic" : "fallback") : "static",
  };
}

/**
 * Whether `id` may be written as this runtime's agent_model. A catalog hit always
 * wins; a permissive runtime additionally accepts any well-formed `provider/model`.
 * A runtime with no catalog accepts nothing (there is no picker to drive it).
 */
export function isModelAllowed(catalog, id) {
  if (!catalog || !catalog.models.length) return false;
  if (catalog.models.some((m) => m.id === id)) return true;
  return catalog.permissive && isWellFormedModelId(id);
}

/** Human-readable "valid options" tail for a 400, naming the runtime. */
export function modelRejectionMessage(catalog) {
  const ids = catalog.models.map((m) => m.id);
  if (!ids.length) return `runtime '${catalog.runtime}' does not support model selection`;
  const shown = ids.slice(0, 12).join(", ") + (ids.length > 12 ? `, … (${ids.length} total)` : "");
  return catalog.permissive
    ? `model for runtime '${catalog.runtime}' must be a 'provider/model' id (e.g. ${ids[0]}). Known: ${shown}`
    : `model for runtime '${catalog.runtime}' must be one of: ${shown}`;
}

/**
 * Approval modes the claude-sdk driver advertises, mapped to SDK PermissionModes.
 * "Ask for approval" (default) keeps the per-tool host prompt; "Approve edits"
 * (acceptEdits) auto-accepts file edits but still prompts for other dangerous tools.
 *
 * "Full access" (bypassPermissions) is GATED OFF by default: it skips the SDK permission
 * prompt entirely (and needs allowDangerouslySkipPermissions server-side), so it is only
 * advertised when AIOS_GUI_ALLOW_FULL_ACCESS is set — which must stay unset until the
 * governance regression proves PreToolUse hooks still block secret/tier violations under it.
 * Read live (not cached) so a test can toggle the env var per case.
 */
/**
 * Parse AIOS_GUI_ALLOW_FULL_ACCESS as an explicit affirmative opt-in. ONLY 1/true/yes/on
 * (case-insensitive) enable it; 0/false/""/unset stay OFF — so a false-like value can never
 * light up "Full access" (bypassPermissions). Shared by the claude-code adapter so the
 * advertised mode list and the SDK bypass gate stay aligned. Read live (not cached) so a
 * test can toggle the env var per case.
 */
export function fullAccessEnabled() {
  const v = (process.env.AIOS_GUI_ALLOW_FULL_ACCESS || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function claudeApprovalModes() {
  const modes = [
    { id: "default", label: "Ask for approval" },
    { id: "acceptEdits", label: "Approve edits" },
  ];
  if (fullAccessEnabled()) {
    modes.push({ id: "bypassPermissions", label: "Full access" });
  }
  return modes;
}

/** The set of approval-mode ids the claude-sdk driver will honor right now (env-gated). */
export function allowedApprovalModeIds() {
  return new Set(claudeApprovalModes().map((m) => m.id));
}

/**
 * Build the `capabilities` object for a runtime. `modelOptions` is the server's
 * resolved [{id,label}] list (only attached when the driver supports switching).
 * Unknown / non-GUI runtimes fall back to the claude-sdk shape (safe default).
 */
export function runtimeCapabilities(runtime, modelOptions = []) {
  const gui = GUI_RUNTIMES[runtime];
  const driver = (gui && gui.driver) || "claude-sdk";
  const base = DRIVER_CAPS[driver] || DRIVER_CAPS["claude-sdk"];
  return {
    ...base,
    models: base.modelSwitching ? modelOptions : [],
    // Only the claude-sdk driver has a wired, env-gated approval-mode list.
    approvalModes: driver === "claude-sdk" ? claudeApprovalModes() : [],
  };
}

// View consumed by `aios skills export` (Phase 2): { runtime: {layout, harness} }
export const EXPORT_RUNTIMES = Object.fromEntries(
  Object.entries(RUNTIMES)
    .filter(([, r]) => r.export)
    .map(([k, r]) => [k, r.export])
);

// View consumed by the GUI registry (Phase 3): { runtime: {driver, command?} }
export const GUI_RUNTIMES = Object.fromEntries(
  Object.entries(RUNTIMES)
    .filter(([, r]) => r.gui)
    .map(([k, r]) => [k, r.gui])
);
