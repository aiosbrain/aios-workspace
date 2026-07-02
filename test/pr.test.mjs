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
    "const a = process.argv.slice(2);",
    "appendFileSync(process.env.RECORD, 'git ' + a.join(' ') + '\\n');",
    // FAKE_GIT_PUSH_FAIL → a rejected push, so we can assert the wrapped die() UX.
    "if (a[0] === 'push' && process.env.FAKE_GIT_PUSH_FAIL) { process.stderr.write('! [rejected] main -> main (fetch first)\\n'); process.exit(1); }",
    "process.exit(0);",
  ].join("\n")
);
writeFileSync(
  path.join(bin, "gh"),
  [
    "#!/usr/bin/env node",
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    "const a = process.argv.slice(2);",
    "appendFileSync(process.env.RECORD, 'gh ' + a.join(' ') + '\\n');",
    "if (a[0] === 'pr' && a[1] === 'list') {",
    "  if (process.env.FAKE_PR_LIST_FAIL) { process.stderr.write('gh: could not connect to api.github.com\\n'); process.exit(1); }",
    // FAKE_PR_LIST_COUNT → count list calls; the FIRST (idempotency) succeeds empty, a
    // later one (the post-create re-query) fails — exercises the undeterminable-number path.
    "  if (process.env.FAKE_PR_LIST_COUNT) {",
    "    let n = 0; try { n = parseInt(readFileSync(process.env.FAKE_PR_LIST_COUNT, 'utf8'), 10) || 0; } catch {}",
    "    n++; writeFileSync(process.env.FAKE_PR_LIST_COUNT, String(n));",
    "    if (n >= 2) { process.stderr.write('gh: re-query failed\\n'); process.exit(1); }",
    "  }",
    "  process.stdout.write(process.env.FAKE_PR_LIST || ''); process.exit(0);",
    "}",
    "if (a[0] === 'pr' && a[1] === 'create') {",
    // FAKE_PR_CREATE_BAD → the PR is created but the output carries no /pull/<n> URL.
    "  if (process.env.FAKE_PR_CREATE_BAD) { process.stdout.write('opened a pull request (no url)\\n'); process.exit(0); }",
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

console.log("idempotency: existing PR is reused — still PUSHES, but skips create");
{
  // M2: idempotency applies to PR *creation*, not the push. New local commits must reach
  // the remote even when a PR is already open, so `git push` still runs; only create is skipped.
  resetRecord();
  process.env.FAKE_PR_LIST = "55"; // a PR already open for this branch
  const { out, rv } = await capture(() =>
    cmdPr(".", ["--branch", "feat/AIO-42-x", "--repo", "acme/repo", "--issue", "AIO-42"])
  );
  const calls = readFileSync(record, "utf8");
  check("returns the existing PR number", rv === 55);
  check("prints PR_NUMBER=55", out.includes("PR_NUMBER=55"));
  check(
    "DID push (idempotent) even with an open PR",
    calls.includes("git push -u origin feat/AIO-42-x")
  );
  check("did NOT create a PR", !calls.includes("pr create"));
}

console.log("custom --title without the issue key gets it prefixed (H2)");
{
  process.env.FAKE_PR_LIST = "";
  const { out } = await capture(() =>
    cmdPr(".", [
      "--branch",
      "feat/AIO-42-x",
      "--repo",
      "acme/repo",
      "--issue",
      "AIO-42",
      "--title",
      "custom title",
      "--dry-run",
    ])
  );
  check("resulting title carries the issue key", out.includes("--title AIO-42: custom title"));
}

console.log("custom --title that already names the issue is left verbatim (H2)");
{
  process.env.FAKE_PR_LIST = "";
  const { out } = await capture(() =>
    cmdPr(".", [
      "--branch",
      "feat/AIO-42-x",
      "--repo",
      "acme/repo",
      "--issue",
      "AIO-42",
      "--title",
      "AIO-42: already keyed",
      "--dry-run",
    ])
  );
  check("keeps the custom title verbatim", out.includes("--title AIO-42: already keyed"));
  check("does not double-prefix the key", !out.includes("AIO-42: AIO-42"));
}

console.log("custom --title naming a DIFFERENT key is still prefixed with the resolved key (H2)");
{
  // "AIO-420" contains the substring "AIO-42" — a plain includes() would false-positive and
  // route the PR to the wrong issue. Word-boundary matching must prefix the resolved key.
  process.env.FAKE_PR_LIST = "";
  const { out } = await capture(() =>
    cmdPr(".", [
      "--branch",
      "feat/AIO-42-x",
      "--repo",
      "acme/repo",
      "--issue",
      "AIO-42",
      "--title",
      "AIO-420: wrong issue",
      "--dry-run",
    ])
  );
  check(
    "prefixes the resolved key ahead of the different one",
    out.includes("--title AIO-42: AIO-420: wrong issue")
  );
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

console.log("missing issue key aborts before any push/create");
{
  // A branch with no AIO-<n> and no --issue must fail fast (exit 1), recording no calls.
  resetRecord();
  const script =
    `import { cmdPr } from ${JSON.stringify(PR_MOD)};` +
    `await cmdPr('.', ['--branch', 'feat/no-issue', '--repo', 'acme/repo']);`;
  let code = 0;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RECORD: record, FAKE_PR_LIST: "" },
    });
  } catch (e) {
    code = e.status ?? -1;
  }
  const calls = readFileSync(record, "utf8").trim();
  check("missing issue aborts (exit 1)", code === 1);
  check("no push/create attempted", !calls.includes("git push") && !calls.includes("pr create"));
}

