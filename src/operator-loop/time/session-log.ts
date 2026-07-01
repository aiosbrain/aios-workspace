// Typed reader for Claude Code session logs (~/.claude/projects/<slug>/<sessionId>.jsonl).
//
// Reuses the tolerant JSONL parsing APPROACH of scripts/analyze/parse-claude.mjs, but defines its
// own event shape that PRESERVES the canonical cwd realpath. The upstream parser keeps only a
// basename `project`, which is unsafe for tier scoping (basenames collide across worktrees /
// unrelated repos). Zero deps, pure derivation + a thin fs walker.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Actor = "user" | "assistant" | "subagent";

export interface SessionEvent {
  sessionId: string;
  tsMs: number; // epoch ms (finite; records without a parseable timestamp are dropped)
  cwdRealpath: string | null; // canonical realpath of the record's cwd, or null if unresolved
  gitBranch: string | null;
  actor: Actor;
  toolName: string | null; // set for assistant tool_use blocks; null otherwise
}

export interface ReadOptions {
  projectsDir?: string; // default ~/.claude/projects
  sinceMs?: number; // skip files whose mtime is older than this (cheap window prefilter)
}

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Tolerantly parse JSONL text → array of objects (skips blank/garbled lines). */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* partial tail / corrupt line — tolerate */
    }
  }
  return out;
}

/** Canonical realpath of a record cwd, or null when absent/blank. Falls back to a resolved
 *  absolute path when the dir no longer exists (so scoping is still deterministic). */
function canonicalizeCwd(cwd: unknown): string | null {
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  try {
    return realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function tsToMs(ts: unknown): number | null {
  if (typeof ts !== "string" || !ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/** Convert raw JSONL records → typed events preserving canonical cwd. Pure (fs only via realpath
 *  of the record's own cwd). Records with no parseable timestamp are dropped. */
export function eventsFromRecords(records: unknown[], fallbackSessionId: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const tsMs = tsToMs(rec.timestamp);
    if (tsMs === null) continue;
    const sessionId =
      typeof rec.sessionId === "string" && rec.sessionId ? rec.sessionId : fallbackSessionId;
    const cwdRealpath = canonicalizeCwd(rec.cwd);
    const gitBranch = typeof rec.gitBranch === "string" ? rec.gitBranch : null;
    const base = { sessionId, tsMs, cwdRealpath, gitBranch };
    const type = rec.type;
    const msg =
      rec.message && typeof rec.message === "object"
        ? (rec.message as Record<string, unknown>)
        : undefined;

    if (type === "assistant" && msg?.role === "assistant") {
      const actor: Actor = rec.isSidechain === true ? "subagent" : "assistant";
      events.push({ ...base, actor, toolName: null });
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const b of content) {
        if (b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_use") {
          const name = (b as Record<string, unknown>).name;
          events.push({ ...base, actor, toolName: typeof name === "string" ? name : null });
        }
      }
      continue;
    }
    if (type === "user" && msg?.role === "user") {
      events.push({ ...base, actor: "user", toolName: null });
      continue;
    }
    if (type === "mode" || type === "permission-mode") {
      events.push({ ...base, actor: "user", toolName: null });
      continue;
    }
    // attachment / last-prompt / ai-title / file-history-snapshot / summary → noise
  }
  return events;
}

/** Walk every session log under `projectsDir` → flat typed events. Tolerant of unreadable dirs/files. */
export function readSessionEvents(opts: ReadOptions = {}): SessionEvent[] {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  if (!existsSync(projectsDir)) return [];
  let subdirs: string[];
  try {
    subdirs = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const events: SessionEvent[] = [];
  for (const sub of subdirs) {
    const dir = path.join(projectsDir, sub);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dir, f);
      try {
        if (opts.sinceMs !== undefined && statSync(file).mtimeMs < opts.sinceMs) continue;
        const text = readFileSync(file, "utf8");
        events.push(...eventsFromRecords(parseJsonl(text), f.replace(/\.jsonl$/, "")));
      } catch {
        continue;
      }
    }
  }
  return events;
}
