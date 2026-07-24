import assert from "node:assert/strict";
import test from "node:test";
import {
  commandAvailable,
  missingRustPrerequisite,
  runRustTests,
} from "../scripts/run-rust-tests.mjs";

test("command availability handles present and missing executables", () => {
  assert.equal(commandAvailable(process.execPath, ["--version"]), true);
  assert.equal(commandAvailable("aios-command-that-does-not-exist", ["--version"]), false);
});

test("Rust test prerequisites distinguish local toolchain and Linux library gaps", () => {
  assert.equal(
    missingRustPrerequisite({ platform: "darwin", hasCargo: false, hasLinuxLibraries: false }),
    "cargo is not installed"
  );
  assert.equal(
    missingRustPrerequisite({ platform: "linux", hasCargo: true, hasLinuxLibraries: false }),
    "Tauri Linux development libraries are not installed"
  );
  assert.equal(
    missingRustPrerequisite({ platform: "linux", hasCargo: true, hasLinuxLibraries: true }),
    null
  );
  assert.equal(
    missingRustPrerequisite({ platform: "darwin", hasCargo: true, hasLinuxLibraries: false }),
    null
  );
});

test("local Rust prerequisite gaps skip visibly while required environments fail", () => {
  const warnings = [];
  runRustTests({
    required: false,
    missing: "cargo is not installed",
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(warnings, [
    "rust-tests: cargo is not installed; skipping locally (CI still requires this lane)",
  ]);
  assert.throws(
    () => runRustTests({ required: true, missing: "cargo is not installed" }),
    /this environment requires Rust tests/
  );
});

test("Rust test runner builds the GUI before invoking the locked Cargo suite", () => {
  const calls = [];
  runRustTests({
    required: true,
    missing: null,
    execute: (command, args) => calls.push([command, args]),
  });
  assert.deepEqual(calls, [
    ["npm", ["run", "gui:build"]],
    ["cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--locked"]],
  ]);
});
