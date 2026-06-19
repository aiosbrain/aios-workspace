/**
 * sources.mjs — discover local agent-session-log files per tool.
 *
 * Pure local enumeration of the user's home dir. Returns absolute file paths;
 * reading/parsing happens in the orchestrator (so it can tail-parse with state).
 * Zero dependencies.
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Recursively collect files under `dir` matching `pred(basename, fullpath)`. */
function walk(dir, pred, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, pred, out);
    else if (e.isFile() && pred(e.name, full)) out.push(full);
  }
  return out;
}

/** Claude Code: ~/.claude/projects/<slug>/<sessionId>.jsonl (skip injections). */
export function discoverClaude(home = os.homedir()) {
  const root = path.join(home, ".claude", "projects");
  if (!existsSync(root)) return [];
  return walk(root, (name) => name.endsWith(".jsonl") && name !== "skill-injections.jsonl");
}

/** Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl */
export function discoverCodex(home = os.homedir()) {
  const root = path.join(home, ".codex", "sessions");
  if (!existsSync(root)) return [];
  return walk(root, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"));
}

/** Cursor: state.vscdb (globalStorage + per-workspace). macOS path. */
export function discoverCursor(home = os.homedir()) {
  const root = path.join(home, "Library", "Application Support", "Cursor", "User");
  if (!existsSync(root)) return [];
  return walk(root, (name) => name === "state.vscdb");
}

export const DISCOVERERS = {
  claude: discoverClaude,
  codex: discoverCodex,
  cursor: discoverCursor,
};

/** Stat helper used by incremental state (size + mtime cheap-skip). */
export function fileStat(file) {
  try {
    const st = statSync(file);
    return { size: st.size, mtime_ms: Math.floor(st.mtimeMs) };
  } catch {
    return null;
  }
}
