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
  "hermes": {
    export: { layout: "skillmd", harness: false },
    gui: { driver: "acp", command: ["hermes", "acp"] },
  },
  "openclaw": {
    export: { layout: "skillmd", harness: false },
    gui: { driver: "acp", command: ["openclaw", "acp"] }, // `openclaw acp` = stdio ACP bridge (Gateway-backed)
  },
  "codex": {
    export: { layout: "instructions", harness: false },
    gui: { driver: "codex" },
  },
  "opencode": {
    export: { layout: "instructions", harness: false },
    gui: { driver: "opencode" },
  },
  "claude-api": {
    export: { layout: "instructions", harness: false },
    gui: null, // bare Claude API loop has no tool harness — not GUI-drivable
  },
};

export const RUNTIME_NAMES = Object.keys(RUNTIMES);

// View consumed by `aios skills export` (Phase 2): { runtime: {layout, harness} }
export const EXPORT_RUNTIMES = Object.fromEntries(
  Object.entries(RUNTIMES).filter(([, r]) => r.export).map(([k, r]) => [k, r.export]),
);

// View consumed by the GUI registry (Phase 3): { runtime: {driver, command?} }
export const GUI_RUNTIMES = Object.fromEntries(
  Object.entries(RUNTIMES).filter(([, r]) => r.gui).map(([k, r]) => [k, r.gui]),
);
