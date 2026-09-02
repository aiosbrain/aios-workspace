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
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SCRIPT = path.join(ROOT, "scripts", "scaffold-project.sh");
const SHIM = path.join(ROOT, "scaffold", "scripts", "aios.mjs");
const NOT_FOUND = /no AIOS CLI found/;
// The v2 shim's step 4 resolves a PATH-installed `aios` (AIO-635 Decision 2), so the
// not-found fixtures must run under a PATH that has node but no `aios`. The real node
// bin dir can't be used directly — global installs (nvm) put `aios` RIGHT BESIDE node —
// so build a synthetic bin dir holding only a `node` symlink.
const NODE_ONLY_PATH = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "shim-nodeonly-"));
  symlinkSync(process.execPath, path.join(dir, "node"));
  return dir;
})();

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
    {
      env: { ...rest, PATH: NODE_ONLY_PATH, ...env },
      encoding: "utf8",
      stdio: "pipe",
      cwd: tmpdir(),
    }
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

test("a stamp recording a clone URL falls through even when its resolved path collides", () => {
  // `aios update` records a URL in `source` when it fell back to an ephemeral clone
  // (scripts/update.mjs resolveSource). A URL is not a path and must not be treated as one,
  // even if resolve(workspaceRoot, source) happens to name an executable local file.
  const dir = fixtureWorkspace(`abc123\nsource https://github.com/aiosbrain/aios-workspace.git\n`);
  const collision = path.join(
    dir,
    "https:",
    "github.com",
    "aiosbrain",
    "aios-workspace.git",
    "scripts"
  );
  mkdirSync(collision, { recursive: true });
  writeFileSync(path.join(collision, "aios.mjs"), 'console.log("URL_COLLISION_RAN");\n');
  try {
    const out = runShimExpectingFailure(dir);
    assert.match(out, NOT_FOUND);
    assert.doesNotMatch(out, /URL_COLLISION_RAN/);
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

test("a configured entrypoint pointing back to the shim fails instead of recursing", () => {
  const dir = fixtureWorkspace();
  const shim = path.join(dir, "scripts", "aios.mjs");
  const recursionGuard = path.join(dir, "recursion-guard.cjs");
  writeFileSync(
    recursionGuard,
    [
      'const depth = Number(process.env.AIOS_SHIM_TEST_DEPTH ?? "0");',
      'if (depth > 0) { console.error("SELF_RECURSION_RAN"); process.exit(97); }',
      'process.env.AIOS_SHIM_TEST_DEPTH = "1";',
    ].join("\n")
  );

  try {
    const out = runShimExpectingFailure(dir, {
      AIOS_TOOLKIT_CLI: shim,
      NODE_OPTIONS: `--require=${recursionGuard}`,
    });
    assert.match(out, NOT_FOUND);
    assert.doesNotMatch(out, /SELF_RECURSION_RAN/);
  } finally {
    rmSync(dir, discard);
  }
});

// ── AIO-635 Decision 2: PATH-installed `aios` resolution ─────────────────────────────

/** A fake `aios` binary on its own PATH dir; records argv + exits with `status`. */
function fakeAiosOnPath(status = 0) {
  const binDir = mkdtempSync(path.join(tmpdir(), "shim-pathbin-"));
  const log = path.join(binDir, "invocation.log");
  const bin = path.join(binDir, "aios");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\nexit ${status}\n`);
  chmodSync(bin, 0o755);
  return { binDir, bin, log };
}

test("with a stub aios on PATH and no checkout, the shim execs it with --repo appended and preserves exit status", () => {
  const { binDir, log } = fakeAiosOnPath(7);
  const dir = fixtureWorkspace(`abc123\nsource pkg:@aiosbrain/aios@2.0.0\n`);
  try {
    let status = 0;
    let stderr = "";
    let stdout = "";
    try {
      stdout = runShim(dir, { PATH: `${binDir}${path.delimiter}${NODE_ONLY_PATH}` });
    } catch (e) {
      status = e.status;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }
    assert.equal(status, 7, "the child's exit status is preserved");
    const argv = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(argv[0], "--no-such-command");
    assert.equal(argv[argv.length - 2], "--repo");
    assert.equal(
      realpathSync(argv[argv.length - 1]),
      realpathSync(dir),
      "--repo <workspaceRoot> appended exactly as before"
    );
    assert.equal(stdout, "", "shim adds no stdout bytes of its own");
    assert.doesNotMatch(stderr, NOT_FOUND);
  } finally {
    rmSync(dir, discard);
    rmSync(binDir, discard);
  }
});

test("a PATH hit whose realpath lies under the workspace root is rejected (no self-exec)", () => {
  const dir = fixtureWorkspace(`abc123\nsource pkg:@aiosbrain/aios@2.0.0\n`);
  // A bin dir entry that is a symlink back into the workspace (npm-stub shape).
  const binDir = mkdtempSync(path.join(tmpdir(), "shim-pathself-"));
  const inWorkspace = path.join(dir, "bin-aios");
  writeFileSync(inWorkspace, "#!/bin/sh\necho IN_WORKSPACE_RAN\n");
  chmodSync(inWorkspace, 0o755);
  symlinkSync(inWorkspace, path.join(binDir, "aios"));
  try {
    const out = runShimExpectingFailure(dir, {
      PATH: `${binDir}${path.delimiter}${NODE_ONLY_PATH}`,
    });
    assert.doesNotMatch(out, /IN_WORKSPACE_RAN/, "a workspace-contained realpath must not exec");
    assert.match(out, NOT_FOUND);
  } finally {
    rmSync(dir, discard);
    rmSync(binDir, discard);
  }
});

test("a checkout-path stamp still wins over a PATH-installed aios", () => {
  const { binDir, log } = fakeAiosOnPath(0);
  const dir = fixtureWorkspace(`abc123\nsource ${ROOT}\n`);
  try {
    const out = runShimExpectingFailure(dir, {
      PATH: `${binDir}${path.delimiter}${NODE_ONLY_PATH}`,
    });
    assert.match(out, /unknown command/i, "the recorded checkout ran, not the PATH stub");
    assert.ok(!existsSync(log), "the PATH stub was never invoked");
  } finally {
    rmSync(dir, discard);
    rmSync(binDir, discard);
  }
});

test("AIOS_TOOLKIT_DIR set but invalid is a hard error — never a silent fall-through to PATH", () => {
  const { binDir, log } = fakeAiosOnPath(0);
  const dir = fixtureWorkspace(`abc123\nsource ${ROOT}\n`);
  const bogus = path.join(tmpdir(), "no-such-toolkit-dir");
  try {
    const out = runShimExpectingFailure(dir, {
      AIOS_TOOLKIT_DIR: bogus,
      PATH: `${binDir}${path.delimiter}${NODE_ONLY_PATH}`,
    });
    assert.match(out, /AIOS_TOOLKIT_DIR/, "the error names the explicit source");
    assert.ok(!existsSync(log), "nothing else was executed after the explicit-source error");
  } finally {
    rmSync(dir, discard);
    rmSync(binDir, discard);
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
