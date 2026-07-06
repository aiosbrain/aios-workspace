#!/usr/bin/env node
// test/build-loop.test.mjs — end-to-end build loop with FAKE agents on PATH.
// No real Cursor/Claude/network. Run: node test/build-loop.test.mjs
//
// A stub `claude` (the builder, test/fixtures/fake-claude) makes real commits in
// the worktree; a stub `cursor` (the reviewer, test/fixtures/fake-cursor) emits
// MERGE_READY (or not). Both branch on FAKE_AGENT_SCRIPT. We assert the exit-code
// contract, worktree isolation + tripwire, the fail-closed secrets gate (incl.
// missing scanners), and merge/worktree cleanup.

import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  cpSync,
  writeFileSync,
  rmSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBuild, slugify, EXIT } from "../scripts/build.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const FAKE_CURSOR = path.join(DIR, "fixtures", "fake-cursor");
const FAKE_CLAUDE = path.join(DIR, "fixtures", "fake-claude");

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

// Put the fake builder (claude) and reviewer (cursor) on PATH for the whole run.
chmodSync(path.join(FAKE_CURSOR, "cursor"), 0o755);
chmodSync(path.join(FAKE_CLAUDE, "claude"), 0o755);
process.env.PATH = [FAKE_CLAUDE, FAKE_CURSOR, process.env.PATH].join(path.delimiter);

const cleanups = [];
function freshRepo({ withGate = true } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-build-"));
  cleanups.push(repo);
  const g = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  g(["init", "-b", "main"]);
  g(["config", "user.email", "test@example.com"]);
  g(["config", "user.name", "Test"]);
  if (withGate) {
    // give the build phase the real secrets gate to run
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    cpSync(path.join(REPO, "scripts", "leak-gate.sh"), path.join(repo, "scripts", "leak-gate.sh"));
    cpSync(path.join(REPO, "validation"), path.join(repo, "validation"), { recursive: true });
  }
  writeFileSync(path.join(repo, "README.md"), "# base\n");
  // Pin code_review to a Cursor-family model so this suite keeps hitting the PATH-shimmed
  // fake cursor binary regardless of what the real DEFAULT_MODELS.code_review becomes —
  // this file has no fake for the DeepSeek-direct dispatch path (that's a real fetch call).
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  writeFileSync(
    path.join(repo, ".aios", "loop-models.yaml"),
    "code_review_model: cursor:gpt-5.5-high\n"
  );
  g(["add", "-A"]);
  g(["commit", "-m", "base"]);
  return repo;
}
function wtPath(repo, branch) {
  const p = path.resolve(repo, "..", `${path.basename(repo)}-${slugify(branch)}`);
  cleanups.push(p);
  return p;
}
function opts(over) {
  return {
    rounds: 2,
    buildTimeout: 60000,
    cursorTimeout: 60000,
    skill: "/ai-code-review",
    base: "main",
    verify: null,
    worktreePath: null,
    logFile: null,
    merge: false,
    noGate: false,
    bugbot: false,
    noBugbot: true,
    keepWorktree: false,
    dryRun: false,
    chained: false,
    ...over,
  };
}

// Silence the loop's streaming output so only check lines show.
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
const origLog = console.log;
const origError = console.error;
async function run({ repo, branch, mode, o }) {
  process.env.FAKE_AGENT_SCRIPT = mode;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  console.log = () => {};
  console.error = () => {};
  try {
    return await runBuild({ repo, plan: "Add a feature module.", branch, opts: o });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    console.error = origError;
  }
}
const clean = (repo) =>
  execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();

console.log("approve, no --merge → reviewed branch, exit 0, not merged");
{
  const repo = freshRepo();
  const wt = wtPath(repo, "feat/t1");
  const code = await run({ repo, branch: "feat/t1", mode: "approve", o: opts() });
  check("exit OK", code === EXIT.OK);
  check("worktree has the built file", existsSync(path.join(wt, "feature.js")));
  check("primary main NOT merged", !existsSync(path.join(repo, "feature.js")));
  check("primary checkout clean (isolation)", clean(repo) === "");
}

console.log("approve + --merge → merged to main, worktree removed, exit 0");
{
  const repo = freshRepo();
  const wt = wtPath(repo, "feat/t2");
  const code = await run({ repo, branch: "feat/t2", mode: "approve", o: opts({ merge: true }) });
  check("exit OK", code === EXIT.OK);
  check("main has the built file", existsSync(path.join(repo, "feature.js")));
  check("worktree removed", !existsSync(wt));
  check("primary checkout clean", clean(repo) === "");
}

