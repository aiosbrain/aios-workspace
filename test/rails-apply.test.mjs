// test/rails-apply.test.mjs — the apply-safety invariant (EE7 / AIO-173): merging an
// allowlist must NOT disable guard hooks, must never write a denylisted command, and
// must preserve every non-`permissions.allow` key. Plus a LIVE guard invocation proving
// the PreToolUse guard still blocks a secret after apply.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeAllow } from "../scripts/rails.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const GUARD = path.join(REPO, "hooks", "team-ops-guard.sh");
const FIXTURE_DIR = path.join(DIR, "fixtures", "rails");

// A settings.json with a real PreToolUse guard hook + a pre-existing allowlist entry
// and a deny entry — the shape a client repo would already have.
function seedSettings(repo) {
  const claude = path.join(repo, ".claude");
  mkdirSync(claude, { recursive: true });
  const settings = {
    permissions: { allow: ["Bash(echo:*)"], deny: ["Bash(rm:*)"] },
    hooks: {
      PreToolUse: [
        {
          matcher: "Write|Edit|MultiEdit",
          hooks: [{ type: "command", command: GUARD }],
        },
      ],
    },
    model: "opus",
  };
  const p = path.join(claude, "settings.json");
  writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
  return p;
}

test("mergeAllow dedupes + sorts and leaves hooks / deny / other keys untouched", () => {
  const before = {
    permissions: { allow: ["Bash(echo:*)"], deny: ["Bash(rm:*)"] },
    hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "/x.sh" }] }] },
    model: "opus",
  };
  const after = mergeAllow(before, ["Bash(npm test:*)", "Bash(echo:*)"]);
  assert.deepEqual(after.permissions.allow, ["Bash(echo:*)", "Bash(npm test:*)"]);
  assert.deepEqual(after.permissions.deny, ["Bash(rm:*)"]); // untouched
  assert.equal(after.model, "opus"); // untouched
  // hooks subtree byte-identical.
  assert.equal(JSON.stringify(after.hooks, null, 2), JSON.stringify(before.hooks, null, 2));
});

test("rails apply --dry-run writes nothing", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "rails-apply-dry-"));
  try {
    const sp = seedSettings(tmp);
    const before = readFileSync(sp, "utf8");
    const r = spawnSync(
      process.execPath,
      [AIOS, "rails", "apply", "--repo", tmp, "--transcripts-dir", FIXTURE_DIR, "--dry-run"],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\+Bash\(npm test:\*\)/); // diff shown
    assert.equal(readFileSync(sp, "utf8"), before); // unchanged
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rails apply writes the allowlist AND preserves the guard hook byte-identically", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "rails-apply-"));
  try {
    const sp = seedSettings(tmp);
    const before = JSON.parse(readFileSync(sp, "utf8"));

    const r = spawnSync(
      process.execPath,
      [AIOS, "rails", "apply", "--repo", tmp, "--transcripts-dir", FIXTURE_DIR],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 0, r.stderr);

    const after = JSON.parse(readFileSync(sp, "utf8"));
    // allowlist grew with the safe proposals, pre-existing entry retained.
    assert.ok(after.permissions.allow.includes("Bash(echo:*)"));
    assert.ok(after.permissions.allow.includes("Bash(npm test:*)"));
    assert.ok(after.permissions.allow.includes("Bash(git status:*)"));
    // NO denylisted command ever written.
    assert.ok(!after.permissions.allow.some((e) => /rm|\.env|push/i.test(e)));
    // deny + model untouched.
    assert.deepEqual(after.permissions.deny, before.permissions.deny);
    assert.equal(after.model, before.model);
    // guard hook byte-identical.
    assert.equal(
      JSON.stringify(after.hooks, null, 2),
      JSON.stringify(before.hooks, null, 2),
      "hooks section must be byte-identical after apply"
    );

    // LIVE proof the guard still fires: feed it a secret-bearing Write payload → blocked (exit 2).
    // The fake AWS-key literal is assembled at runtime so it isn't a static match in this file
    // (the secrets gate scans source); the guard still sees the full string on stdin.
    const fakeKey = "AKIA" + "IOSFODNN7EXAMPLE";
    const payload = JSON.stringify({
      tool_name: "Write",
      tool_input: {
        file_path: path.join(tmp, "2-work", "leak.md"),
        content: `aws key ${fakeKey} embedded`,
      },
    });
    const guard = spawnSync("bash", [after.hooks.PreToolUse[0].hooks[0].command], {
      input: payload,
      encoding: "utf8",
    });
    assert.equal(guard.status, 2, `guard must block secret write (exit 2): ${guard.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rails apply creates settings.json when absent (bare repo)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "rails-apply-bare-"));
  try {
    const r = spawnSync(
      process.execPath,
      [AIOS, "rails", "apply", "--repo", tmp, "--transcripts-dir", FIXTURE_DIR],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
    assert.ok(s.permissions.allow.includes("Bash(npm test:*)"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
