import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SCRIPT = path.join(ROOT, "scripts", "scaffold-project.sh");

function scaffold(output, extraArgs = []) {
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
      ...extraArgs,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
}

function freshOutput(prefix) {
  const output = mkdtempSync(path.join(tmpdir(), prefix));
  rmSync(output, { recursive: true, force: true });
  return output;
}

test("non-interactive scaffold leaves Brain CI disabled unless explicitly selected", () => {
  const output = freshOutput("scaffold-ci-default-");
  try {
    scaffold(output);
    assert.match(readFileSync(path.join(output, "aios.yaml"), "utf8"), /^ci_workflow: false$/m);
    assert.equal(existsSync(path.join(output, ".github/workflows/scan-on-merge.yml")), false);
    assert.equal(existsSync(path.join(output, ".github/scripts/fetch-brain-scanner.sh")), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("--with-ci-workflow records consent and stamps all Brain CI files", () => {
  const output = freshOutput("scaffold-ci-enabled-");
  try {
    scaffold(output, ["--with-ci-workflow"]);
    assert.match(readFileSync(path.join(output, "aios.yaml"), "utf8"), /^ci_workflow: true$/m);
    for (const file of [
      ".github/workflows/scan-on-merge.yml",
      ".github/scripts/fetch-brain-scanner.sh",
      ".github/scripts/scan_with_health.py",
    ]) {
      assert.equal(existsSync(path.join(output, file)), true, `${file} is stamped when enabled`);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
