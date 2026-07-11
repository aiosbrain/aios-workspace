/**
 * simplify.mjs — the post-review simplification pass (`aios simplify`, ship stage 7b).
 *
 * One cheap-model, behavior-preserving cleanup pass over the branch diff AFTER review
 * clears and BEFORE merge (the Boris Cherny code-simplifier ritual). The pass is
 * verify-gated with a snapshot revert: if the verify chain fails, or the agent's
 * output doesn't end in SIMPLIFY_DONE/SIMPLIFY_NOOP, every change is rolled back.
 * Advisory by design — a failed simplify NEVER blocks a ship; the branch just merges
 * un-simplified.
 *
 * Exported:
 *   buildSimplifyPrompt({ branch, baseSha, diffStat, diff, logOneline, constitution })
 *   detectSimplifyToken(text) → "done" | "noop" | null
 *   runSimplify({ worktree, baseSha, branch, model, effort, timeoutMs, verify, constitution, deps })
 *   cmdSimplify(repo, args)
 */

import { existsSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { c, die } from "./relay-core.mjs";
import { callAgentModel } from "./model-call.mjs";
import { parseModelRef } from "./model-providers.mjs";
import { resolveLoopModels } from "./loop-models.mjs";
import { captureBranchDiff } from "./review-bugbot.mjs";
import { constitutionPromptLines, loadConstitutionDigest } from "./constitution.mjs";
// Runtime-only access (inside cmdSimplify), so the ship↔simplify import cycle is safe.
import { SHIP_VERIFY_CMD } from "./ship.mjs";

export const SIMPLIFY_DONE_TOKEN = "SIMPLIFY_DONE";
export const SIMPLIFY_NOOP_TOKEN = "SIMPLIFY_NOOP";
const DEFAULT_TIMEOUT_MS = 600 * 1000;

function gitOut(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Last-non-blank-line token detection (same dialect as BUGBOT_CLEAR/MERGE_READY). */
export function detectSimplifyToken(text) {
  const lastLine =
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  if (new RegExp(`^${SIMPLIFY_DONE_TOKEN}\\b`).test(lastLine)) return "done";
  if (new RegExp(`^${SIMPLIFY_NOOP_TOKEN}\\b`).test(lastLine)) return "noop";
  return null;
}

export function buildSimplifyPrompt({ branch, baseSha, diffStat, diff, logOneline, constitution }) {
  return [
    `You are a code simplifier working in THIS git worktree (branch \`${branch}\`).`,
    `The diff below (base ${baseSha}..HEAD) has already PASSED code review and is about to`,
    "merge. Make ONE behavior-preserving cleanup pass over ONLY the changed hunks.",
    "",
    "## What to simplify (in the changed code only)",
    "- Delete dead code, unused parameters/imports, and duplication the diff introduced.",
    "- Collapse needless abstraction/indirection; inline single-use helpers (YAGNI).",
    "- Tighten names and drop comments that restate the code.",
    "- Prefer the surrounding file's existing idioms over new ones.",
    "",
    "## Hard rules",
    "- Behavior-preserving ONLY: no API, logic, test-semantics, or dependency changes.",
    "- Touch ONLY files already in the diff. Do NOT create new files.",
    "- NEVER weaken anything under validation/ or hooks/.",
    "- If a simplification is debatable, skip it — a no-op is a valid outcome.",
    ...constitutionPromptLines(constitution),
    "",
    "## Commits",
    "",
    logOneline || "(none)",
    "",
    "## git diff --stat",
    "",
    diffStat || "(empty)",
    "",
    "## git diff",
    "",
    diff,
    "",
    "---",
    `If you changed anything: commit it all as ONE commit ("refactor: simplify pass`,
    `(post-review)") and place ${SIMPLIFY_DONE_TOKEN} alone on the very last line.`,
    `If the diff is already minimal, change NOTHING and place ${SIMPLIFY_NOOP_TOKEN}`,
    "alone on the very last line.",
  ].join("\n");
}

/**
 * runSimplify — snapshot → agent pass → verify → keep-or-revert.
 * Never throws for pipeline reasons; returns { changed, ok, reverted, output }.
 *   changed  — simplification commits survived (verify green)
 *   ok       — the pass itself behaved (noop or verified change); false = reverted/anomaly
 * Deps are injectable for tests: { agentCall, git, execVerify }.
 */
export async function runSimplify({
  worktree,
  baseSha,
  branch,
  model,
  effort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  verify,
  constitution = null,
  deps = {},
}) {
  const agentCall = deps.agentCall ?? callAgentModel;
  const git = deps.git ?? ((args) => gitOut(args, worktree));
  const execVerify =
    deps.execVerify ??
    ((cmd) => execSync(cmd, { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] }));

  if (!worktree || !existsSync(worktree)) {
    return { changed: false, ok: true, reverted: false, output: "(worktree missing — skipped)" };
  }
  // Tracked-file dirtiness only (-uno): worktrees legitimately carry untracked hydrated
  // config (.opencode/, .mcp.json). Revert is `reset --hard` — NEVER `git clean`, which
  // would delete that config and any pre-existing untracked work.
  const trackedDirty = () => git(["status", "--porcelain", "-uno"]) !== "";
  if (trackedDirty()) {
    return {
      changed: false,
      ok: true,
      reverted: false,
      output: "(uncommitted tracked changes — commit or stash before simplify; skipped)",
    };
  }
  const { diffStat, logOneline, diff } = (deps.capture ?? captureBranchDiff)(worktree, baseSha);
  if (!diffStat && !logOneline) {
    return { changed: false, ok: true, reverted: false, output: "(no diff to simplify)" };
  }

  const snapshot = git(["rev-parse", "HEAD"]);
  const revert = () => git(["reset", "--hard", snapshot]);

  const prompt = buildSimplifyPrompt({ branch, baseSha, diffStat, diff, logOneline, constitution });
  // --effort is a Claude-CLI-only knob (mirrors build.mjs's builder invocation).
  const extraArgs =
    effort && parseModelRef(model).provider === "claude" ? ["--effort", effort] : [];
  let output;
  try {
    output = await agentCall({
      model,
      prompt,
      timeoutMs,
      opts: { cwd: worktree, ...(extraArgs.length ? { extraArgs } : {}) },
    });
  } catch (e) {
    revert();
    return {
      changed: false,
      ok: false,
      reverted: true,
      output: `(simplify agent failed: ${e.message})`,
    };
  }

  const token = detectSimplifyToken(output);
  const headMoved = git(["rev-parse", "HEAD"]) !== snapshot;
  const dirty = trackedDirty();

  if (token === "noop") {
    // The agent declared no-op; any drift it left anyway is an anomaly — roll it back.
    if (headMoved || dirty) {
      revert();
      return { changed: false, ok: false, reverted: true, output };
    }
    return { changed: false, ok: true, reverted: false, output };
  }
  if (token !== "done") {
    // No verdict token — fail closed on the cleanup (never on the ship).
    if (headMoved || dirty) revert();
    return { changed: false, ok: false, reverted: headMoved || dirty, output };
  }

  // SIMPLIFY_DONE: sweep up any uncommitted remainder (tracked files only — the prompt
  // forbids new files, and add -A would sweep hydrated config), then re-run verify.
  if (dirty) {
    git(["add", "-u"]);
    git(["commit", "-m", "refactor: simplify pass (post-review)"]);
  }
  if (git(["rev-parse", "HEAD"]) === snapshot) {
    return { changed: false, ok: true, reverted: false, output };
  }
  if (verify) {
    try {
      execVerify(verify);
    } catch (e) {
      revert();
      return {
        changed: false,
        ok: false,
        reverted: true,
        output: `${output}\n\n(verify failed after simplify — reverted: ${e.message})`,
      };
    }
  }
  return { changed: true, ok: true, reverted: false, output };
}

// ── standalone CLI: aios simplify [--range <base>..HEAD] [--model m] [--verify cmd] ─────────
export async function cmdSimplify(repo, args) {
  const KNOWN_FLAGS = new Set(["--range", "--model", "--verify"]);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "usage: aios simplify [--range <base>..HEAD] [--model m] [--verify cmd]\n" +
        "  post-review cleanup pass on the branch diff — verify-gated, reverts on failure."
    );
    return 0;
  }
  for (let i = 0; i < args.length; i++) {
    if (!KNOWN_FLAGS.has(args[i])) die(`unknown argument '${args[i]}' — see aios simplify --help`);
    i++; // skip the flag's value
  }
  const flag = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null;
  };
  const range = flag("--range") ?? "origin/main..HEAD";
  const m = /^(.+?)\.\.(HEAD)?$/.exec(range);
  if (!m) die(`--range must look like <base>..HEAD (got '${range}')`);
  let baseSha;
  try {
    baseSha = gitOut(["merge-base", m[1], "HEAD"], repo);
  } catch {
    die(`cannot resolve base '${m[1]}' in ${repo}`);
  }

  const modelOverride = flag("--model");
  const cliOverrides = modelOverride ? { simplify: { model: modelOverride } } : {};
  const cfg = resolveLoopModels({ repo, cliOverrides }).simplify;
  const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  const verify = flag("--verify") ?? SHIP_VERIFY_CMD;

  console.log(c.dim(`[simplify] ${branch} (${cfg.model}) base ${m[1]}`));
  const res = await runSimplify({
    worktree: repo,
    baseSha,
    branch,
    model: cfg.model,
    effort: cfg.effort,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    verify,
    constitution: loadConstitutionDigest(repo),
  });
  if (res.changed) console.log(c.green("simplified — cleanup commit added (verify green)"));
  else if (res.ok) console.log(c.dim("no-op — nothing worth simplifying"));
  else console.log(c.red(`simplify pass discarded${res.reverted ? " (reverted)" : ""}`));
  return res.ok ? 0 : 1;
}
