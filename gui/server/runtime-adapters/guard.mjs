// Host-side write guard (BYOA Phase 3).
//
// The single governance source is hooks/team-ops-guard.sh (the same PreToolUse
// hook Claude Code runs). For runtimes whose file writes are HOST-mediated
// (e.g. ACP fs/write_text_file), the adapter calls guardWrite() BEFORE writing,
// so secrets / admin-tier leakage / missing-frontmatter are blocked uniformly —
// not just for Claude Code. Native runtimes that write inside their own process
// can't be pre-gated; those use a post-turn sweep (see codex/opencode adapters).
//
// Path is resolved strictly inside `repo` (defeats ../ and symlink escapes)
// before the guard runs.

import { execFileSync } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The toolkit's own guard — always present relative to this module. Used as a
// fallback so scaffolded workspaces (which don't ship hooks/ yet) are still
// governed rather than silently allowing every write.
const TOOLKIT_GUARD = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "team-ops-guard.sh",
);

// Resolve `target` to an absolute path proven to live inside `repo`, realpath-ing
// the deepest existing ancestor so a not-yet-created file can't escape via a
// symlinked parent. Returns null if it escapes.
function resolveInRepo(repo, target) {
  let repoReal;
  try { repoReal = realpathSync(repo); } catch { return null; }
  const abs = path.resolve(repo, target);
  let probe = abs;
  const tail = [];
  while (!existsSync(probe) && path.dirname(probe) !== probe) {
    tail.unshift(path.basename(probe));
    probe = path.dirname(probe);
  }
  let baseReal;
  try { baseReal = realpathSync(probe); } catch { return null; }
  const real = tail.length ? path.join(baseReal, ...tail) : baseReal;
  if (real !== repoReal && !real.startsWith(repoReal + path.sep)) return null;
  return real;
}

/**
 * Vet a host-mediated file write through team-ops-guard.sh.
 * @returns {{ok:boolean, reason?:string}}
 */
export function guardWrite({ repo, path: target, content = "", operation = "Write" }) {
  const real = resolveInRepo(repo, target);
  if (!real) return { ok: false, reason: `path escapes the workspace: ${target}` };

  // Prefer the workspace's own guard (workspace-specific rules); otherwise fall
  // back to the toolkit guard so we never silently allow ungoverned writes.
  const workspaceGuard = path.join(repo, "hooks", "team-ops-guard.sh");
  const guard = existsSync(workspaceGuard) ? workspaceGuard
    : existsSync(TOOLKIT_GUARD) ? TOOLKIT_GUARD
    : null;
  // `real` is the resolved, in-repo, symlink-safe absolute path. Callers MUST
  // write to THIS path, never the raw input (which may be relative and resolve
  // against the wrong cwd) — that's the only path we actually vetted.
  if (!guard) return { ok: true, path: real }; // no guard available anywhere — allow

  const isEdit = operation === "Edit";
  const toolInput = isEdit ? { file_path: real, new_string: content } : { file_path: real, content };
  try {
    execFileSync("bash", [guard], {
      cwd: repo,
      env: { ...process.env, CC_TOOL_NAME: isEdit ? "Edit" : "Write", CC_TOOL_INPUT: JSON.stringify(toolInput) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, path: real };
  } catch (e) {
    const reason = String(e.stderr || e.stdout || e.message).trim();
    return { ok: false, reason: reason || "blocked by team-ops-guard" };
  }
}
