/**
 * task-tier.mjs — AIO-364: the three-home task split + loop-critical tier-block warning.
 *
 * Extracted from scripts/aios.mjs (AIO-320/AIO-315 file-size decomposition — aios.mjs has
 * a hard line cap enforced by scripts/check-file-size.mjs).
 *
 * A workspace's tasks now live in up to three tier-explicit homes instead of one ambiguous
 * `3-log/tasks.md`:
 *   - 3-log/tasks-team.md     access: team     — syncs to the Team Brain / PM projection
 *   - 3-log/tasks-private.md  access: private   — never syncs
 *   - 5-personal/tasks.md     no access tag     — outside sync_include entirely
 * plus the legacy single-file spine (3-log/tasks.md, 03-status/tasks.md) for workspaces that
 * haven't migrated yet. `aios work done <key>` must search ALL of them for the row, rather
 * than assuming one fixed path — that assumption is exactly how a key living in
 * tasks-private.md (or an unmigrated tasks.md later split) went silently unresolvable.
 *
 * The second half of this module is the "loop-critical tier-block" warning: if a file that
 * backs the brain→PM task/decision projection is BOTH whitelisted in aios.yaml's
 * sync_include AND tier-blocked, that's not an ordinary blocked file — the loop is silently
 * disabled. This is the exact shape the real dogfood bug took (3-log/tasks.md tagged
 * `access: private` while still listed in sync_include, buried as one line among 186 blocked
 * files in `aios status`).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { c, die } from "./cli-common.mjs";
import { parseFrontmatter } from "./workspace-parse.mjs";

// Order matters only as a tie-break when a key somehow exists in more than one file —
// first match wins.
export const TASK_FILE_CANDIDATES = [
  ["3-log", "tasks-team.md"],
  ["3-log", "tasks-private.md"],
  ["5-personal", "tasks.md"],
  ["3-log", "tasks.md"], // legacy: unmigrated workspaces
  ["03-status", "tasks.md"], // legacy: pre-spine workspaces
];

export function taskFileCandidates(repo) {
  return TASK_FILE_CANDIDATES.map(([dir, file]) => ({
    abs: path.join(repo, dir, file),
    rel: `${dir}/${file}`,
  })).filter((f) => existsSync(f.abs));
}

function rowCells(line) {
  return line
    .split("|")
    .slice(1, -1)
    .map((x) => x.trim());
}

function renderRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

// Search every existing tasks-file home for a row whose `ID` column equals `key`. Returns
// null (not a die()) so callers can report "not found across N files searched" precisely.
export function findTaskRow(repo, key) {
  for (const file of taskFileCandidates(repo)) {
    const lines = readFileSync(file.abs, "utf8").split("\n");
    const headerIdx = lines.findIndex((line) => {
      const cells = rowCells(line).map((h) => h.toLowerCase());
      return cells.includes("id") && cells.includes("task");
    });
    if (headerIdx === -1) continue;
    const header = rowCells(lines[headerIdx]).map((h) => h.toLowerCase());
    const idIdx = header.indexOf("id");
    const statusIdx = header.indexOf("status");
    if (idIdx === -1 || statusIdx === -1) continue;

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed.startsWith("|")) continue;
      const cells = rowCells(lines[i]);
      if (cells.every((x) => /^[-: ]*$/.test(x))) continue;
      if (cells[idIdx] !== key) continue;
      return { file, lines, headerIdx, header, idIdx, statusIdx, rowIdx: i };
    }
  }
  return null;
}

/** Set `key`'s Status cell to `status` in whichever tasks-file home actually contains it. */
export function setTaskStatus(repo, key, status) {
  const candidates = taskFileCandidates(repo);
  if (!candidates.length)
    die(
      "no tasks file found — expected one of: " +
        TASK_FILE_CANDIDATES.map(([d, f]) => `${d}/${f}`).join(", ")
    );

  const hit = findTaskRow(repo, key);
  if (!hit)
    die(
      `task key '${key}' not found in any tasks file (searched ${candidates.map((f) => f.rel).join(", ")})`
    );

  const { file, lines, header, statusIdx, rowIdx } = hit;
  const cells = rowCells(lines[rowIdx]);
  while (cells.length < header.length) cells.push("");
  cells[statusIdx] = status;
  lines[rowIdx] = renderRow(cells);
  writeFileSync(file.abs, lines.join("\n"));
  return file;
}

// ── loop-critical tier-block warning ────────────────────────────────────────

export const LOOP_CRITICAL_BASENAMES = new Set(["tasks-team.md", "tasks.md", "decision-log.md"]);

export function isSyncIncluded(rel, cfg) {
  return (cfg.sync_include || []).some(
    (inc) => rel === inc || rel.startsWith(inc.replace(/\/$/, "") + "/")
  );
}

// Which of `plan.blocked` are loop-critical AND sync_include-whitelisted? Re-reads each
// candidate's frontmatter so the message can name the actual `access:` tag rather than the
// engine-normalized reason string (e.g. "access: private", not "access: admin").
export function loopCriticalBlocks(repo, plan, cfg) {
  const hits = [];
  for (const b of plan.blocked) {
    if (!LOOP_CRITICAL_BASENAMES.has(path.basename(b.rel))) continue;
    if (!isSyncIncluded(b.rel, cfg)) continue;
    let tierNote = b.reason;
    try {
      const { frontmatter } = parseFrontmatter(readFileSync(path.join(repo, b.rel), "utf8"));
      if (frontmatter?.access) tierNote = `access: ${frontmatter.access}`;
    } catch {
      // fall back to the plan's reason string
    }
    hits.push({ rel: b.rel, tierNote });
  }
  return hits;
}

// Print the headline warning(s) ABOVE the normal new/modified/blocked sections. Returns
// the hits so callers can also fold them into --json output if they want.
export function printLoopCriticalWarnings(repo, plan, cfg) {
  const hits = loopCriticalBlocks(repo, plan, cfg);
  for (const h of hits) {
    console.log(
      c.red(
        `⚠ ${h.rel} is whitelisted for sync but tier-blocked (${h.tierNote}) — PM projection is disabled for this file.`
      )
    );
  }
  if (hits.length) console.log("");
  return hits;
}
