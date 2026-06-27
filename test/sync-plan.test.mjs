import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Sync safety: the push plan must fail closed on access tiers.
 *
 * `buildPlan` (scripts/aios.mjs) is the safety-critical gate that decides what may leave the
 * machine — the CLAUDE.md §3 invariant: admin never syncs, content with no `access:` is
 * default-denied, and a tier outside `sync_tiers` is blocked. This drives it through the real
 * CLI (`aios status --json`, offline) against a throwaway workspace and asserts the observable
 * outcome (the blocked list + reasons), so a regression that silently lets blocked content
 * become pushable fails the build. Matches the server's 422 rejection documented in brain-api.md.
 */

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");

function fm(fields, title = "x") {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n# ${title}\n`;
}

function makeWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-syncplan-"));
  mkdirSync(path.join(dir, "2-work"), { recursive: true });
  writeFileSync(
    path.join(dir, "aios.yaml"),
    ["version: 1", 'brain_url: ""', "sync_tiers:", "  - team", "sync_include:", "  - 2-work"].join(
      "\n"
    ) + "\n"
  );
  const w = (name, content) => writeFileSync(path.join(dir, "2-work", name), content);
  // default-deny: frontmatter present but no `access:`
  w("no-access.md", fm({ status: "draft", owner: "alex" }, "no access"));
  // admin (friendly alias `private` normalizes to admin) — must never sync
  w("admin.md", fm({ status: "draft", owner: "alex", access: "private" }, "admin"));
  // external (friendly alias `client`) is a valid tier but not in sync_tiers [team]
  w("external.md", fm({ status: "final", owner: "alex", access: "client" }, "external"));
  // positive control: team-tier file IS eligible (proves the gate isn't blocking everything)
  w("team-ok.md", fm({ status: "final", owner: "alex", access: "team" }, "team ok"));
  return dir;
}

function planFor(dir) {
  const out = execFileSync("node", [AIOS, "status", "--json", "--repo", dir], {
    cwd: REPO,
    encoding: "utf8",
  });
  const jsonLine = out
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  assert.ok(jsonLine, `no JSON line in output:\n${out}`);
  return JSON.parse(jsonLine).items;
}

test("push plan fails closed on access tiers (admin / default-deny / sync_tiers)", () => {
  const dir = makeWorkspace();
  try {
    const items = planFor(dir);
    const reasonFor = (rel) => items.blocked.find((b) => b.rel === `2-work/${rel}`)?.reason;

    // admin content never syncs — even via the friendly `private` alias
    assert.match(reasonFor("admin.md") ?? "", /admin.*never syncs/i);
    // missing `access:` is default-denied, not silently pushed
    assert.match(reasonFor("no-access.md") ?? "", /no .?access.?.*default-deny/i);
    // a real tier outside sync_tiers is blocked
    assert.match(reasonFor("external.md") ?? "", /tier 'external' not in sync_tiers/);

    // none of the blocked files leaked into the pushable sets
    const pushable = new Set([...items.new, ...items.modified].map((i) => i.rel));
    for (const blocked of ["admin.md", "no-access.md", "external.md"]) {
      assert.ok(!pushable.has(`2-work/${blocked}`), `${blocked} must not be pushable`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a team-tier file IS eligible (the gate is non-vacuous)", () => {
  const dir = makeWorkspace();
  try {
    const items = planFor(dir);
    const newRels = items.new.map((i) => i.rel);
    assert.ok(
      newRels.includes("2-work/team-ok.md"),
      `team-ok.md should be pushable; new=${newRels}`
    );
    assert.ok(
      !items.blocked.some((b) => b.rel === "2-work/team-ok.md"),
      "team-ok.md must not be blocked"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
