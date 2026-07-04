#!/usr/bin/env node
// test/ship-dry-run.cli.test.mjs — spawn the REAL CLI offline.
// `ship --help` prints usage; `ship AIO-163 --dry-run` with NO LINEAR_API_KEY prints the step
// plan (stages + models + gates + reviewers + exit table), exits 0, and makes NO external
// git/gh/claude/cursor calls (PATH holds only recording stubs) and prints no stack trace.
// Run: node test/ship-dry-run.cli.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

// PATH with only recording stubs for the external binaries — any invocation appends to RECORD.
const stubDir = mkdtempSync(path.join(tmpdir(), "ship-dry-stub-"));
const RECORD = path.join(stubDir, "record.log");
for (const bin of ["git", "gh", "cursor", "claude"]) {
  const p = path.join(stubDir, bin);
  writeFileSync(p, `#!/bin/sh\necho "${bin} $*" >> "${RECORD}"\nexit 0\n`);
  chmodSync(p, 0o755);
}

function runCli(args) {
  const env = { ...process.env, PATH: stubDir };
  delete env.LINEAR_API_KEY;
  try {
    const stdout = execFileSync(process.execPath, [AIOS, ...args], {
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

console.log("ship --help");
{
  const r = runCli(["ship", "--help"]);
  check("exit 0", r.code === 0);
  check("prints usage", /aios ship/.test(r.stdout) && /--auto-merge/.test(r.stdout));
}

console.log("ship AIO-163 --dry-run (offline, no key)");
{
  const r = runCli(["ship", "AIO-163", "--dry-run", "--repo", REPO]);
  check("exit 0", r.code === 0);
  check("prints stages", /Stages \(spec eval/.test(r.stdout));
  check("prints spec_eval step", /spec_eval/.test(r.stdout));
  check("prints per-step models (recon)", /recon\s+claude/.test(r.stdout));
  check("prints gates", /Gates:/.test(r.stdout));
  check("prints reviewers", /Reviewers:/.test(r.stdout));
  check(
    "prints SHIP_EXIT table",
    /SHIP_EXIT codes:/.test(r.stdout) && /CLEANUP_FAILED/.test(r.stdout)
  );
  check("no external git/gh/claude/cursor call", !existsSync(RECORD));
  check("no stack trace on stderr", !/\n\s+at\s/.test(r.stderr));
  if (existsSync(RECORD)) console.log("    record:", readFileSync(RECORD, "utf8"));
}

console.log("ship AIO-163 (non-TTY, no --auto, no key) → clean key USAGE error (runs to the gate)");
{
  // AIO-239: a blocked gate no longer short-circuits before recon — ship runs UP TO the gate,
  // persists GATE-plan.pending.md + state.json, and exits 22 there (resumable). Reaching the gate
  // requires LINEAR_API_KEY, so a keyless non-TTY run now fails cleanly on the missing key
  // (USAGE, 1) BEFORE any external call — never a stack trace, never a silent hang.
  const r = runCli(["ship", "AIO-163", "--repo", REPO]);
  check("exit 1 (USAGE — key required to run to the gate)", r.code === 1);
  check("mentions the missing LINEAR_API_KEY", /LINEAR_API_KEY/.test(r.stderr));
  check("no external git/gh/claude/cursor call", !existsSync(RECORD));
  check("no stack trace on stderr", !/\n\s+at\s/.test(r.stderr));
}

console.log("ship AIO-163 --auto (non-TTY, no --auto-merge, no key) → same clean key USAGE error");
{
  // Same contract with only the merge gate active: the pipeline would run all the way to the
  // merge gate and exit 62 there; without a key it fails cleanly up front instead.
  const r = runCli(["ship", "AIO-163", "--auto", "--repo", REPO]);
  check("exit 1 (USAGE — key required)", r.code === 1);
  check("mentions the missing LINEAR_API_KEY", /LINEAR_API_KEY/.test(r.stderr));
  check("no external git/gh/claude/cursor call", !existsSync(RECORD));
}

rmSync(stubDir, { recursive: true, force: true });

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