console.log("failed idempotency query aborts before push");
{
  // A failing `gh pr list` must NOT be read as "no PR" — abort before any push.
  resetRecord();
  const script =
    `import { cmdPr } from ${JSON.stringify(PR_MOD)};` +
    `await cmdPr('.', ['--branch', 'feat/AIO-42-x', '--repo', 'acme/repo', '--issue', 'AIO-42']);`;
  let code = 0;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RECORD: record, FAKE_PR_LIST_FAIL: "1" },
    });
  } catch (e) {
    code = e.status ?? -1;
  }
  const calls = readFileSync(record, "utf8");
  check("failed query aborts (exit 1)", code === 1);
  check("queried gh pr list", calls.includes("gh pr list"));
  check("did NOT push after a failed query", !calls.includes("git push"));
}

console.log("git push failure surfaces as die(), not a raw stack trace (M5)");
{
  // A rejected push must abort with the file's die() UX (exit 1), carry the git stderr detail
  // (stderr is piped, not inherited, so the rejection text survives), and never reach create.
  resetRecord();
  const script =
    `import { cmdPr } from ${JSON.stringify(PR_MOD)};` +
    `await cmdPr('.', ['--branch', 'feat/AIO-42-x', '--repo', 'acme/repo', '--issue', 'AIO-42']);`;
  let code = 0,
    stderr = "";
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RECORD: record, FAKE_PR_LIST: "", FAKE_GIT_PUSH_FAIL: "1" },
    });
  } catch (e) {
    code = e.status ?? -1;
    stderr = e.stderr ?? "";
  }
  const calls = readFileSync(record, "utf8");
  check("push failure aborts (exit 1)", code === 1);
  check("attempted the push", calls.includes("git push"));
  check("die() message names the push failure", stderr.includes("git push failed"));
  check("die() message carries the git rejection detail", stderr.includes("[rejected]"));
  check("did NOT create a PR after a failed push", !calls.includes("pr create"));
}

console.log("undeterminable PR number after create is a failure, not silent success (M3)");
{
  // create succeeds but prints no /pull/<n> URL AND the re-query fails → must die, never
  // return null with an exit-0 no-PR_NUMBER "success".
  resetRecord();
  const countFile = path.join(bin, "count-m3");
  writeFileSync(countFile, "0");
  const script =
    `import { cmdPr } from ${JSON.stringify(PR_MOD)};` +
    `await cmdPr('.', ['--branch', 'feat/AIO-42-x', '--repo', 'acme/repo', '--issue', 'AIO-42']);`;
  let code = 0,
    stdout = "";
  try {
    stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RECORD: record,
        FAKE_PR_LIST: "",
        FAKE_PR_LIST_COUNT: countFile,
        FAKE_PR_CREATE_BAD: "1",
        FAKE_GIT_PUSH_FAIL: "",
      },
    });
  } catch (e) {
    code = e.status ?? -1;
  }
  const calls = readFileSync(record, "utf8");
  check("undeterminable number aborts (exit 1)", code === 1);
  check("did push", calls.includes("git push"));
  check("did attempt create", calls.includes("gh pr create"));
  check("did NOT print a bogus PR_NUMBER", !stdout.includes("PR_NUMBER="));
}

rmSync(bin, { recursive: true, force: true });

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
