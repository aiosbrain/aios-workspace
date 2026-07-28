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

// ── AIO-568: the `held` presentation class ────────────────────────────────────────────────────
//
// GRAIN §1.4. Every exclusion above is the safety boundary refusing on the owner's behalf, not a
// failure — so it renders as `held`, not red `blocked`. These tests pin the two halves that
// matter: the producer tags the class, and the MACHINE surfaces do not move.

test("AIO-568 — every blocked item carries class 'held' from the producer", async () => {
  const { buildPlan, HELD } = await import("../scripts/sync-plan.mjs");
  const dir = makeWorkspace();
  try {
    writeFileSync(
      path.join(dir, "2-work", "leaky.md"),
      fm({ status: "draft", owner: "alex", access: "team" }, "leaky") + "\nsk-live-SECRETVALUE\n"
    );
    const cfg = {
      sync_tiers: ["team"],
      sync_include: ["2-work"],
      sync_exclude: [],
      project: "t",
      brain_url: "",
    };
    const { plan } = buildPlan(dir, cfg, [/sk-live-[A-Z]+/]);

    assert.ok(plan.blocked.length >= 4, "fixture must exercise several blocked branches");
    for (const b of plan.blocked) {
      assert.equal(b.class, HELD, `${b.rel} must be tagged '${HELD}', got ${b.class}`);
      assert.ok(b.reason, "the reason string is preserved alongside the class");
    }
    // the secret branch specifically — the 5th producer site
    const leaky = plan.blocked.find((b) => b.rel === "2-work/leaky.md");
    assert.equal(leaky?.class, HELD);
    assert.match(leaky?.reason ?? "", /secret pattern matched/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AIO-568 — `--json` is unchanged: no `class` key, `items.blocked` keeps its name", () => {
  // --json is a documented machine surface. Adding a field is a versioned contract change and is
  // deliberately NOT part of this slice; a consumer must see byte-equivalent structure.
  const dir = makeWorkspace();
  try {
    const items = planFor(dir);
    assert.ok(Array.isArray(items.blocked), "items.blocked must keep its name and shape");
    assert.ok(items.blocked.length > 0, "fixture must produce blocked items");
    for (const b of items.blocked) {
      assert.deepEqual(
        Object.keys(b).sort(),
        ["reason", "rel"],
        "--json blocked entries carry exactly {rel, reason} — no `class` leaked out"
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AIO-568 — `--porcelain` keeps the `blocked=` key verbatim", () => {
  const dir = makeWorkspace();
  try {
    const out = execFileSync("node", [AIOS, "status", "--porcelain", "--repo", dir], {
      cwd: REPO,
      encoding: "utf8",
    });
    const line = out.trim().split("\n").filter(Boolean).pop();
    assert.match(
      line,
      /^new=\d+ modified=\d+ blocked=\d+ clean=\d+$/,
      `porcelain shape must not change; got: ${line}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AIO-568 — human `aios status` says held, not blocked", () => {
  const dir = makeWorkspace();
  try {
    const out = execFileSync("node", [AIOS, "status", "--repo", dir], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.match(out, /▮ held \(\d+\)/, "the held section is rendered with its glyph");
    assert.ok(
      !/\bblocked\b/i.test(out),
      `human output must not call a refusal "blocked"; got:\n${out}`
    );
    // colour is redundant, never load-bearing: NO_COLOR output still carries glyph + word.
    assert.ok(!out.includes("\x1b"), "NO_COLOR run emits no escape codes");
    // the reason is still named, so the fix stays as discoverable as before
    assert.match(out, /admin.*never syncs/i);

    // The footer must be scoped to the HELD items. The fixture also has a pushable `new` row,
    // so an unscoped claim like "nothing above left this machine" would be false (Bugbot, AIO-568).
    assert.match(out, /\d+ held file\(s\) stayed on this machine/);
    assert.ok(/new \(\d+\)/.test(out), "fixture must have pushable rows for that to bite");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
