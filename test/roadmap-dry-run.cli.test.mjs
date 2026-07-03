#!/usr/bin/env node
// test/roadmap-dry-run.cli.test.mjs — spawn the REAL CLI. `roadmap-run --dry-run` WITHOUT
// LINEAR_API_KEY → a clean, actionable message + a documented non-zero exit (no stack trace).
// Usage error on zero/multiple sources. Run: node test/roadmap-dry-run.cli.test.mjs

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");

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

function runCli(args) {
  const env = { ...process.env };
  delete env.LINEAR_API_KEY;
  try {
    const stdout = execFileSync(process.execPath, [AIOS, ...args, "--repo", REPO], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? -1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

const noStack = (s) => !/\n\s+at\s/.test(s) && !/Error:/.test(s);

console.log("--dry-run without LINEAR_API_KEY");
{
  const r = runCli(["roadmap-run", "--label", "ship", "--dry-run"]);
  check("non-zero exit", r.code === 1);
  check("clean actionable message", /LINEAR_API_KEY is not set/.test(r.stderr));
  check("no stack trace", noStack(r.stderr));
}

console.log("--help exits 0");
{
  const r = runCli(["roadmap-run", "--help"]);
  check("exit 0", r.code === 0);
  check("prints usage", /aios roadmap-run/.test(r.stdout));
}

console.log("usage errors (zero / multiple sources)");
{
  const zero = runCli(["roadmap-run"]);
  check("zero sources → exit 1", zero.code === 1);
  check("zero sources message", /exactly one source/.test(zero.stderr));
  check("zero sources no stack", noStack(zero.stderr));

  const two = runCli(["roadmap-run", "--label", "x", "--epic", "AIO-1"]);
  check("two sources → exit 1", two.code === 1);
  check("two sources message", /exactly one source/.test(two.stderr));

  const ambiguous = runCli(["roadmap-run", "--label", "x", "--comment-digest"]);
  check("comment-digest ambiguous → exit 1", ambiguous.code === 1);
  check("comment-digest message", /--comment-digest needs a target/.test(ambiguous.stderr));
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
