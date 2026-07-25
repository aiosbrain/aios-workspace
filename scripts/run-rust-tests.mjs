#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = process.env.AIOS_REQUIRE_RUST_TESTS === "1";

export function commandAvailable(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

export function missingRustPrerequisite({
  platform = process.platform,
  hasCargo = commandAvailable("cargo", ["--version"]),
  hasLinuxLibraries = commandAvailable("pkg-config", [
    "--exists",
    "glib-2.0",
    "gtk+-3.0",
    "webkit2gtk-4.1",
  ]),
} = {}) {
  if (!hasCargo) return "cargo is not installed";
  if (platform === "linux" && !hasLinuxLibraries) {
    return "Tauri Linux development libraries are not installed";
  }
  return null;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

export function runRustTests({
  required = REQUIRED,
  missing = missingRustPrerequisite(),
  execute = run,
  warn = console.warn,
} = {}) {
  if (missing) {
    const message =
      `rust-tests: ${missing}; ` +
      (required
        ? "this environment requires Rust tests"
        : "skipping locally (CI still requires this lane)");
    if (required) throw new Error(message);
    warn(message);
    return;
  }
  execute("npm", ["run", "gui:build"]);
  execute("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--locked"]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runRustTests();
  } catch (error) {
    console.error(`rust-tests: ${error.message}`);
    process.exitCode = 1;
  }
}
