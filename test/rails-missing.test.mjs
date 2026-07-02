// test/rails-missing.test.mjs — the missing-rails backlog (EE7 / AIO-173): reuses
// assess-codebase scoring for the rubric-derived rails and adds the AIOS-native probes
// (allowlist / guard hooks / leak gate). A bare repo should list them all; a repo with
// rails installed should list none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { missingRails } from "../scripts/rails.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");

test("bare repo lists the core absent rails", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "rails-missing-bare-"));
  try {
    writeFileSync(path.join(tmp, "README.md"), "# bare\n"); // repo-root marker
    const report = missingRails(tmp);
    const ids = report.missing.map((m) => m.id);
    for (const id of ["claude_md", "guard_hooks", "allowlist", "leak_gate"]) {
      assert.ok(ids.includes(id), `expected missing rail: ${id} (got ${ids.join(",")})`);
    }
    // every item carries a how-to pointer.
    assert.ok(report.missing.every((m) => typeof m.how === "string" && m.how.length));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a repo with rails installed lists neither allowlist nor guard hooks as missing", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "rails-missing-full-"));
  try {
    writeFileSync(path.join(tmp, "README.md"), "# repo\n");
    writeFileSync(path.join(tmp, "CLAUDE.md"), "x".repeat(600));
    mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(npm test:*)"] },
        hooks: {
          PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "/g.sh" }] }],
        },
      })
    );
    const ids = missingRails(tmp).missing.map((m) => m.id);
    assert.ok(!ids.includes("allowlist"));
    assert.ok(!ids.includes("guard_hooks"));
    assert.ok(!ids.includes("claude_md"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: `aios rails missing --json` on a bare repo", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "rails-missing-cli-"));
  try {
    writeFileSync(path.join(tmp, "README.md"), "# bare\n");
    const r = spawnSync(process.execPath, [AIOS, "rails", "missing", "--repo", tmp, "--json"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(Array.isArray(out.missing) && out.missing.length > 0);
    assert.ok(out.missing.some((m) => m.id === "allowlist"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
