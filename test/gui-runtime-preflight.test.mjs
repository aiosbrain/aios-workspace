import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
