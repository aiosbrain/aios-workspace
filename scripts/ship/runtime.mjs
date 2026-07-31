/**
 * ship/runtime.mjs — the real dependency implementations for `aios ship`, the resumable
 * checkpoint state (`.aios/loop/<issue>/state.json` + `GATE-<name>.pending.md`), and post-merge
 * cleanup ordering.
 *
 * This module owns the invariant that resume state is a byte-for-byte contract: `SHIP_STATE_VERSION`
 * gates every read (a mismatched version is treated as absent, never partially trusted), and a
 * failed stage writes a loud `failedArtifact` into the audit trail rather than leaving a directory
 * that just stops (AIO-194). `runCleanup` owns the ordering invariant that a worktree/branch must be
 * removed before the primary checkout's best-effort ff-only, and that ff is skipped rather than
 * risking a clobber of in-flight operator work.
 *
 * Extracted verbatim from scripts/ship.mjs (AIO-560, wave 5 of the safety-unit-extraction pattern
 * — docs/v1-operator-loop/domains/safety-unit-extraction.md). No state shape, path, stage name, or
 * cleanup ordering step is edited in this move — resume compatibility depends on that.
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelRef } from "../model-providers.mjs";
import { loadToolkitModule } from "../toolkit-locate.mjs";
import { SHIP_EXIT } from "./gates.mjs";

// The repo verify chain runBuild runs in the worktree before each review round and pre-merge.
// Wired into every build/fix round so `aios ship` can never merge code that hasn't passed it.
// Defined in the core-staying scripts/verify-cmd.mjs (shared with `aios simplify`, which must not
// import from the devtools path set — AIO-594); re-exported here so ship.mjs's public surface is
// unchanged.
import { SHIP_VERIFY_CMD } from "../verify-cmd.mjs";
export { SHIP_VERIFY_CMD };
// Default plan-stage timeout. An Opus-xhigh planner with tool access empirically needs
// 15-40 minutes (every AIO-156 epic plan round exceeded 10); the original 600s default
// killed the first real-world run mid-work (AIO-194). Override per-run with
// `plan_timeout_s` in .aios/loop-models.yaml.
export const DEFAULT_PLAN_TIMEOUT_MS = 1800 * 1000;
// A stage runner that dies (timeout or nonzero exit) must fail LOUDLY into the audit
// trail — an aborted run whose directory just stops is indistinguishable from one that
// never ran (AIO-194: the first real `aios ship` died at the plan stage leaving nothing).
export function failedArtifact(stage, error, startedAt) {
  const elapsed = startedAt ? `${Math.round((Date.now() - startedAt) / 1000)}s elapsed` : "";
  return [
    `# ${stage} FAILED`,
    "",
    `- error: ${error?.message ?? error}`,
    ...(elapsed ? [`- ${elapsed}`] : []),
    `- at: ${new Date().toISOString()}`,
    "",
    "The run aborted at this stage. See the SHIP_EXIT table in scripts/ship.mjs for the",
    "exit code, and .aios/loop-models.yaml (`<step>_timeout_s`) to raise a step timeout.",
  ].join("\n");
}
// ── checkpoint state + async gates (AIO-239) ────────────────────────────────────────────────
// Ship persists per-stage progress to `.aios/loop/<issue>/state.json` so an aborted or
// gate-blocked run is RESUMABLE (`--resume`): completed stages are skipped, the run re-enters at
// the first incomplete one. A blocked gate writes `GATE-<name>.pending.md` with the material to
// judge and exits with the gate code; `--resume --approve-plan` / `--approve-merge` satisfy it.

export const SHIP_STATE_VERSION = 1;
export function defaultReadState(repo, issue) {
  try {
    const raw = readFileSync(path.join(repo, ".aios", "loop", issue, "state.json"), "utf8");
    const st = JSON.parse(raw);
    return st && st.v === SHIP_STATE_VERSION ? st : null;
  } catch {
    return null;
  }
}
export function defaultWriteState(repo, issue, state) {
  try {
    const dir = path.join(repo, ".aios", "loop", issue);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify(
        { ...state, v: SHIP_STATE_VERSION, updatedAt: new Date().toISOString() },
        null,
        2
      ) + "\n"
    );
  } catch {
    /* best-effort — state loss degrades to a fresh run, never a crash */
  }
}
export function defaultWriteGate(repo, issue, name, text) {
  try {
    const dir = path.join(repo, ".aios", "loop", issue);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `GATE-${name}.pending.md`), text); // overwrite, not append
  } catch {
    /* best-effort */
  }
}
export function defaultRemoveGate(repo, issue, name) {
  try {
    unlinkSync(path.join(repo, ".aios", "loop", issue, `GATE-${name}.pending.md`));
  } catch {
    /* absent is fine */
  }
}
/** Expand a leading `~/` against the home directory. `path.join` (NOT `path.resolve`) keeps the
 *  home prefix even though the slice leaves a leading slash — pinned by a unit test because a
 *  review claimed otherwise (AIO-239 r1: declined-with-evidence). */
