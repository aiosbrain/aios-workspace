// Post-turn guard sweep — shared governance for NATIVE runtimes whose file
// writes execute inside their own process (ACP in-process shell tools, Codex
// `apply_patch`/shell, OpenCode). Those writes can't be pre-gated by the host,
// so after each turn we re-run the SAME team-ops-guard.sh over the files the
// turn changed and report any violation. This is the weaker, post-hoc tier —
// the UI/docs disclose it honestly (see hello.safetyNote).

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const SWEEP_SKIP_DIRS = new Set([".git", "node_modules", ".sessions", "dist", ".aios"]);
// Mirror the extensions team-ops-guard.sh itself checks, so the sweep can't flag
// (or miss) anything the pre-write gate wouldn't.
const SWEEP_EXTS = new Set([".md", ".yaml", ".yml", ".json", ".sh", ".py", ".ts", ".js", ".mjs"]);
export const SWEEP_MAX_FILES = 5000; // backstop so a giant tree can't wedge a turn

// Yield absolute paths of guard-relevant files under `repo` modified at/after
// `sinceMs` (i.e. touched during the just-finished turn). If the visited-file
// budget is exhausted before the walk finishes, sets `budget.truncated` so the
// caller can FAIL LOUD rather than silently skip the unscanned tail.
async function* changedFiles(repo, sinceMs, budget) {
  let entries;
  try { entries = await readdir(repo, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (budget.n <= 0) { budget.truncated = true; return; }
    if (SWEEP_SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(repo, e.name);
    if (e.isDirectory()) {
      yield* changedFiles(abs, sinceMs, budget);
      if (budget.truncated) return;
    } else if (e.isFile() && SWEEP_EXTS.has(path.extname(e.name))) {
      budget.n--;
      let st;
      try { st = await stat(abs); } catch { continue; }
      if (st.mtimeMs >= sinceMs) yield abs;
    }
  }
}

// Re-run the SAME governance hook over files the turn changed. Returns
// { violations: [{path,reason}], truncated } — `truncated` is true if the walk
// hit the visited-file cap, meaning some changes went UNCHECKED (caller must
// surface this, not swallow it).
export async function postTurnSweep(repo, guardWrite, sinceMs, maxFiles = SWEEP_MAX_FILES) {
  const violations = [];
  const budget = { n: maxFiles, truncated: false };
  for await (const abs of changedFiles(repo, sinceMs, budget)) {
    let content;
    try { content = await readFile(abs, "utf8"); } catch { continue; }
    const verdict = guardWrite({ path: abs, content, operation: "Write" });
    if (!verdict.ok) violations.push({ path: path.relative(repo, abs), reason: verdict.reason });
  }
  return { violations, truncated: budget.truncated };
}