console.log("reviewer never approves → exit 2, branch preserved");
{
  const repo = freshRepo();
  const wt = wtPath(repo, "feat/t3");
  const code = await run({ repo, branch: "feat/t3", mode: "reject", o: opts({ rounds: 2 }) });
  check("exit NONCONVERGENCE", code === EXIT.NONCONVERGENCE);
  check("worktree preserved", existsSync(wt));
  check("not merged to main", !existsSync(path.join(repo, "feature.js")));
}

console.log("builder produces nothing → exit 3");
{
  const repo = freshRepo();
  const code = await run({ repo, branch: "feat/t4", mode: "empty", o: opts() });
  check("exit NO_DIFF", code === EXIT.NO_DIFF);
}

// AIO-239: the tripwire is NON-FATAL — aborting cannot undo primary-checkout damage, it only
// discards finished work, and main advancing under parallel agents must never kill a build.
// A working-tree escape WARNS (and the run continues to its natural outcome — here NO_DIFF,
// since the misbehaving builder made no worktree commits); a HEAD-only move is a benign note.
console.log("builder touches the PRIMARY checkout → tripwire WARNS, build continues");
{
  const repo = freshRepo();
  const code = await run({ repo, branch: "feat/t4b", mode: "touch-primary", o: opts() });
  check("run continues to its natural exit (NO_DIFF, not FATAL)", code === EXIT.NO_DIFF);
  check(
    "the escape was detected (file landed in primary)",
    existsSync(path.join(repo, "TRIPWIRE_TEST.txt"))
  );
  rmSync(path.join(repo, "TRIPWIRE_TEST.txt"), { force: true });
}

console.log("builder commits on PRIMARY checkout (HEAD moved) → note only, build continues");
{
  const repo = freshRepo();
  const code = await run({ repo, branch: "feat/t4d", mode: "touch-primary-head", o: opts() });
  check("run continues to its natural exit (NO_DIFF, not FATAL)", code === EXIT.NO_DIFF);
}

console.log("Bugbot blocks merge on Critical/High → exit 4");
{
  const repo = freshRepo();
  const wt = wtPath(repo, "feat/t4e");
  const code = await run({
    repo,
    branch: "feat/t4e",
    mode: "bugbot-block",
    o: opts({ merge: true, bugbot: true, noBugbot: false }),
  });
  check("exit GATE_FAILED (Bugbot)", code === EXIT.GATE_FAILED);
  check("not merged to main", !existsSync(path.join(repo, "feature.js")));
  check("worktree preserved", existsSync(wt));
}

console.log("--pr path runs the Bugbot gate too: Critical/High blocks before any push → exit 4");
{
  // H1 regression: --pr is a ship action, so the Bugbot gate must run on it (it used to be
  // gated on --merge only). bugbot-block → the gate fails inside finish() BEFORE cmdPr's
  // push/create, so no gh/git PR calls are needed. Branch carries AIO-<n> for --pr's issue.
  const repo = freshRepo();
  const wt = wtPath(repo, "feat/AIO-1-prbug");
  const code = await run({
    repo,
    branch: "feat/AIO-1-prbug",
    mode: "bugbot-block",
    o: opts({ pr: true, bugbot: true, noBugbot: false }),
  });
  check("exit GATE_FAILED (Bugbot on --pr)", code === EXIT.GATE_FAILED);
  check("worktree preserved (never merged/pushed)", existsSync(wt));
  check("not merged to main", !existsSync(path.join(repo, "feature.js")));
}

