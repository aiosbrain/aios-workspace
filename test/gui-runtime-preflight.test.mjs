import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertGuiRuntimeReady,
  checkGuiRuntime,
  nativeClaudePackages,
} from "../scripts/gui-runtime-preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the installed GUI runtime resolves both SDKs and Claude's native executable", () => {
  const result = assertGuiRuntimeReady();
  assert.equal(result.ok, true);
  assert.match(result.executable, /claude(?:\.exe)?$/);
});

test("missing optional native package fails with the recovery command", () => {
  const result = checkGuiRuntime({
    platform: "darwin",
    arch: "arm64",
    resolve(specifier) {
      if (specifier.endsWith("/package.json")) throw new Error("not installed");
      return `/modules/${specifier}`;
    },
    access() {},
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["@anthropic-ai/claude-agent-sdk-darwin-arm64"]);

  assert.throws(
    () =>
      assertGuiRuntimeReady({
        platform: "darwin",
        arch: "arm64",
        resolve(specifier) {
          if (specifier.endsWith("/package.json")) throw new Error("not installed");
          return `/modules/${specifier}`;
        },
        access() {},
      }),
    /npm install --include=optional/
  );
});

test("Linux preflight accepts the matching libc package first", () => {
  assert.deepEqual(nativeClaudePackages({ platform: "linux", arch: "x64", musl: true }), [
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
    "@anthropic-ai/claude-agent-sdk-linux-x64",
  ]);
});

test("Linux libc fallback is verified by spawning the executable, not silently accepted", () => {
  // Only the alternate (glibc) package is installed on a musl-detected host.
  const opts = {
    platform: "linux",
    arch: "x64",
    musl: true,
    resolve(specifier) {
      if (specifier.includes("-musl/")) throw new Error("not installed");
      return `/modules/${specifier}`;
    },
    access() {},
  };

  // The fallback binary actually runs → accepted, with a warning.
  const warnings = [];
  const verified = checkGuiRuntime({
    ...opts,
    verify() {},
    warn: (message) => warnings.push(message),
  });
  assert.equal(verified.ok, true);
  assert.match(verified.executable, /claude-agent-sdk-linux-x64\/claude$/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fallback/);

  // The fallback binary cannot run (wrong libc) → not accepted, actionable error.
  const broken = checkGuiRuntime({
    ...opts,
    verify() {
      throw new Error("exec format error");
    },
    warn() {},
  });
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.missing, [
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl or @anthropic-ai/claude-agent-sdk-linux-x64",
  ]);

  // The matching libc package (first candidate) never needs spawn verification.
  const direct = checkGuiRuntime({
    ...opts,
    resolve: (specifier) => `/modules/${specifier}`,
    verify() {
      throw new Error("verify must not run for the detected libc match");
    },
    warn() {},
  });
  assert.equal(direct.ok, true);
  assert.match(direct.executable, /claude-agent-sdk-linux-x64-musl\/claude$/);
});

test("postinstall runs the preflight warn-only; GUI launch paths stay hard-fail", () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  // `npm install` must never hard-fail for CLI-only users on a missing GUI runtime.
  assert.match(manifest.scripts.postinstall, /gui-runtime-preflight\.mjs --warn-only/);
  // The GUI launch gate (app:dev/app:build via gui:preflight) keeps the hard failure.
  assert.equal(manifest.scripts["gui:preflight"], "node scripts/gui-runtime-preflight.mjs");
});

test("--warn-only reports a missing runtime without failing the install", () => {
  // A bare fixture with no node_modules: the preflight cannot resolve anything.
  // realpath matters: the run-as-main guard compares argv[1] against
  // import.meta.url, and macOS's tmpdir is a symlink (/var → /private/var).
  const fixture = mkdtempSync(path.join(realpathSync(tmpdir()), "aios-gui-preflight-warn-only-"));
  try {
    mkdirSync(path.join(fixture, "scripts"));
    copyFileSync(
      path.join(ROOT, "scripts/gui-runtime-preflight.mjs"),
      path.join(fixture, "scripts/gui-runtime-preflight.mjs")
    );
    const script = path.join(fixture, "scripts/gui-runtime-preflight.mjs");
    const run = (args, env = {}) =>
      spawnSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });

    // Strict mode (GUI launch paths): missing runtime is a hard failure.
    const strict = run([]);
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /GUI runtime is incomplete/);

    // Warn-only mode (postinstall): the same diagnostic, but exit 0.
    const viaFlag = run(["--warn-only"]);
    assert.equal(viaFlag.status, 0);
    assert.match(viaFlag.stderr, /GUI runtime is incomplete/);
    assert.match(viaFlag.stderr, /aios CLI works without the GUI runtime/);

    const viaEnv = run([], { AIOS_GUI_PREFLIGHT_WARN_ONLY: "1" });
    assert.equal(viaEnv.status, 0);
    assert.match(viaEnv.stderr, /GUI runtime is incomplete/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("runtime SDKs are production dependencies at both workspace boundaries", () => {
  const root = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const server = JSON.parse(readFileSync(path.join(ROOT, "gui/server/package.json"), "utf8"));
  for (const dependency of ["@anthropic-ai/sdk", "@anthropic-ai/claude-agent-sdk"]) {
    assert.ok(root.dependencies[dependency], `${dependency} must ship with the toolkit runtime`);
    assert.equal(root.devDependencies[dependency], undefined);
    assert.ok(
      server.dependencies[dependency],
      `${dependency} must be direct at the GUI server boundary`
    );
  }
});

test("non-relay CLI commands do not eagerly import the relay SDK boundary", () => {
  const source = readFileSync(path.join(ROOT, "scripts/aios.mjs"), "utf8");
  assert.doesNotMatch(source, /^import .*cmdRelay.*relay\.mjs/m);
  assert.match(source, /await import\("\.\/relay\.mjs"\)/);
});
