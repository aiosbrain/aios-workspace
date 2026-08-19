// test/validate-cmd.test.mjs — `aios validate` (AIO-864 follow-up).
//
// The command exists because `validation/validate-all.sh` is a TOOLKIT path: a scaffolded
// workspace's validation/ holds only secret-patterns.txt, so the documented
// `cd <workspace> && validation/validate-all.sh .` is a guaranteed ENOENT, and a global npm
// install would otherwise need /usr/local/lib/node_modules/@aiosbrain/aios/validation/… .
//
// The end-to-end proof (install the tarball, scaffold all three contexts, validate each)
// lives in .github/scripts/clean-container-check.sh and the clean-container CI lane. These
// are the argument-handling and exit-code contracts, which a container run does not pin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cmdValidate } from "../scripts/validate-cmd.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");

/** Run `fn` with console.log/error muted, returning [result, captured]. */
function quiet(fn) {
  const log = console.log;
  const err = console.error;
  const captured = [];
  console.log = (...a) => captured.push(a.join(" "));
  console.error = (...a) => captured.push(a.join(" "));
  try {
    return [fn(), captured.join("\n")];
  } finally {
    console.log = log;
    console.error = err;
  }
}

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), "aios-validate-"));
}

test("validate: --help and -h print usage and exit 0 without running anything", () => {
  for (const flag of ["--help", "-h"]) {
    const [code, out] = quiet(() => cmdValidate(REPO, [flag]));
    assert.equal(code, 0, `${flag} should exit 0`);
    assert.match(out, /Usage: aios validate/);
    assert.match(out, /--critical/);
  }
});

test("validate: --critical and --quick are mutually exclusive", () => {
  const [code, out] = quiet(() => cmdValidate(REPO, ["--critical", "--quick"]));
  assert.equal(code, 2);
  assert.match(out, /mutually exclusive/);
});

test("validate: an unknown option is rejected rather than passed through", () => {
  // Silently forwarding an unrecognised flag would make it validate-all.sh's MODE argument,
  // which quietly falls through to `all` — so a typo'd `--critcal` would run every validator
  // while the user believed they had run one.
  const [code, out] = quiet(() => cmdValidate(REPO, ["--critcal"]));
  assert.equal(code, 2);
  assert.match(out, /unknown option --critcal/);
});

test("validate: more than one path is rejected", () => {
  const [code, out] = quiet(() => cmdValidate(REPO, ["a", "b"]));
  assert.equal(code, 2);
  assert.match(out, /at most one path, got 2/);
});

test("validate: a nonexistent target is named, not silently validated", () => {
  const missing = path.join(tmpdir(), "aios-validate-does-not-exist-1234");
  assert.ok(!existsSync(missing));
  const [code, out] = quiet(() => cmdValidate(REPO, [missing]));
  assert.equal(code, 2);
  assert.match(out, /no such workspace/);
  assert.ok(out.includes(missing), "the message must name the path that was not found");
});

test("validate: an unresolved workspace root is an error, not a validation of cwd", () => {
  const [code, out] = quiet(() => cmdValidate(undefined, []));
  assert.equal(code, 2);
  assert.match(out, /no such workspace/);
});

test("validate: a positional path overrides the resolved repo", () => {
  // The explicit target wins even when a workspace root was resolved — otherwise
  // `aios validate ../other-ws` would quietly validate the one you are standing in.
  const dir = tmpDir();
  try {
    const [code, out] = quiet(() => cmdValidate(REPO, [dir, "--quick"]));
    // An empty directory is not a workspace, so OGR01 fails — the point is that it ran
    // against `dir` rather than against REPO, and surfaced the validator's own status.
    assert.equal(code, 1, "the validator's non-zero status must propagate");
    assert.match(out, /validators from/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: resolves the validators from the toolkit, not from the workspace", () => {
  // The whole reason the command exists. A workspace never carries validate-all.sh, so the
  // path printed must be the toolkit's, and the script must actually be there.
  const dir = tmpDir();
  try {
    const [, out] = quiet(() => cmdValidate(dir, ["--quick"]));
    const m = /validators from (.+)$/m.exec(out);
    assert.ok(m, `no toolkit path in output: ${out}`);
    assert.ok(
      existsSync(path.join(m[1].trim(), "validation", "validate-all.sh")),
      "the reported toolkit has no validation/validate-all.sh"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: the mode flag reaches validate-all.sh", () => {
  // --quick is OGR01 only. If the flag were dropped, an empty dir would run all fourteen
  // validators instead of one, so the mode line is the observable difference.
  const dir = tmpDir();
  try {
    const r = spawnSync(
      "bash",
      [path.join(REPO, "validation", "validate-all.sh"), dir, "--quick"],
      {
        encoding: "utf8",
      }
    );
    assert.match(r.stdout, /Mode: --quick/);
    assert.match(r.stdout, /OGR01/);
    assert.doesNotMatch(r.stdout, /OGR08/, "--quick must not run the full suite");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: the CLI wires the command end to end", () => {
  // Proves registry -> dispatch -> cmdValidate, including the `exit: "exit-code"` contract.
  const dir = tmpDir();
  try {
    const r = spawnSync(
      process.execPath,
      [path.join(REPO, "scripts", "aios.mjs"), "validate", dir, "--quick"],
      {
        encoding: "utf8",
      }
    );
    assert.equal(r.status, 1, `expected the validator's exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /aios validate — validators from/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: `aios validate --help` is reachable from the CLI", () => {
  const r = spawnSync(
    process.execPath,
    [path.join(REPO, "scripts", "aios.mjs"), "validate", "--help"],
    {
      encoding: "utf8",
      cwd: tmpdir(),
    }
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: aios validate/);
});
