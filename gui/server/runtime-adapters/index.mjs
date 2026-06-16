// Runtime adapter registry (BYOA Phase 3).
//
// One WebSocket session is driven by exactly one adapter. Every adapter exports
// `meta` + `run(host)` and emits the same WS event shapes (delta | tool_use |
// tool_result | assistant_done | result | error), so the React client is
// runtime-agnostic. Runtime names + capabilities come from the single source of
// truth in scripts/runtimes.mjs (shared with `aios skills export` + validators).
// See docs/byoa.md.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFlatYaml } from "../../../scripts/flat-yaml.mjs";
import { RUNTIMES, GUI_RUNTIMES } from "../../../scripts/runtimes.mjs";
import * as claudeCode from "./claude-code.mjs";

// driver → adapter module (filled in as slices land: acp/codex/opencode next).
const ADAPTERS = {
  "claude-sdk": claudeCode,
};

/** Read the runtime selection from aios.yaml. Default claude-code ⇒ no change. */
export function readAgentConfig(repo) {
  let cfg = {};
  const p = path.join(repo, "aios.yaml");
  if (existsSync(p)) {
    try { cfg = parseFlatYaml(readFileSync(p, "utf8")); } catch { cfg = {}; }
  }
  return {
    runtime: cfg.agent_runtime || "claude-code",
    model: cfg.agent_model || "",
    baseUrl: cfg.agent_base_url || "",
    personality: cfg.agent_personality || "aios",
  };
}

/**
 * Resolve the adapter for a runtime. Fails LOUDLY (never silently falls back to
 * claude-code) so a misconfigured runtime is obvious, with the fix in the message.
 */
export function createAdapter(runtime) {
  const name = runtime || "claude-code";
  if (!(name in RUNTIMES)) {
    throw new Error(`unknown agent_runtime '${name}'. Valid: ${Object.keys(RUNTIMES).join(", ")}. Fix aios.yaml → agent_runtime.`);
  }
  const gui = GUI_RUNTIMES[name];
  if (!gui) {
    throw new Error(`agent_runtime '${name}' is not GUI-drivable (no tool harness). Use 'claude-code' in the GUI, or run '${name}' headless.`);
  }
  const adapter = ADAPTERS[gui.driver];
  if (!adapter) {
    throw new Error(`agent_runtime '${name}' (driver '${gui.driver}') is not implemented in the GUI yet — landing in a later BYOA Phase 3 slice. Use 'claude-code' for now.`);
  }
  return adapter;
}
