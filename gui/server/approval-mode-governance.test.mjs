import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowedApprovalModeIds, claudeApprovalModes } from "../../scripts/runtimes.mjs";

// Governance regression for the composer approval-mode selector (AIO-116).
//
// The hard guarantee: the PreToolUse guard hook (team-ops-guard.sh) is the enforcement
// layer for secrets + access-tier, and it runs INDEPENDENT of the SDK permission prompt —
// switching approval mode (default/acceptEdits) changes whether the user is *prompted*,
// never whether the guard fires. This test proves (1) the guard hook actually blocks a
// secret / wrong-tier write, for every approval mode we expose, and (2) "Full access"
// (bypassPermissions) is NOT exposed by default — it stays behind an env flag until a live
// SDK regression proves the guard still fires under it.
//
// Fixtures that resemble secrets / sensitive terms are assembled at runtime so this source
// file never carries a literal match (keeps the NDA + secret gates clean).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const GUARD = path.join(ROOT, "hooks", "team-ops-guard.sh");

const FRONTMATTER = "---\nstatus: draft\nowner: test\n---\n";

function runGuard(toolInput) {
  const payload = JSON.stringify({ tool_name: "Write", tool_input: toolInput });
  return spawnSync("bash", [GUARD], { input: payload, encoding: "utf8" });
}

// A fake AWS-style key, built so the literal never appears in source (AKIA + 16 uppercase).
const FAKE_SECRET = "AKIA" + "ABCDEFGHIJKLMNOP";
// An access-tier-restricted phrase, assembled at runtime.
const SENSITIVE_PHRASE = "our " + "day" + " rate is high";

const EXPOSED_MODES = [...allowedApprovalModeIds()];

test("only default + acceptEdits are exposed by default; bypassPermissions is withheld", () => {
  assert.ok(!allowedApprovalModeIds().has("bypassPermissions"), "Full access must be gated off");
  assert.deepEqual([...EXPOSED_MODES].sort(), ["acceptEdits", "default"]);
});

// The guard runs as a separate PreToolUse process, so its verdict does not depend on the
// approval mode. We assert per-mode anyway to pin the invariant: if a future mode somehow
// disabled the guard, this matrix would have to be revisited.
for (const mode of EXPOSED_MODES) {
  test(`[${mode}] guard BLOCKS a secret-bearing write (exit 2)`, () => {
    const r = runGuard({ file_path: "2-work/notes.md", content: FRONTMATTER + FAKE_SECRET });
    assert.equal(r.status, 2, `expected block; stderr: ${r.stderr}`);
    assert.match(r.stderr, /secret/i);
  });

  test(`[${mode}] guard BLOCKS admin-tier content in a shared dir (exit 2)`, () => {
    const r = runGuard({
      file_path: "4-shared/proposal.md",
      content: FRONTMATTER + SENSITIVE_PHRASE,
    });
    assert.equal(r.status, 2, `expected block; stderr: ${r.stderr}`);
    assert.match(r.stderr, /Admin-only|admin-tier/i);
  });
}

test("guard ALLOWS a clean team write (exit 0)", () => {
  const r = runGuard({ file_path: "2-work/notes.md", content: FRONTMATTER + "Plain team notes." });
  assert.equal(r.status, 0, `expected allow; stderr: ${r.stderr}`);
});

test("Full access becomes advertised only when explicitly enabled (documents the gate)", () => {
  const prev = process.env.AIOS_GUI_ALLOW_FULL_ACCESS;
  process.env.AIOS_GUI_ALLOW_FULL_ACCESS = "1";
  try {
    assert.ok(
      claudeApprovalModes().some((m) => m.id === "bypassPermissions"),
      "the env flag is the only way to expose Full access"
    );
  } finally {
    if (prev === undefined) delete process.env.AIOS_GUI_ALLOW_FULL_ACCESS;
    else process.env.AIOS_GUI_ALLOW_FULL_ACCESS = prev;
  }
});
