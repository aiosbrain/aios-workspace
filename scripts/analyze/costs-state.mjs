/**
 * costs-state.mjs — push dedup for Cursor billing rows (analyze --push).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const STATE_VERSION = 1;

function statePath(repo) {
  return path.join(repo, ".aios", "costs-state.json");
}

export function loadCostsState(repo) {
  const p = statePath(repo);
  if (!existsSync(p)) return { version: STATE_VERSION, pushed: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    if (!s.pushed) s.pushed = {};
    return s;
  } catch {
    return { version: STATE_VERSION, pushed: {} };
  }
}

export function saveCostsState(repo, state) {
  const dir = path.join(repo, ".aios");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  state.version = STATE_VERSION;
  writeFileSync(statePath(repo), JSON.stringify(state, null, 2));
}

export function pushKey(payload) {
  return `${payload.date}:${payload.provider}:${payload.source}:${payload.project || ""}`;
}

export function payloadHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}
