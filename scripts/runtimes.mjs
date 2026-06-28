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
    modelSwitching: false,
    tokenUsage: false,
    contextWindow: null,
    costTracking: false,
    memoryReviewer: false,
    approvalModes: [],
    reasoningLevels: [],
    fileAttach: false,
  },
};

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