console.log("--pr path: undeterminable PR number → finish() returns GATE_FAILED (M3)");
{
  // M3: a cmdPr failure on the build path must surface as EXIT.GATE_FAILED via finish()
  // (throwOnError), NOT abort the build with cmdPr's own process.exit, and never report an
  // exit-0 "success" with no PR number. Fake gh: idempotency query finds no PR, create
  // succeeds but prints no /pull/<n> URL, and the re-query fails → number is undeterminable.
  // A delegating fake git handles only `push` (records + succeeds) and passes every other
  // git call through to the real git so the build/worktree phase still works.
  const savedPath = process.env.PATH;
  const realGit = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];

  // Set up the test repo + origin (detectRepo needs it) with the REAL git first.
  const repo = freshRepo();
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/repo.git"], {
    cwd: repo,
    stdio: "pipe",
  });
  const wt = wtPath(repo, "feat/AIO-3-prnum");

  const shimBin = mkdtempSync(path.join(tmpdir(), "pr-shim-"));
  cleanups.push(shimBin);
  const record = path.join(shimBin, "record.log");
  const countFile = path.join(shimBin, "count");
  writeFileSync(record, "");
  writeFileSync(countFile, "0");
  writeFileSync(
    path.join(shimBin, "git"),
    [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "const a = process.argv.slice(2);",
      "if (a[0] === 'push') {",
      "  appendFileSync(process.env.PR_SHIM_RECORD, 'git ' + a.join(' ') + '\\n');",
      "  process.exit(0);",
      "}",
      "const r = spawnSync(process.env.PR_SHIM_REAL_GIT, a, { stdio: 'inherit' });",
      "process.exit(r.status == null ? 1 : r.status);",
    ].join("\n")
  );
  writeFileSync(
    path.join(shimBin, "gh"),
    [
      "#!/usr/bin/env node",
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
      "const a = process.argv.slice(2);",
      "appendFileSync(process.env.PR_SHIM_RECORD, 'gh ' + a.join(' ') + '\\n');",
      "if (a[0] === 'pr' && a[1] === 'list') {",
      "  let n = 0; try { n = parseInt(readFileSync(process.env.PR_SHIM_COUNT, 'utf8'), 10) || 0; } catch {}",
      "  n++; writeFileSync(process.env.PR_SHIM_COUNT, String(n));",
      "  if (n >= 2) { process.stderr.write('gh: re-query failed\\n'); process.exit(1); }",
      "  process.stdout.write(''); process.exit(0);", // first query: no existing PR
      "}",
      "if (a[0] === 'pr' && a[1] === 'create') { process.stdout.write('opened (no url)\\n'); process.exit(0); }",
      "process.exit(0);",
    ].join("\n")
  );
  chmodSync(path.join(shimBin, "git"), 0o755);
  chmodSync(path.join(shimBin, "gh"), 0o755);
  process.env.PR_SHIM_RECORD = record;
  process.env.PR_SHIM_COUNT = countFile;
  process.env.PR_SHIM_REAL_GIT = realGit;
  process.env.PATH = [shimBin, savedPath].join(path.delimiter);

  let code;
  try {
    code = await run({ repo, branch: "feat/AIO-3-prnum", mode: "approve", o: opts({ pr: true }) });
  } finally {
    process.env.PATH = savedPath;
    delete process.env.PR_SHIM_RECORD;
    delete process.env.PR_SHIM_COUNT;
    delete process.env.PR_SHIM_REAL_GIT;
  }

  const calls = existsSync(record) ? readFileSync(record, "utf8") : "";
  check("exit GATE_FAILED (undeterminable PR number on --pr)", code === EXIT.GATE_FAILED);
  check("did push the branch (idempotent)", calls.includes("git push"));
  check("did attempt gh pr create", calls.includes("gh pr create"));
  check("worktree preserved (never merged)", existsSync(wt));
  check("not merged to main", !existsSync(path.join(repo, "feature.js")));
}

console.log("approve + --merge + bugbot → merged after BUGBOT_CLEAR, exit 0");
{
  const repo = freshRepo();
  const wt = wtPath(repo, "feat/t4f");
  const code = await run({
    repo,
    branch: "feat/t4f",
    mode: "approve",
    o: opts({ merge: true, bugbot: true, noBugbot: false }),
  });
  check("exit OK", code === EXIT.OK);
  check("main has the built file", existsSync(path.join(repo, "feature.js")));
  check("worktree removed", !existsSync(wt));
}

console.log("missing gate scripts → fail closed (exit 4), never a silent pass");
{
  const repo = freshRepo({ withGate: false });
  const code = await run({ repo, branch: "feat/t4c", mode: "approve", o: opts({ rounds: 1 }) });
  check("exit GATE_FAILED (fail-closed on missing scanners)", code === EXIT.GATE_FAILED);
}

console.log("secrets introduced → gate blocks merge, exit 4, not merged");
{
  const repo = freshRepo();
  const code = await run({
    repo,
    branch: "feat/t5",
    mode: "leak",
    o: opts({ rounds: 2, merge: true }),
  });
  check("exit GATE_FAILED", code === EXIT.GATE_FAILED);
  check("leak NOT merged to main", !existsSync(path.join(repo, "feature.js")));
  check("primary checkout clean", clean(repo) === "");
}