export function expandHomePath(p, home = homedir()) {
  return p.startsWith("~/") || p === "~" ? path.join(home, p.slice(1)) : p;
}
/** Find a `~/.claude/plans/<name>.md` (or absolute) path in planner stdout — the CLI plan runner
 *  writes the FULL plan there and only summarizes on stdout. Capturing the full text into the
 *  pipeline kills a pointer-chasing indirection for the builder and reviewers (AIO-239 R5b). */
export function findPlanFilePath(text) {
  const m = (text ?? "").match(/(?:~|\/[^\s"'`)\]]*)\/\.claude\/plans\/[^\s"'`)\]]+\.md/);
  return m ? m[0] : null;
}
// ── default dep impls (real side effects) ────────────────────────────────────────────────────

export function defaultGitLsFiles(repo) {
  try {
    const out = execFileSync("git", ["ls-files"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Set(
      out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}
// gitExec: returns stdout (trimmed); throws on non-zero exit. Used for status/merge/worktree.
export function defaultGitExec(argv, cwd) {
  return execFileSync("git", argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
// ghExec: returns { code, stdout, stderr } and NEVER throws on non-zero (mirrors readChecks'
// contract — a red/pending `gh pr checks` is data, not a crash).
export function defaultGhExec(argv) {
  try {
    const stdout = execFileSync("gh", argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}
// SDK plan-runner deps (--plan-runner sdk). Lazily imported so the default `cli` path never pays
// for (or requires) the Anthropic SDK — only an actual sdk run constructs the client. `callOpus`
// is the same Opus↔SDK planner `aios relay` uses; `makeAnthropic` needs a funded ANTHROPIC_API_KEY.
export async function defaultMakeAnthropic() {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic();
}
export async function defaultCallOpus(anthropic, messages, planCfg) {
  // Stays-core relay.mjs loads via the toolkit seam, not a sibling-relative import, so this
  // path also works standalone in aios-devtools (AIO-594 F3).
  const { callOpus } = await loadToolkitModule("relay.mjs");
  return callOpus(anthropic, messages, planCfg);
}
export function defaultWriteAudit(repo, issue, name, text) {
  try {
    const dir = path.join(repo, ".aios", "loop", issue);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, name), `${text}\n`);
  } catch {
    /* best-effort — audit never blocks a run */
  }
}
export function defaultConfirm(promptText) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${promptText} [y/N] `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}
// wait-for-bots exit codes are the interface (see runShip's Bugbot gate): 0 = Bugbot posted,
// 2 = timeout. A real SPAWN failure (script missing, ENOENT, killed by signal) has NO numeric
// exit status — it must NOT be reported as `2` (which runShip treats as a benign timeout and
// proceeds). Return `1` (gate could not run) so the caller fails closed and blocks merge.
// fileURLToPath (not new URL(...).pathname) is used so the path is correct on every platform and
// with spaces/encoded chars in the repo path.
export function defaultWaitForBots(argv) {
  // This module lives one directory deeper than the original scripts/ship.mjs (scripts/ship/ vs
  // scripts/), so the walk up needs the extra ".." to resolve to the same scripts/wait-for-bots.mjs
  // — the resolved absolute path is unchanged, only the relative hop count reflects the move.
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "wait-for-bots.mjs");
  try {
    execFileSync(process.execPath, [script, ...argv], { stdio: "inherit" });
    return 0;
  } catch (e) {
    // Only a genuine non-zero child exit carries a numeric `status`. Anything else is a spawn
    // failure → surface as `1` (could-not-run), never as the `2` timeout code.
    return typeof e.status === "number" ? e.status : 1;
  }
}
// Parse `git worktree list --porcelain` for the path of the worktree checked out on `branch`.
// The porcelain format is stanza-per-worktree: a `worktree <path>` line followed by (among
// others) a `branch refs/heads/<branch>` line, stanzas separated by blank lines. Returns the
// matching path, or null when no worktree holds that branch. Pure; exported for the test.
export function resolveWorktreePathFromList(porcelain, branch) {
  const target = `refs/heads/${branch}`;
  let currentPath = null;
  for (const line of String(porcelain ?? "").split("\n")) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ")) {
      if (line.slice("branch ".length).trim() === target) return currentPath;
    }
  }
  return null;
}
// ── cleanup (exported for the ordering test) ──────────────────────────────────────────────────
// Correct ordering: git refuses to delete a branch checked out in a worktree, so worktree remove
// → prune → branch delete, THEN the primary ff-only.
// Cleanup is BEST-EFFORT since AIO-239: the merge already happened, so nothing here may fail the
// run. Worktree/branch removal always proceeds; the ff-only of the primary checkout is attempted
// only when it cannot clobber operator state (someone else's working files must never turn a
// successful ship into CLEANUP_FAILED — the operator can ff later). Always returns SHIP_EXIT.OK
// with `reason` describing what was done and `ffSkipped`/`ffDone` for callers/tests.
// AIO-186 grafts (kept under the best-effort stance):
//   F3 — remove the worktree at the path git ACTUALLY registered for the branch (a resumed build
//        may sit at a non-default path; runBuild returns only an exit code), falling back to the
//        caller-passed path.
//   F1 — land the ff-only on `main` itself (checkout main first): the operator may have started
//        `aios ship` from another branch, and ff-ing a non-main HEAD advances the wrong branch.
//        A failed checkout records ffSkipped — never CLEANUP_FAILED, never a clobber.
export function runCleanup(deps, { repo, branch, worktreePath }) {
  const { gitExec } = deps;
  const notes = [];

  // F3: resolve the ACTUAL worktree registered for this branch; fall back to the passed path
  // when git reports none (already-pruned → the remove below is a harmless no-op).
  let removePath = worktreePath;
  try {
    const listed = resolveWorktreePathFromList(
      gitExec(["worktree", "list", "--porcelain"], repo),
      branch
    );
    if (listed) removePath = listed;
  } catch {
    /* best-effort — fall back to the passed worktreePath */
  }

  // Remove the worktree BEFORE deleting the branch (git blocks deleting a checked-out branch).
  try {
    gitExec(["worktree", "remove", "--force", removePath], repo);
  } catch {
    notes.push("worktree remove skipped");
  }
  try {
    gitExec(["worktree", "prune"], repo);
  } catch {
    /* best-effort */
  }
  try {
    gitExec(["branch", "-D", branch], repo);
  } catch {
    notes.push("local branch delete skipped (remote deleted at merge)");
  }

  // ff-only the primary checkout — convenience, not a requirement.
  let ffDone = false;
  let ffSkipped = null;
  let status = "";
  try {
    status = gitExec(["status", "--porcelain"], repo) ?? "";
  } catch (e) {
    ffSkipped = `could not read primary status (${e.message})`;
  }
  if (ffSkipped == null && status.trim()) {
    // Dirty primary: git's own checkout safety would refuse an ff that touches modified files,
    // but we skip proactively — never risk another agent's / the operator's in-flight work.
    ffSkipped =
      "primary checkout has local changes — run `git merge --ff-only origin/main` when ready";
  }
  if (ffSkipped == null) {
    // F1: land the ff on `main` itself — the operator may have started from another branch.
    try {
      gitExec(["checkout", "main"], repo);
    } catch (e) {
      ffSkipped = `could not checkout main (${e.message}) — run the ff from main when ready`;
    }
  }
  if (ffSkipped == null) {
    try {
      gitExec(["fetch", "origin", "main"], repo);
      gitExec(["merge", "--ff-only", "origin/main"], repo);
      ffDone = true;
    } catch (e) {
      ffSkipped = `ff-only not possible (${e.message}) — resolve manually`;
    }
  }
  if (ffSkipped) notes.push(`ff skipped: ${ffSkipped}`);

  return {
    code: SHIP_EXIT.OK,
    ffDone,
    ffSkipped,
    reason: notes.length ? notes.join("; ") : "cleaned up (worktree, branch, ff)",
  };
}
// ── build opts ─────────────────────────────────────────────────────────────────────────────
export function makeBuildOpts({
  branch,
  issue,
  logFile,
  findingsFile,
  verify = SHIP_VERIFY_CMD,
  constitution = null,
  profile = null,
  builderContext = null,
}) {
  return {
    planSource: null,
    constitution,
    profile,
    builderContext,
    builderSkills: builderContext?.skills?.map((skill) => skill.id) ?? [],
    branch,
    isTask: false,
    rounds: 4,
    buildTimeout: 1800 * 1000,
    cursorTimeout: 300 * 1000,
    cursorTimeoutSet: false,
    model: null,
    skill: "/ai-code-review",
    worktreePath: null,
    base: "origin/main",
    verify,
    findingsFile: findingsFile ?? null,
    logFile: logFile ?? null,
    merge: false,
    pr: false,
    issue,
    bugbot: false,
    noBugbot: true,
    noGate: false,
    keepWorktree: true,
    dryRun: false,
    chained: true,
  };
}
export const lastNonBlankLine = (text) =>
  (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? "";
export function cursorCliModelArg(model) {
  const ref = parseModelRef(model);
  return ref.provider === "cursor" && ref.modelId ? ref.modelId : model;
}
