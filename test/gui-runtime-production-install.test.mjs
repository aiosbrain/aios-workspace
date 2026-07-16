import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test(
  "a clean production install includes both GUI SDKs and Claude's native executable",
  { timeout: 120_000 },
  () => {
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
      const output = execFileSync(process.execPath, ["scripts/gui-runtime-preflight.mjs"], {
        cwd: fixture,
        encoding: "utf8",
      });
      assert.match(output, /GUI runtime ready/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
);
