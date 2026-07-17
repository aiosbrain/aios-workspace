import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// This test performs a REAL `npm install` against the live registry (~30s, network-dependent).
// Locally that makes every `npm test` run fail offline or on a registry hiccup, so it only runs
// where the coverage matters: CI (GitHub Actions sets CI=true) or an explicit opt-in.
const LIVE_INSTALL = Boolean(process.env.CI) || process.env.AIOS_LIVE_INSTALL_TESTS === "1";

test(
  "a clean production install includes both GUI SDKs and Claude's native executable",
  {
    timeout: 120_000,
    skip: LIVE_INSTALL
      ? false
      : "live npm-registry install — runs in CI; set AIOS_LIVE_INSTALL_TESTS=1 to run locally",
  },
  async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "aios-gui-production-install-"));
    try {
      const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
      const dependencies = Object.fromEntries(
        ["@anthropic-ai/sdk", "@anthropic-ai/claude-agent-sdk"].map((name) => [
          name,
          manifest.dependencies[name],
        ])
      );
      writeFileSync(
        path.join(fixture, "package.json"),
        `${JSON.stringify({ private: true, type: "module", dependencies }, null, 2)}\n`
      );
      mkdirSync(path.join(fixture, "scripts"));
      copyFileSync(
        path.join(ROOT, "scripts/gui-runtime-preflight.mjs"),
        path.join(fixture, "scripts/gui-runtime-preflight.mjs")
      );

      execFileSync(
        "npm",
        ["install", "--omit=dev", "--include=optional", "--ignore-scripts", "--no-audit"],
        { cwd: fixture, stdio: "ignore" }
      );
      const { assertGuiRuntimeReady } = await import(
        pathToFileURL(path.join(fixture, "scripts/gui-runtime-preflight.mjs"))
      );
      const result = assertGuiRuntimeReady();
      assert.equal(result.ok, true);
      assert.ok(
        realpathSync(result.executable).startsWith(
          realpathSync(path.join(fixture, "node_modules"))
        ),
        "the native executable must come from the clean production fixture"
      );
      assert.match(result.executable, /claude(?:\.exe)?$/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
);
