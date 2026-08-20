#!/usr/bin/env node
// guard-selftest.mjs — one-command hand-verification of hooks/team-ops-guard.sh (AIO-953).
//
// The 0.11.1 spot-check went wrong three times in a row, and every wrong answer
// looked like a right one. This script is the check a human should run instead of
// hand-rolling a payload: it builds a CORRECT PreToolUse payload against a synthetic
// spine workspace, runs the guard under `bash` (its required interpreter), and prints
// per case: the payload shape, the exit code, and the matched pattern. It then
// demonstrates the three known hand-check traps and names the REAL mechanism behind
// each one (per the AIO-1000/UH2-1 verification, which corrected the issue text).
//
// Exit code: 0 = the guard is enforcing and every assertion held.
//            1 = an assertion failed — most importantly, the guard FAILED TO BLOCK
//                a known-secret payload, which is the fail-open defect (AIO-945).
//
// Usage: npm run guard:selftest
//        node scripts/guard-selftest.mjs [--guard <path-to-team-ops-guard.sh>]
//
// Payload shape and troubleshooting doc: docs/guard-verification.md

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A fake AWS access key id, assembled at runtime so no secret-shaped literal ever
// appears in this file (the repo's own secret gates scan source too). Matches the
// guard's AKIA pattern; it is AWS's documented example key, not a live credential.
const FAKE_AWS_KEY = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");

function parseArgs(argv) {
  const args = { guard: path.join(ROOT, "hooks", "team-ops-guard.sh") };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--guard") {
      const value = argv[++i];
      if (value === undefined) {
        console.error("--guard requires a path argument");
        process.exit(1);
      }
      args.guard = path.resolve(value);
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}

// Run the guard exactly the way Claude Code does: via an interpreter, event JSON on
// stdin, verdict = exit code (0 allow, 2 block + stderr naming the reason).
function runGuard(interpreter, guardPath, stdinText) {
  const env = { ...process.env };
  // These would change the guard's behavior out from under the test.
  delete env.CC_TOOL_INPUT;
  delete env.CC_TOOL_NAME;
  delete env.AIOS_GUARD_ALLOW_UNPARSED;
  const r = spawnSync(interpreter, [guardPath], {
    input: stdinText,
    encoding: "utf8",
    env,
  });
  if (r.error || r.status === null) {
    // The interpreter itself could not run (missing binary, signal death). That is an
    // environmental failure of THIS harness, not a guard verdict — reporting it as
    // "exit 0, fail-open" would be exactly the false diagnosis this tool exists to
    // prevent, so stop the whole self-test here.
    console.error(
      `could not execute '${interpreter}' to run the guard: ` +
        `${r.error ? r.error.message : `terminated without an exit code (signal: ${r.signal})`}`
    );
    console.error(
      "no verdict was reached — this is a harness/environment failure, not a guard result."
    );
    process.exit(1);
  }
  return { code: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

function matchedPattern(stderr) {
  const m = stderr.match(/Pattern matched: (.*)/);
  return m ? m[1].trim() : null;
}

function payloadFor(filePath, content) {
  // The shape the guard actually reads (docs/guard-verification.md):
  // tool_input is the load-bearing wrapper; the guard never reads tool_name.
  return JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: filePath, content },
  });
}

function makeSyntheticWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "aios-guard-selftest-"));
  for (const d of ["0-context", "1-inbox", "2-work", "3-log", "4-shared", "5-personal"]) {
    fs.mkdirSync(path.join(ws, d));
  }
  return ws;
}

