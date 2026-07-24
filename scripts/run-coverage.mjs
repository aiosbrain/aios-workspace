#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const C8 = path.join(ROOT, "node_modules", "c8", "bin", "c8.js");
const tempDirectory = mkdtempSync(path.join(tmpdir(), "aios-c8-"));

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} exited ${signal ? `with ${signal}` : `with status ${code}`}`));
    });
  });
}

try {
  rmSync(path.join(ROOT, "coverage"), { recursive: true, force: true });
  rmSync(path.join(ROOT, "gui", "client", "coverage"), { recursive: true, force: true });

  // Keep the independently configured reports separate and deterministic.
  // Client coverage is sub-second; sequencing it avoids future port/fixture
  // conflicts if browser tests grow integration coverage.
  await execute("npm", ["run", "test:coverage", "--workspace", "gui/client"]);
  await execute(process.execPath, [
    C8,
    "--temp-directory",
    tempDirectory,
    process.execPath,
    "scripts/test-suite.mjs",
    "--concurrency=4",
  ]);
  await execute(process.execPath, ["scripts/merge-coverage.mjs"]);
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
