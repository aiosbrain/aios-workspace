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

console.log("builder commits on PRIMARY checkout (HEAD tripwire) → exit 1");
{
  const repo = freshRepo();
  const code = await run({ repo, branch: "feat/t4d", mode: "touch-primary-head", o: opts() });
  check("exit FATAL (HEAD tripwire)", code === EXIT.FATAL);
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
