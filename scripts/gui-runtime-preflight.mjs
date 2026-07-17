#!/usr/bin/env node
// Verify dependencies that the local GUI needs at runtime. The Claude Agent SDK ships its
// executable as an optional, platform-specific package, so resolving the JavaScript package
// alone is not enough to prove Chat can start.
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function isMusl(report = process.report?.getReport?.()) {
  return process.platform === "linux" && !report?.header?.glibcVersionRuntime;
}

export function nativeClaudePackages({
  platform = process.platform,
  arch = process.arch,
  musl = isMusl(),
} = {}) {
  const supported = new Set([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ]);
  const target = `${platform}-${arch}`;
  if (!supported.has(target)) return [];

  const base = `@anthropic-ai/claude-agent-sdk-${target}`;
  if (platform !== "linux") return [base];
  // npm normally installs the libc-specific package. Accept the other candidate as a fallback
  // because libc detection is not available in every embedded Node runtime.
  return musl ? [`${base}-musl`, base] : [base, `${base}-musl`];
}

function spawnClaudeVersion(executable) {
  const result = spawnSync(executable, ["--version"], { stdio: "ignore", timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`\`claude --version\` exited with ${result.status}`);
}

export function checkGuiRuntime({
  resolve = require.resolve,
  access = accessSync,
  platform = process.platform,
  arch = process.arch,
  musl = isMusl(),
  verify = spawnClaudeVersion,
  warn = (message) => console.warn(message),
} = {}) {
  const missing = [];
  for (const dependency of ["@anthropic-ai/sdk", "@anthropic-ai/claude-agent-sdk"]) {
    try {
      resolve(dependency);
    } catch {
      missing.push(dependency);
    }
  }

  const candidates = nativeClaudePackages({ platform, arch, musl });
  let executable = null;
  for (const [index, packageName] of candidates.entries()) {
    try {
      const manifest = resolve(`${packageName}/package.json`);
      const candidate = path.join(
        path.dirname(manifest),
        platform === "win32" ? "claude.exe" : "claude"
      );
      access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      if (platform === "linux" && index > 0) {
        // The alternate libc variant is a fallback, not the detected match — never
        // silently accept it. Prove it can actually run before reporting ready.
        verify(candidate);
        warn(
          `gui preflight: libc detection preferred ${candidates[0]}, but only ${packageName} is ` +
            `installed; \`claude --version\` ran successfully, so accepting it as a fallback.`
        );
      }
      executable = candidate;
      break;
    } catch {
      // Try the alternate libc package before reporting one actionable error.
    }
  }

  if (candidates.length === 0) {
    missing.push(`Claude native executable for unsupported ${platform}-${arch}`);
  } else if (!executable) {
    missing.push(candidates.join(" or "));
  }

  return { ok: missing.length === 0, missing, executable };
}

export function assertGuiRuntimeReady(options) {
  const result = checkGuiRuntime(options);
  if (result.ok) return result;

  throw new Error(
    [
      "AIOS GUI runtime is incomplete.",
      `Missing: ${result.missing.join(", ")}.`,
      "Run `npm install --include=optional` in the AIOS toolkit, then launch the GUI again.",
      "Do not install the toolkit with `--omit=optional`; Chat requires Claude's native executable.",
    ].join(" ")
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `--warn-only` (postinstall) diagnoses without failing the install: the CLI
  // (`aios push`/`pull`/…) needs none of the GUI runtime, so a missing optional
  // SDK binary must never make the whole toolkit uninstallable. The GUI launch
  // paths (run-gui.mjs, app:dev/app:build via `gui:preflight`) stay hard-fail.
  const warnOnly =
    process.argv.includes("--warn-only") || process.env.AIOS_GUI_PREFLIGHT_WARN_ONLY === "1";
  try {
    const result = assertGuiRuntimeReady();
    if (!process.env.CI) console.log(`✓ GUI runtime ready (${result.executable})`);
  } catch (error) {
    if (warnOnly) {
      console.warn(`⚠ ${error.message}`);
      console.warn(
        "Continuing anyway: the aios CLI works without the GUI runtime; only Chat (GUI) needs it."
      );
    } else {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
