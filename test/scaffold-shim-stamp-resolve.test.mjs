// AIO-814 — a scaffolded workspace's CLI shim must resolve the aios-workspace checkout with
// no setup at all.
//
// Before this, `scaffold/scripts/aios.mjs` only resolved when someone exported
// AIOS_TOOLKIT_DIR or their directories happened to match one of three hardcoded relative
// guesses. The website's own instructions produced a layout matching none of them, so
// following the documented steps exactly produced `aios: ... not found`. The checkout was
// always recorded — `scaffold-project.sh` writes `source <path>` into
// `.aios-toolkit-version` and every `aios update` rewrites it (scripts/update/stamp.mjs) —
// the shim just never read it.
//
// One test runs a real scaffold, because the end-to-end claim is that the scaffolder and the
// shim agree about that file. The rest drive the shim against hand-written stamps: the
// failure modes worth guarding (a stale path, a clone URL, a corrupt stamp) are properties of
// the resolver, and asserting them through a full scaffold each time would buy nothing but
// minutes and teardown races (cf. AIO-589).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SCRIPT = path.join(ROOT, "scripts", "scaffold-project.sh");
const SHIM = path.join(ROOT, "scaffold", "scripts", "aios.mjs");
const NOT_FOUND = /aios-workspace checkout not found/;

const discard = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

/** A temp dir that does not exist yet — the scaffolder refuses a non-empty existing dir. */
function reserveDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  rmSync(dir, discard);
  return dir;
}

/** Run the shim from `workspace`, with both toolkit env vars scrubbed unless overridden. */
function runShim(workspace, env = {}) {
  // Dropped by destructuring, never read — the point is what `rest` no longer carries.
  const { AIOS_TOOLKIT_DIR: _dir, AIOS_TOOLKIT_CLI: _cli, ...rest } = process.env;
  const res = execFileSync(
    process.execPath,
    [path.join(workspace, "scripts", "aios.mjs"), "--no-such-command"],
    { env: { ...rest, ...env }, encoding: "utf8", stdio: "pipe", cwd: tmpdir() }
  );
  return res;
}

/** As runShim, but for the paths that exit non-zero; returns combined output. */
function runShimExpectingFailure(workspace, env = {}) {
  try {
    return runShim(workspace, env);
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

/**
 * A minimal stand-in for a scaffolded workspace: the real shim plus whatever stamp the test
 * wants. Lives under tmpdir(), so none of the shim's relative sibling guesses can resolve —
 * anything that works here worked through the stamp.
 */
function fixtureWorkspace(stamp) {
  const dir = mkdtempSync(path.join(tmpdir(), "shim-stamp-"));
  mkdirSync(path.join(dir, "scripts"));
  copyFileSync(SHIM, path.join(dir, "scripts", "aios.mjs"));
  if (stamp !== undefined) writeFileSync(path.join(dir, ".aios-toolkit-version"), stamp);
  return dir;
}

test("a real scaffold produces a workspace whose shim resolves with no env and no setup", () => {
  const output = reserveDir("shim-scaffold-");
  try {
    // stdin from /dev/null: the guided-setup prompts check `-t 0` first and skip on a
    // non-TTY, so this never blocks.
    execFileSync(
      "bash",
      [
        SCAFFOLD_SCRIPT,
        "--context",
        "employee",
        "--slug",
        "test-ws",
        "--owner",
        "tester",
        "--output",
        output,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    // `--no-such-command` is rejected by the real CLI, which is the point: reaching that
    // rejection proves the shim resolved and handed off. The old failure mode printed the
    // shim's own not-found error and never spawned anything.
    const out = runShimExpectingFailure(output);
    assert.doesNotMatch(
      out,
      NOT_FOUND,
      "the shim did not resolve the checkout it was stamped from"
    );
    assert.match(out, /unknown command/i);
  } finally {
    rmSync(output, discard);
  }
});

test("an explicit AIOS_TOOLKIT_DIR still wins over the stamp", () => {
  // Both resolve, so the assertion has to be about WHICH one ran, not whether anything did.
  // The env var points at a stub checkout that identifies itself; the stamp points at the
  // real one. Adding the stamp must not quietly demote what the operator configured.
  const stub = mkdtempSync(path.join(tmpdir(), "shim-stub-"));
  mkdirSync(path.join(stub, "scripts"));
  writeFileSync(path.join(stub, "scripts", "aios.mjs"), 'console.log("STUB_CHECKOUT_RAN");\n');
  const dir = fixtureWorkspace(`abc123\nsource ${ROOT}\n`);
  try {
    assert.match(runShim(dir, { AIOS_TOOLKIT_DIR: stub }), /STUB_CHECKOUT_RAN/);
  } finally {
    rmSync(dir, discard);
    rmSync(stub, discard);
  }
});

test("the stamp wins over the relative sibling guesses", () => {
  // The legacy guesses are `../aios-workspace` and friends. Build a workspace that sits
  // beside one, so both the stamp and a guess resolve, and confirm the stamp is preferred —
  // a recorded fact should beat a layout coincidence.
  const parent = mkdtempSync(path.join(tmpdir(), "shim-siblings-"));
  const sibling = path.join(parent, "aios-workspace");
  mkdirSync(path.join(sibling, "scripts"), { recursive: true });
  writeFileSync(path.join(sibling, "scripts", "aios.mjs"), 'console.log("GUESS_RAN");\n');

  const dir = path.join(parent, "workspace");
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  copyFileSync(SHIM, path.join(dir, "scripts", "aios.mjs"));
  writeFileSync(path.join(dir, ".aios-toolkit-version"), `abc123\nsource ${ROOT}\n`);

  try {
    const out = runShimExpectingFailure(dir);
    assert.doesNotMatch(out, /GUESS_RAN/, "a sibling-directory guess beat the recorded source");
    assert.match(out, /unknown command/i);
  } finally {
    rmSync(parent, discard);
  }
});

test("a stamp recording a clone URL falls through instead of resolving or crashing", () => {
  // `aios update` records a URL in `source` when it fell back to an ephemeral clone
  // (scripts/update.mjs resolveSource). That is not a path and must not be treated as one.
  const dir = fixtureWorkspace(`abc123\nsource https://github.com/aiosbrain/aios-workspace.git\n`);
  try {
    assert.match(runShimExpectingFailure(dir), NOT_FOUND);
  } finally {
    rmSync(dir, discard);
  }
});

test("a stamp pointing at a checkout that no longer exists falls through", () => {
  const dir = fixtureWorkspace(`abc123\nsource ${path.join(tmpdir(), "deleted-checkout")}\n`);
  try {
    assert.match(runShimExpectingFailure(dir), NOT_FOUND);
  } finally {
    rmSync(dir, discard);
  }
});

test("a missing or malformed stamp is a missing signal, not a crash", () => {
  for (const stamp of [undefined, "", "abc123\n", "\0\0\0not a stamp\n", "source\n"]) {
    const dir = fixtureWorkspace(stamp);
    try {
      const out = runShimExpectingFailure(dir);
      assert.match(out, NOT_FOUND, `stamp ${JSON.stringify(stamp)} should degrade cleanly`);
      assert.doesNotMatch(out, /Error:|ENOENT|Cannot read/, "the shim threw instead of degrading");
    } finally {
      rmSync(dir, discard);
    }
  }
});
