#!/usr/bin/env node
// Verify dependencies that the local GUI needs at runtime. The Claude Agent SDK ships its
// executable as an optional, platform-specific package, so resolving the JavaScript package
// alone is not enough to prove Chat can start.
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

export function checkGuiRuntime({
  resolve = require.resolve,
  access = accessSync,
  platform = process.platform,
  arch = process.arch,
  musl = isMusl(),
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
  for (const packageName of candidates) {
    try {
      const manifest = resolve(`${packageName}/package.json`);
      const candidate = path.join(
        path.dirname(manifest),
        platform === "win32" ? "claude.exe" : "claude"
      );
      access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
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
  try {
    const result = assertGuiRuntimeReady();
    if (!process.env.CI) console.log(`✓ GUI runtime ready (${result.executable})`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