console.log("reject-then-approve → converges round 2, merges, logs both rounds");
{
  const repo = freshRepo();
  const stateFile = mkdtempSync(path.join(tmpdir(), "fc-state-"));
  cleanups.push(stateFile);
  process.env.FAKE_REVIEW_STATE = path.join(stateFile, "n");
  const logFile = path.join(repo, "build.log.md");
  const code = await run({
    repo,
    branch: "feat/t6",
    mode: "reject-then-approve",
    o: opts({ rounds: 3, merge: true, logFile }),
  });
  delete process.env.FAKE_REVIEW_STATE;
  check("exit OK", code === EXIT.OK);
  check("merged to main", existsSync(path.join(repo, "feature.js")));
  const logTxt = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  check(
    "log records 2 build rounds",
    logTxt.includes("Build round 1") && logTxt.includes("Build round 2")
  );
}

console.log("--findings + gate failure keeps the outstanding findings in the next prompt (M1)");
{
  // Seed an actionable [High] via --findings, then make the secrets gate fail EVERY round
  // (leak mode). Round 1's builder prompt carries the seeded findings; round 1 trips the gate;
  // round 2's builder prompt MUST carry BOTH the gate output AND the still-outstanding findings
  // (the pre-fix bug dropped the findings, leaving only the gate text).
  const repo = freshRepo();
  const findings = path.join(repo, "must-fix.md");
  writeFileSync(
    findings,
    "## Findings\n\n[High] scripts/x.mjs:1 — unbounded retry loop (source: Bugbot)\n\n## Verdict\nBLOCKED\n"
  );
  const logDir = mkdtempSync(path.join(tmpdir(), "m1-"));
  cleanups.push(logDir);
  const promptLog = path.join(logDir, "prompts.log");
  process.env.FAKE_PROMPT_LOG = promptLog;
  let code;
  try {
    code = await run({
      repo,
      branch: "feat/m1",
      mode: "leak",
      o: opts({ rounds: 2, findingsFile: findings }),
    });
  } finally {
    delete process.env.FAKE_PROMPT_LOG;
  }
  check("gate never clears → GATE_FAILED", code === EXIT.GATE_FAILED);
  const prompts = (existsSync(promptLog) ? readFileSync(promptLog, "utf8") : "").split(
    "<<<PROMPT_SEP>>>"
  );
  const round2 = prompts[1] ?? "";
  check("captured a round-2 builder prompt", round2.trim().length > 0);
  check("round-2 prompt carries the gate failure", /scan FAILED/i.test(round2));
  check(
    "round-2 prompt STILL carries the outstanding must-fix finding",
    round2.includes("unbounded retry loop")
  );
}

console.log("--findings CLEAR file → abort before any builder invocation (M3)");
{
  // A CLEAR findings file (only a [Low], no actionable item) must NOT seed a fresh build —
  // it aborts fast (exit 1) with no builder call, instead of burning a builder round.
  const repo = freshRepo();
  const findings = path.join(repo, "clear-findings.md");
  cpSync(path.join(REPO, "test", "fixtures", "consolidate", "agent-clear.md"), findings);
  const logDir = mkdtempSync(path.join(tmpdir(), "m3-"));
  cleanups.push(logDir);
  const promptLog = path.join(logDir, "prompts.log");
  process.env.FAKE_PROMPT_LOG = promptLog;
  process.env.FAKE_AGENT_SCRIPT = "approve";

  const origExit = process.exit;
  let exitCode = null;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  console.log = () => {};
  console.error = () => {};
  process.exit = (n) => {
    exitCode = n;
    throw new Error("__die__");
  };
  try {
    await runBuild({
      repo,
      plan: "Add a feature module.",
      branch: "feat/m3",
      opts: opts({ findingsFile: findings }),
    });
  } catch {
    /* die() throws through the stubbed process.exit */
  } finally {
    process.exit = origExit;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    console.error = origError;
    delete process.env.FAKE_PROMPT_LOG;
  }
  check("aborted with exit 1 (nothing to fix)", exitCode === 1);
  const pl = existsSync(promptLog) ? readFileSync(promptLog, "utf8") : "";
  check("builder never invoked (empty prompt log)", pl.trim() === "");
}

// teardown
for (const p of cleanups) {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: p, stdio: "ignore" });
  } catch {
    /* not a repo */
  }
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
