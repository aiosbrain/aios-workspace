#!/usr/bin/env node
// check-scaffold-guard.mjs — OGR08: scaffolded workspaces ship a working guard.
//
// Generates a throwaway workspace and asserts it contains the PreToolUse guard
// (hooks/team-ops-guard.sh, executable), its secret patterns, and a
// .claude/settings.json registering the hook for Edit/Write/MultiEdit — and that
// the shipped hook actually blocks a secret (exit 2) via stdin JSON. This closes
// the gap where Claude Code's native guard didn't fire in real workspaces.
//
// Usage: ./validation/check-scaffold-guard.mjs [repo]  (repo arg unused; kept for
// validate-all.sh's signature). Wired into validate-all.sh.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
let errors = 0;
const fail = (m) => {
  console.log(`  ${RED}✗${NC} ${m}`);
  errors++;
};
const ok = (m) => console.log(`  ${GREEN}✓${NC} ${m}`);

console.log("OGR08: scaffolded workspace ships a working guard");
console.log("================================================");

const tmp = mkdtempSync(path.join(tmpdir(), "ogr08-"));
const ws = path.join(tmp, "ws");
try {
  execFileSync(
    "bash",
    [
      path.join(REPO, "scripts", "scaffold-project.sh"),
      "--slug",
      "ogr8-check",
      "--owner",
      "tester",
      "--context",
      "consultant",
      "--output",
      ws,
      "--org",
      "test-org",
    ],
    { cwd: REPO, stdio: "pipe" }
  );
} catch (e) {
  fail(`scaffold-project.sh failed: ${String(e.stderr || e.message).split("\n")[0]}`);
}

if (existsSync(ws)) {
  const hook = path.join(ws, "hooks", "team-ops-guard.sh");
  if (!existsSync(hook)) fail("workspace missing hooks/team-ops-guard.sh");
  else if (!(statSync(hook).mode & 0o111)) fail("hooks/team-ops-guard.sh is not executable");
  else ok("hooks/team-ops-guard.sh present + executable");

  if (!existsSync(path.join(ws, "validation", "secret-patterns.txt")))
    fail("workspace missing validation/secret-patterns.txt");
  else ok("validation/secret-patterns.txt present");

  for (const hook of ["asks-capture.mjs", "decision-capture.mjs", "session-pulse.mjs"]) {
    const p = path.join(ws, "hooks", hook);
    if (!existsSync(p)) fail(`workspace missing hooks/${hook}`);
    else if (!(statSync(p).mode & 0o111)) fail(`hooks/${hook} is not executable`);
    else ok(`hooks/${hook} present + executable`);
  }

  const reviewer = path.join(ws, ".claude", "agents", "code-reviewer.md");
  if (!existsSync(reviewer)) fail("workspace missing .claude/agents/code-reviewer.md");
  else ok(".claude/agents/code-reviewer.md present");

  const settingsPath = path.join(ws, ".claude", "settings.json");
  if (!existsSync(settingsPath)) fail("workspace missing .claude/settings.json");
  else {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf8"));
      const pre = s?.hooks?.PreToolUse?.[0];
      const matcher = pre?.matcher || "";
      const cmd = pre?.hooks?.[0]?.command || "";
      const matchesAll = ["Edit", "Write", "MultiEdit"].every((t) => matcher.includes(t));
      if (!matchesAll) fail(`settings.json matcher missing Edit/Write/MultiEdit: '${matcher}'`);
      else if (!cmd.includes("team-ops-guard.sh"))
        fail(`settings.json hook command not team-ops-guard.sh: '${cmd}'`);
      else ok("settings.json registers PreToolUse(Edit|Write|MultiEdit) → team-ops-guard.sh");

      const notif = s?.hooks?.Notification?.[0]?.hooks?.[0]?.command || "";
      const stopAsks = s?.hooks?.Stop?.[0]?.hooks?.[0]?.command || "";
      const postTool = s?.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command || "";
      const postMatcher = s?.hooks?.PostToolUse?.[0]?.matcher || "";
      if (!notif.includes("asks-capture.mjs"))
        fail("settings.json missing Notification → asks-capture.mjs");
      else if (!stopAsks.includes("asks-capture.mjs"))
        fail("settings.json missing Stop → asks-capture.mjs");
      else if (!postTool.includes("decision-capture.mjs"))
        fail("settings.json missing PostToolUse → decision-capture.mjs");
      else if (!postMatcher.includes("AskUserQuestion") || !postMatcher.includes("ExitPlanMode"))
        fail(`settings.json PostToolUse matcher missing AskUserQuestion|ExitPlanMode: '${postMatcher}'`);
      else
        ok(
          "settings.json registers capture hooks (Notification/Stop asks, PostToolUse decisions)"
        );
    } catch (e) {
      fail(`settings.json not valid JSON: ${e.message}`);
    }
  }

  // The shipped hook must actually block a secret (exit 2) via stdin JSON.
  if (existsSync(hook)) {
    const secret = "k=AKIA" + "IOSFODNN7EXAMPLE";
    const ev = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "notes.md", content: secret },
    });
    let code = 0;
    try {
      execFileSync("bash", [hook], { input: ev, stdio: "pipe" });
    } catch (e) {
      code = e.status;
    }
    if (code !== 2) fail(`shipped hook did not block a secret (expected exit 2, got ${code})`);
    else ok("shipped hook blocks a secret via stdin (exit 2)");
  }
} else {
  fail("no workspace generated");
}
// Best-effort temp cleanup with retries: removing the scaffolded `.git` can race
// with git's own background writes and throw a transient ENOTEMPTY. The check has
// already passed/failed by here, so a teardown hiccup must never flip the result.
try {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
} catch {
  /* OS reaps tmpdir; don't fail OGR08 on a cleanup race */
}

console.log("================================================");
if (errors === 0) {
  console.log(`${GREEN}OGR08 PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}OGR08 FAILED — ${errors} issue(s)${NC}`);
process.exit(1);
