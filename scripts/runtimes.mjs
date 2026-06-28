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
export const DRIVER_CAPS = {
  "claude-sdk": {
    permissionStyle: "boolean",
    modelSwitching: true,
    tokenUsage: true,
    contextWindow: 200000,
    costTracking: true,
    memoryReviewer: true,
  },
  acp: {
    permissionStyle: "options",
    modelSwitching: false,
    tokenUsage: false,
    contextWindow: null,
    costTracking: false,
    memoryReviewer: false,
  },
  codex: {
    permissionStyle: "boolean",
    modelSwitching: false,
    tokenUsage: false,
    contextWindow: null,
    costTracking: false,
    memoryReviewer: false,
  },
  opencode: {
    permissionStyle: "options",
    modelSwitching: false,
    tokenUsage: false,
    contextWindow: null,
    costTracking: false,
    memoryReviewer: false,
  },
};

/**
 * Build the `capabilities` object for a runtime. `modelOptions` is the server's
 * resolved [{id,label}] list (only attached when the driver supports switching).
 * Unknown / non-GUI runtimes fall back to the claude-sdk shape (safe default).
 */
export function runtimeCapabilities(runtime, modelOptions = []) {
  const gui = GUI_RUNTIMES[runtime];
  const base = (gui && DRIVER_CAPS[gui.driver]) || DRIVER_CAPS["claude-sdk"];
  return { ...base, models: base.modelSwitching ? modelOptions : [] };
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
