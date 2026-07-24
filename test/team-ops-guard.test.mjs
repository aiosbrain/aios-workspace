import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_HOOK = path.join(REPO, "hooks", "team-ops-guard.sh");

test("standalone fallback blocks a fine-grained GitHub token in MultiEdit", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "aios-standalone-guard-"));
  try {
    const hooksDir = path.join(workspace, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, "team-ops-guard.sh");
    copyFileSync(SOURCE_HOOK, hook);

    const token = ["github", "pat", "A".repeat(30)].join("_");
    const payload = {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "2-work/report.md",
        edits: [{ old_string: "before", new_string: `credential=${token}` }],
      },
    };
    const result = spawnSync("bash", [hook], {
      cwd: workspace,
      input: JSON.stringify(payload),
      encoding: "utf8",
    });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Potential secret detected/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("standalone fallback blocks Basic Auth credentials containing the letter s", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "aios-standalone-guard-"));
  try {
    const hooksDir = path.join(workspace, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, "team-ops-guard.sh");
    copyFileSync(SOURCE_HOOK, hook);

    const basicAuthUrl = ["https://alice", "pass", "host"].join(":").replace(":host", "@host");
    const payload = {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "2-work/report.md",
        edits: [{ old_string: "before", new_string: `endpoint=${basicAuthUrl}` }],
      },
    };
    const result = spawnSync("bash", [hook], {
      cwd: workspace,
      input: JSON.stringify(payload),
      encoding: "utf8",
    });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Potential secret detected/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
