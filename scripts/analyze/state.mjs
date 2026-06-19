/**
 * state.mjs — incremental-processing state for `aios analyze`.
 *
 * Lives at .aios/analyze-state.json (gitignored, separate from sync state.json
 * so the two never collide). Tracks per-source-file sha + byte offset so that
 * append-only logs (Claude/Codex .jsonl) are tail-parsed — only new bytes read.
 *
 * Zero dependencies.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const STATE_VERSION = 1;

function statePath(repo) {
  return path.join(repo, ".aios", "analyze-state.json");
}

export function loadAnalyzeState(repo) {
  const p = statePath(repo);
  if (!existsSync(p)) return { version: STATE_VERSION, last_run: null, sources: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    if (!s.sources) s.sources = {};
    return s;
  } catch {
    return { version: STATE_VERSION, last_run: null, sources: {} };
  }
}

export function saveAnalyzeState(repo, state) {
  const dir = path.join(repo, ".aios");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  state.version = STATE_VERSION;
  writeFileSync(statePath(repo), JSON.stringify(state, null, 2));
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
