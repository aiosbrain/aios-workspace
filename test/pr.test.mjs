#!/usr/bin/env node
// test/pr.test.mjs — `aios pr` argv builders + cmdPr behavior (dry-run, idempotency,
// branch validation). Zero-dep, no live gh/git: fake `gh`/`git` on PATH record their
// invocations to a file so we can assert exactly what ran. Run: node test/pr.test.mjs

import { buildPushArgv, buildPrCreateArgv, cmdPr } from "../scripts/pr.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PR_MOD = path.join(DIR, "..", "scripts", "pr.mjs");

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

// ── pure argv builders ──────────────────────────────────────────────────────
console.log("buildPushArgv / buildPrCreateArgv");
{
  const push = buildPushArgv("feat/AIO-9-x");
  check(
    "push argv is exact (no shell string)",
    JSON.stringify(push) === JSON.stringify(["push", "-u", "origin", "feat/AIO-9-x"])
  );

  const create = buildPrCreateArgv({
    repo: "acme/repo",
    title: "AIO-9: feat/AIO-9-x",
    bodyFile: "/tmp/body.md",
    branch: "feat/AIO-9-x",
  });
  check(
    "create argv is exact",
    JSON.stringify(create) ===
      JSON.stringify([
        "pr",
        "create",
        "--repo",
        "acme/repo",
        "--title",
        "AIO-9: feat/AIO-9-x",
        "--body-file",
        "/tmp/body.md",
        "--head",
        "feat/AIO-9-x",
      ])
  );
  check("title carries the issue key", create[5].includes("AIO-9"));
}

// ── fake gh/git harness ─────────────────────────────────────────────────────
// RECORD env → both fakes append their argv (one JSON line each) so we can count calls.
// FAKE_PR_LIST → what `gh pr list` prints (a number = existing PR; empty = none).
const bin = mkdtempSync(path.join(tmpdir(), "pr-bin-"));
const record = path.join(bin, "record.log");
writeFileSync(
  path.join(bin, "git"),
  [
    "#!/usr/bin/env node",
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.RECORD, 'git ' + process.argv.slice(2).join(' ') + '\\n');",
    "process.exit(0);",
  ].join("\n")
);
writeFileSync(
  path.join(bin, "gh"),
  [
    "#!/usr/bin/env node",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const a = process.argv.slice(2);",
    "appendFileSync(process.env.RECORD, 'gh ' + a.join(' ') + '\\n');",
    "if (a[0] === 'pr' && a[1] === 'list') { process.stdout.write(process.env.FAKE_PR_LIST || ''); process.exit(0); }",
    "if (a[0] === 'pr' && a[1] === 'create') {",
    "  const bf = a[a.indexOf('--body-file') + 1];",
    "  const ti = a[a.indexOf('--title') + 1];",
    "  process.stdout.write('TITLE=' + ti + '\\n' + readFileSync(bf, 'utf8'));",
    "  process.stdout.write('\\nhttps://github.com/acme/repo/pull/77\\n');",
    "  process.exit(0);",
    "}",
    "process.exit(0);",
  ].join("\n")
);
chmodSync(path.join(bin, "git"), 0o755);
chmodSync(path.join(bin, "gh"), 0o755);
process.env.PATH = [bin, process.env.PATH].join(path.delimiter);
process.env.RECORD = record;

// Capture stdout while cmdPr runs.
async function capture(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (s) => {
    out += s;
    return true;
  };
  const origLog = console.log;
  console.log = (...args) => {
    out += args.join(" ") + "\n";
  };
  try {
    const rv = await fn();
    return { out, rv };
  } finally {
    process.stdout.write = orig;
    console.log = origLog;
  }
}
function resetRecord() {
  writeFileSync(record, "");
}

console.log("--dry-run makes zero child calls and prints both argv");
{
  resetRecord();
  process.env.FAKE_PR_LIST = "";
  const { out } = await capture(() =>
    cmdPr(".", [
      "--branch",
      "feat/AIO-42-x",
      "--repo",
      "acme/repo",
      "--issue",
      "AIO-42",
      "--dry-run",
    ])
  );
  const calls = readFileSync(record, "utf8").trim();
  check("no gh/git child calls recorded", calls === "");
  check("prints the push argv", out.includes("git push -u origin feat/AIO-42-x"));
  check("prints the gh pr create argv", out.includes("gh pr create --repo acme/repo"));
  check("dry-run title carries the issue", out.includes("AIO-42: feat/AIO-42-x"));
}

console.log("create flow: pushes, opens a PR, prints PR_NUMBER, body references the issue");
{
  resetRecord();
  process.env.FAKE_PR_LIST = ""; // no existing PR
  const { out, rv } = await capture(() =>
    cmdPr(".", ["--branch", "feat/AIO-42-x", "--repo", "acme/repo", "--issue", "AIO-42"])
  );
  const calls = readFileSync(record, "utf8");
  check("returns the parsed PR number", rv === 77);
  check("prints PR_NUMBER=77", out.includes("PR_NUMBER=77"));
  check("pushed the branch", calls.includes("git push -u origin feat/AIO-42-x"));
  check("title carries the issue key", out.includes("TITLE=AIO-42: feat/AIO-42-x"));
  check("generated body references the issue", out.includes("Implements AIO-42."));
}

console.log("idempotency: existing PR is reused — no push, no create");
{
  resetRecord();
  process.env.FAKE_PR_LIST = "55"; // a PR already open for this branch
  const { out, rv } = await capture(() =>
    cmdPr(".", ["--branch", "feat/AIO-42-x", "--repo", "acme/repo", "--issue", "AIO-42"])
  );
  const calls = readFileSync(record, "utf8");
  check("returns the existing PR number", rv === 55);
  check("prints PR_NUMBER=55", out.includes("PR_NUMBER=55"));
  check("did NOT push", !calls.includes("git push"));
  check("did NOT create a PR", !calls.includes("pr create"));
}

console.log("branch validation rejects shell metacharacters");
{
  // validateBranch → die() → process.exit(1); run in a child so the harness survives.
  const script =
    `import { cmdPr } from ${JSON.stringify(PR_MOD)};` +
    `await cmdPr('.', ['--branch', 'bad;rm -rf', '--repo', 'acme/repo']);`;
  let code = 0;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (e) {
    code = e.status ?? -1;
  }
  check("invalid branch aborts (exit 1)", code === 1);
}

rmSync(bin, { recursive: true, force: true });

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
