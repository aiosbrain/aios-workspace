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

console.log("builder touches the PRIMARY checkout → tripwire trips, exit 1");
{
  const repo = freshRepo();
  const code = await run({ repo, branch: "feat/t4b", mode: "touch-primary", o: opts() });
  check("exit FATAL (tripwire)", code === EXIT.FATAL);
  check(
    "the escape was detected (file landed in primary)",
    existsSync(path.join(repo, "TRIPWIRE_TEST.txt"))
  );
  rmSync(path.join(repo, "TRIPWIRE_TEST.txt"), { force: true });
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
