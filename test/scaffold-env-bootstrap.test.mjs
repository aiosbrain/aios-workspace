// A real `scaffold-project.sh` run (not --dry-run, which skips file writes) into a temp
// dir must leave a `.env` on disk — dotenvx's `run --` (used by `npm run gui` and the
// Tauri app) refuses to start at all if `.env` is missing, even before any real secret is
// ever set. This regression-guards the MISSING_ENV_FILE crash a scaffold-then-
// immediately-run-gui flow used to hit.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SCRIPT = path.join(ROOT, "scripts", "scaffold-project.sh");

function scaffold(output) {
  // stdin from /dev/null: the script's guided-setup/shell-install prompts read `-t 0`
  // first and skip entirely on a non-TTY, so this never blocks or needs answers.
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
    {
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
}

test("a real scaffold run creates .env (not just .env.example)", () => {
  const output = mkdtempSync(path.join(tmpdir(), "scaffold-env-"));
  rmSync(output, { recursive: true, force: true }); // scaffold refuses a non-empty existing dir
  try {
    scaffold(output);
    assert.equal(existsSync(path.join(output, ".env")), true);
    assert.equal(existsSync(path.join(output, ".env.example")), true);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("dotenvx run does not crash with MISSING_ENV_FILE against the scaffolded .env", () => {
  const output = mkdtempSync(path.join(tmpdir(), "scaffold-env-"));
  rmSync(output, { recursive: true, force: true });
  try {
    scaffold(output);
    const envPath = path.join(output, ".env");
    // Throws if dotenvx can't find .env; a MISSING_ENV_FILE crash would throw here.
    assert.doesNotThrow(() => {
      execFileSync("dotenvx", ["run", "-f", envPath, "--", "true"], { stdio: "pipe" });
    });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
