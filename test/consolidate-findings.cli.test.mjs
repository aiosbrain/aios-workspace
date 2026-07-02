#!/usr/bin/env node
// test/consolidate-findings.cli.test.mjs — end-to-end through `node scripts/aios.mjs`,
// asserting the DISPATCH exit-code plumbing (Major 4): the command RETURNS a code and the
// dispatcher owns process.exit. Fake `gh`/`claude` binaries on PATH (like pr.test.mjs) drive
// the run — no network, no live agents. The real .claude/agents/code-reviewer.md is read.
// Run: node test/consolidate-findings.cli.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const FIX = path.join(DIR, "fixtures", "consolidate");

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

// Fake gh: `pr checks` → chosen board; `pr diff` → a diff; `api …` → empty JSON arrays.
// Fake claude: prints a canned model output as a single stream-json result event so the
// relay-core NDJSON parser captures it. FAKE_AGENT_OUT selects the fixture file.
const bin = mkdtempSync(path.join(tmpdir(), "consol-bin-"));
writeFileSync(
  path.join(bin, "gh"),
  [
    "#!/usr/bin/env node",
    "import { readFileSync } from 'node:fs';",
    "const a = process.argv.slice(2);",
    "if (a[0] === 'pr' && a[1] === 'checks') {",
    "  process.stdout.write(readFileSync(process.env.FAKE_CHECKS, 'utf8'));",
    "  process.exit(process.env.FAKE_CHECKS_FAIL ? 1 : 0);",
    "}",
    "if (a[0] === 'pr' && a[1] === 'diff') { process.stdout.write('diff --git a/x b/x\\n+line\\n'); process.exit(0); }",
    "if (a[0] === 'api') { process.stdout.write('[]'); process.exit(0); }",
    "process.exit(0);",
  ].join("\n")
);
writeFileSync(
  path.join(bin, "claude"),
  [
    "#!/usr/bin/env node",
    "import { readFileSync } from 'node:fs';",
    "const body = readFileSync(process.env.FAKE_AGENT_OUT, 'utf8');",
    "process.stdout.write(JSON.stringify({ type: 'result', result: body }) + '\\n');",
    "process.exit(0);",
  ].join("\n")
);
chmodSync(path.join(bin, "gh"), 0o755);
chmodSync(path.join(bin, "claude"), 0o755);

function runCli(args, env) {
  const res = { code: 0, stdout: "", stderr: "" };
  try {
    res.stdout = execFileSync(process.execPath, [AIOS, "consolidate-findings", ...args], {
      cwd: REPO, // real repo → real .claude/agents/code-reviewer.md + git remote
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: [bin, process.env.PATH].join(path.delimiter), ...env },
    });
  } catch (e) {
    res.code = e.status ?? -1;
    res.stdout = e.stdout ?? "";
    res.stderr = e.stderr ?? "";
  }
  return res;
}

const outDir = mkdtempSync(path.join(tmpdir(), "consol-out-"));

console.log("blocked fixture → process exits 3, stdout VERDICT=BLOCKED");
{
  const r = runCli(
    ["--pr", "44", "--issue", "AIO-161", "--repo", "acme/repo", "--out", path.join(outDir, "b.md")],
    {
      FAKE_CHECKS: path.join(FIX, "pr-checks-pass.json"),
      FAKE_AGENT_OUT: path.join(FIX, "agent-blocked.md"),
    }
  );
  check("process exits 3", r.code === 3);
  check("stdout has VERDICT=BLOCKED", r.stdout.includes("VERDICT=BLOCKED"));
}

console.log("clear fixture → process exits 0");
{
  const r = runCli(
    ["--pr", "44", "--issue", "AIO-161", "--repo", "acme/repo", "--out", path.join(outDir, "c.md")],
    {
      FAKE_CHECKS: path.join(FIX, "pr-checks-pass.json"),
      FAKE_AGENT_OUT: path.join(FIX, "agent-clear.md"),
    }
  );
  check("process exits 0", r.code === 0);
  check("stdout has VERDICT=CLEAR", r.stdout.includes("VERDICT=CLEAR"));
}

console.log("red CI board → exits 3 (data, not error)");
{
  const r = runCli(
    ["--pr", "44", "--issue", "AIO-161", "--repo", "acme/repo", "--out", path.join(outDir, "r.md")],
    {
      FAKE_CHECKS: path.join(FIX, "pr-checks-fail.json"),
      FAKE_CHECKS_FAIL: "1",
      FAKE_AGENT_OUT: path.join(FIX, "agent-clear.md"),
    }
  );
  check("red CI exits 3 (not 1)", r.code === 3);
}

console.log("--repo slug is honored (carve-out), not treated as a path");
{
  // If --repo were consumed as the workspace path, dispatch would fail to find a repo root.
  // Reaching a VERDICT proves the slug flowed through to the command as a GitHub target.
  const r = runCli(
    [
      "--pr",
      "44",
      "--issue",
      "AIO-161",
      "--repo",
      "some-owner/some-repo",
      "--out",
      path.join(outDir, "s.md"),
    ],
    {
      FAKE_CHECKS: path.join(FIX, "pr-checks-pass.json"),
      FAKE_AGENT_OUT: path.join(FIX, "agent-clear.md"),
    }
  );
  check("slug honored → command ran to a verdict", r.stdout.includes("VERDICT="));
}

rmSync(bin, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
