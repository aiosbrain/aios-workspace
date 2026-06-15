// Runtime adapter registry (BYOA Phase 3).
//
// One WebSocket session is driven by exactly one adapter. Every adapter exports
// `meta` + `run(host)` and emits the same WS event shapes (delta | tool_use |
// tool_result | assistant_done | result | error), so the React client is
// runtime-agnostic. See docs/byoa.md.
//
// Slice 1: claude-code only. Slice 2 wires this to scripts/runtimes.mjs (the
// single source of truth) + readAgentConfig() + clear "no GUI adapter" errors.

import * as claudeCode from "./claude-code.mjs";

const ADAPTERS = {
  "claude-code": claudeCode,
};

export function createAdapter(runtime) {
  const adapter = ADAPTERS[runtime || "claude-code"];
  if (!adapter) {
    throw new Error(`no GUI runtime adapter for '${runtime}'. Available: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return adapter;
}