const results = [];
function report(name, ok, lines) {
  results.push({ name, ok });
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}`);
  for (const l of lines) console.log(`  ${l}`);
}

// ── Case 1 (CRITICAL): correct secret payload must BLOCK at exit 2, naming the pattern.
// The payload carries valid frontmatter on purpose: 2-work/*.md is also subject to the
// guard's frontmatter check, and a frontmatter-less payload would be blocked at exit 2
// by THAT check even if the secret scan were dead — a false pass for this case. With
// frontmatter present, only the secret scan can block, so exit 2 + "Pattern matched"
// is attributable to the scan and nothing else.
function caseBlocksSecret(guard, ws) {
  const payload = payloadFor(
    path.join(ws, "2-work", "notes.md"),
    `---\naccess: team\n---\n\naws_key = ${FAKE_AWS_KEY}\n`
  );
  const r = runGuard("bash", guard, payload);
  const pattern = matchedPattern(r.stderr);
  const ok = r.code === 2 && pattern !== null;
  let diagnosis;
  if (ok) {
    diagnosis =
      "the guard is enforcing: a well-formed write carrying an AWS key is refused by name.";
  } else if (r.code === 2) {
    diagnosis =
      "blocked at exit 2 but WITHOUT a 'Pattern matched' line — a different check " +
      "(not the secret scan) fired. The secret scan is unproven and may be dead; " +
      `stderr: ${r.stderr.trim().split("\n")[0] || "(empty)"}`;
  } else if (r.code === 0) {
    diagnosis =
      "THE GUARD DID NOT BLOCK A KNOWN SECRET. This is the fail-open defect " +
      "(AIO-945) — do not ship, do not trust this guard until this passes.";
  } else {
    diagnosis = `unexpected exit code; stderr: ${r.stderr.trim().split("\n")[0] || "(empty)"}`;
  }
  report("blocks a correct secret payload", ok, [
    `payload: ${payload}`,
    `exit code: ${r.code} (expected 2)`,
    `matched pattern: ${pattern ?? "(none)"}`,
    diagnosis,
  ]);
}

// ── Case 2 (CRITICAL): correct benign payload must ALLOW at exit 0.
function caseAllowsBenign(guard, ws) {
  const payload = payloadFor(
    path.join(ws, "2-work", "notes.md"),
    "---\naccess: team\n---\n\n# Meeting notes\n\nNothing sensitive here.\n"
  );
  const r = runGuard("bash", guard, payload);
  const ok = r.code === 0;
  report("allows a correct benign payload", ok, [
    `payload: ${payload}`,
    `exit code: ${r.code} (expected 0)`,
    ok
      ? "clean content passes — the guard blocks secrets, not writes in general."
      : `unexpected block; stderr: ${r.stderr.trim()}`,
  ]);
}

// ── Trap 1: invoking the guard with sh/dash instead of bash → FALSE PASS.
// The script needs bash (`set -o pipefail`, BASH_SOURCE, arrays). Under dash it
// dies on a syntax error with a non-zero exit that LOOKS like a block — for the
// fixed guard and a broken guard alike. Exit 2 here proves nothing.
function caseTrapWrongShell(guard, ws) {
  const shell = spawnSync("dash", ["-c", "true"]).status === 0 ? "dash" : "sh";
  const payload = payloadFor(path.join(ws, "2-work", "notes.md"), `aws_key = ${FAKE_AWS_KEY}`);
  const r = runGuard(shell, guard, payload);
  // "Bad substitution": a POSIX sh that happens to accept `set -o pipefail` still
  // dies later on ${BASH_SOURCE[0]} — same trap, different first error.
  const syntaxDeath = /Illegal option|pipefail|Syntax error|Bad substitution/i.test(r.stderr);
  const actuallyBlocked = matchedPattern(r.stderr) !== null;
  const ok = syntaxDeath || actuallyBlocked; // classified either way
  const lines = [
    `interpreter: ${shell} (WRONG — the guard is bash-only)`,
    `payload: ${payload}`,
    `exit code: ${r.code}`,
    `stderr: ${r.stderr.trim().split("\n")[0] || "(empty)"}`,
  ];
  if (syntaxDeath) {
    lines.push(
      "TRAP DEMONSTRATED (false pass): that non-zero exit is a shell SYNTAX ERROR,",
      "not a verdict. A broken guard exits identically under sh/dash, so 'it exited 2'",
      "verifies nothing. Always invoke the guard with bash."
    );
  } else if (actuallyBlocked) {
    lines.push(
      `your '${shell}' is bash running in sh-mode (common on macOS), so the guard`,
      "happened to work — but on Debian/Ubuntu/slim containers, where sh is dash,",
      "this same command dies on a syntax error at a block-looking exit code.",
      "Do not rely on it: always invoke the guard with bash."
    );
  } else {
    lines.push("unexpected outcome — could not classify; treat as a failure.");
  }
  report("trap: running under sh/dash is a false pass", ok, lines);
}

// ── Trap 2: missing tool_input wrapper (or empty stdin) → FALSE FAIL.
// Mechanism (per AIO-1000): the guard never reads tool_name. A flat payload
// parses as valid JSON that simply carries no tool_input, so the guard correctly
// answers "not a write event — allow". Exit 0 here looks exactly like the old
// fail-open bug but is a malformed harness, not a broken guard.
function caseTrapMissingWrapper(guard, ws) {
  const flat = JSON.stringify({
    file_path: path.join(ws, "2-work", "notes.md"),
    content: `aws_key = ${FAKE_AWS_KEY}`,
  });
  const rFlat = runGuard("bash", guard, flat);
  const rEmpty = runGuard("bash", guard, "");
  const ok = rFlat.code === 0 && rEmpty.code === 0;
  report("trap: payload without the tool_input wrapper is a false fail", ok, [
    `flat payload (WRONG shape — no tool_input wrapper): ${flat}`,
    `exit code: ${rFlat.code} — allowed`,
    `empty stdin exit code: ${rEmpty.code} — allowed`,
    "TRAP DEMONSTRATED (false fail): exit 0 on a secret here does NOT mean the",
    "guard is broken. The secret sits at the top level, but the guard only reads",
    "fields inside tool_input — a payload without that wrapper (or an empty stdin)",
    "is 'not a write event', which correctly allows. (Omitting tool_name changes",
    "nothing: the guard never reads it.) Use the correct shape:",
    `  {"tool_name":"Write","tool_input":{"file_path":"...","content":"..."}}`,
  ]);
}

// ── Trap 3: a path with an unchecked EXTENSION → allowed by the extension filter.
// Mechanism (per AIO-1000): /tmp/x.env passes because '.env' is not in the guard's
// checked-extension list (.md .yaml .yml .json .sh .py .ts .js) — NOT because /tmp
// is outside a workspace. Counter-proof: the same secret to /tmp/x.md still blocks.
function caseTrapExtensionFilter(guard) {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aios-guard-selftest-out-"));
  try {
    const envPayload = payloadFor(path.join(outside, "x.env"), `AWS_KEY=${FAKE_AWS_KEY}`);
    const mdPayload = payloadFor(path.join(outside, "x.md"), `AWS_KEY=${FAKE_AWS_KEY}`);
    const rEnv = runGuard("bash", guard, envPayload);
    const rMd = runGuard("bash", guard, mdPayload);
    const ok = rEnv.code === 0 && rMd.code === 2;
    report("trap: unchecked file extension allows — path location is not why", ok, [
      `.env payload: ${envPayload}`,
      `.env exit code: ${rEnv.code} — allowed (.env is not in the checked-extension list)`,
      `.md payload (same secret, same directory): ${mdPayload}`,
      `.md exit code: ${rMd.code} — blocked (pattern: ${matchedPattern(rMd.stderr) ?? "(none)"})`,
      "TRAP EXPLAINED: a secret to /tmp/x.env exits 0 because of the file-EXTENSION",
      "filter (.md .yaml .yml .json .sh .py .ts .js are checked; .env is not) —",
      "not workspace scoping. The same secret to an .md file outside any workspace",
      "still blocks. An exit 0 on an unchecked extension is not the fail-open bug.",
    ]);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function main() {
  const { guard } = parseArgs(process.argv);
  if (!fs.existsSync(guard)) {
    console.error(`guard not found: ${guard}`);
    process.exit(1);
  }
  console.log(`guard under test: ${guard}`);
  console.log(`interpreter for real runs: bash (the guard is bash-only)`);

  const ws = makeSyntheticWorkspace();
  console.log(`synthetic workspace: ${ws}`);

  try {
    caseBlocksSecret(guard, ws);
    caseAllowsBenign(guard, ws);
    caseTrapWrongShell(guard, ws);
    caseTrapMissingWrapper(guard, ws);
    caseTrapExtensionFilter(guard);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} cases passed`);
  if (failed.length > 0) {
    console.error(`guard self-test FAILED: ${failed.map((f) => f.name).join("; ")}`);
    process.exit(1);
  }
  console.log("guard self-test passed: the secret guard is enforcing on this machine.");
}

main();
