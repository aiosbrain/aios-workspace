// `aios loop weekly` CLI tests. Drives the real CLI as a child process against a temp workspace
// + a saved manifest (so no collect/network). Proves: offline default writes both artifacts; the
// `--json` stdout is audience-safe (no brief content / admin actions); --as external + --all emit
// the right files; --remote without a key fails loud; and a non-shippable run gates non-zero with
// NO shippable digest path (only a clearly-marked .FAILED.md).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

const ADMIN_SENTINEL = "ZZACQUISITION40M";
const TEAM_SENTINEL = "ZZINTERNALTEAMNOTE";

const sig = (p, row, tier, kind, summary) => ({
  kind,
  source: kind,
  tier,
  occurredAt: "2026-06-29T00:00:00.000Z",
  ref: { path: p, row, tier },
  summary,
});

// Clean manifest: admin + team + external, no token collisions → shareable digests are shippable.
const CLEAN_MANIFEST = {
  member: "alex",
  project: "acme",
  generatedAt: "2026-06-30T00:00:00.000Z",
  window: { cadence: "weekly", from: "2026-06-23", to: "2026-06-30" },
  signals: [
    sig("4-shared/public.md", "1", "external", "deliverable", "Shipped the public widget"),
    sig("2-work/notes.md", "2", "team", "task", `Team task ${TEAM_SENTINEL}`),
    sig("5-personal/secret.md", "7", "admin", "decision", `Acquisition ${ADMIN_SENTINEL}`),
  ],
  excluded: [],
};

// Leak manifest (AIO-363): a genuine residual whole-document collision, offline and
// deterministic. An admin-only signal's summary contains a distinctive word ("research") that is
// ALSO the literal tag name the digest's own deterministic "Agent runtime (by tag)" section renders
// (from an UNRELATED team-tier time signal whose own summary text does NOT say "research" — hand-
// shaped to isolate the boilerplate collision from the signal's own content). Note this is NOT the
// pre-AIO-363 pattern (an admin/team pair independently using the same real-world vocabulary, e.g.
// a project codename or "engineering"/"management" — that was the false-positive dogfooding showed
// firing on 4/4 real runs, and `aboveAudienceStrings` now excludes it via the differential
// ≤-audience-visible gate). This scenario survives that fix because the tag name comes from fixed
// digest boilerplate, not from any visible signal's own text — the one place a residual leak can
// still legitimately fire, and exactly what the whole-document sweep exists to catch.
const LEAK_MANIFEST = {
  ...CLEAN_MANIFEST,
  signals: [
    sig("3-log/decision-log.md", "1", "team", "decision", "Shipped the operator loop"),
    {
      kind: "time",
      source: "session",
      tier: "team",
      occurredAt: "2026-06-29T00:00:00.000Z",
      ref: { path: "3-log/time-log.md", row: "blk1", tier: "team" },
      summary: "logged time",
      payload: { tag: "research", durationMin: 20, repo: "acme" },
    },
    sig("5-personal/p.md", "1", "admin", "decision", "Personal research direction ZZSECRET"),
  ],
};

function workspace(manifest) {
  const dir = mkdtempSync(path.join(tmpdir(), "c5-cli-"));
  writeFileSync(path.join(dir, "aios.yaml"), "member: alex\n");
  const m = path.join(dir, "manifest.json");
  writeFileSync(m, JSON.stringify(manifest));
  return { dir, m };
}

function run(cwd, args, env = {}) {
  try {
    const stdout = execFileSync("node", [CLI, "loop", "weekly", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const closeoutDir = (dir) => path.join(dir, ".aios", "loop", "closeouts");
function onlyRun(dir) {
  const base = closeoutDir(dir);
  const stamps = existsSync(base) ? readdirSync(base) : [];
  return stamps.length ? path.join(base, stamps[0]) : null;
}

test("offline default writes owner brief + team digest; admin omitted from the digest file", () => {
  const { dir, m } = workspace(CLEAN_MANIFEST);
  try {
    const r = run(dir, ["--manifest", m]);
    assert.equal(r.code, 0);
    const out = onlyRun(dir);
    assert.ok(out, "a closeout dir was written");
    assert.ok(existsSync(path.join(out, "brief.md")), "brief.md written");
    const digest = readFileSync(path.join(out, "digest-team.md"), "utf8");
    assert.ok(
      !digest.includes(ADMIN_SENTINEL),
      "admin sentinel must not be in the team digest file"
    );
    assert.ok(digest.includes(TEAM_SENTINEL), "team content present");
    // the offline notice is shown
    assert.match(r.stdout, /synthesis skipped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json stdout is audience-safe: no brief content, no admin sentinel, brief by path only", () => {
  const { dir, m } = workspace(CLEAN_MANIFEST);
  try {
    const r = run(dir, ["--manifest", m, "--json"]);
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes(ADMIN_SENTINEL), "no admin content on stdout");
    const j = JSON.parse(r.stdout);
    assert.equal(j.cadence, "weekly");
    assert.ok(
      typeof j.briefPath === "string" && j.briefPath.endsWith("brief.md"),
      "brief by path only"
    );
    assert.equal(j.audiences.length, 1);
    assert.equal(j.audiences[0].audience, "team");
    // no admin-tier action leaks into the audience-safe action list
    const tiers = new Set((j.audiences[0].nextWeekActions ?? []).map((a) => a.tier));
    assert.ok(!tiers.has("admin"), "no admin actions in the shareable json");
    assert.ok(j.audiences[0].verifier && typeof j.audiences[0].verifier.status === "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--as external writes an external digest that omits BOTH admin and team content", () => {
  const { dir, m } = workspace(CLEAN_MANIFEST);
  try {
    const r = run(dir, ["--manifest", m, "--as", "external"]);
    assert.equal(r.code, 0);
    const out = onlyRun(dir);
    const digest = readFileSync(path.join(out, "digest-external.md"), "utf8");
    assert.ok(!digest.includes(ADMIN_SENTINEL), "no admin in external digest");
    assert.ok(!digest.includes(TEAM_SENTINEL), "no team in external digest");
    assert.match(digest, /Withheld from this audience/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--all writes both shareable digests", () => {
  const { dir, m } = workspace(CLEAN_MANIFEST);
  try {
    const r = run(dir, ["--manifest", m, "--all"]);
    assert.equal(r.code, 0);
    const out = onlyRun(dir);
    assert.ok(existsSync(path.join(out, "digest-team.md")), "team digest written");
    assert.ok(existsSync(path.join(out, "digest-external.md")), "external digest written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--remote without ANTHROPIC_API_KEY fails loud (non-zero)", () => {
  const { dir, m } = workspace(CLEAN_MANIFEST);
  try {
    const r = run(dir, ["--manifest", m, "--remote"], { ANTHROPIC_API_KEY: "" });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr + r.stdout, /ANTHROPIC_API_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-shippable (leak-withheld) run gates non-zero and writes NO shippable digest path", () => {
  const { dir, m } = workspace(LEAK_MANIFEST);
  try {
    const r = run(dir, ["--manifest", m, "--json"]);
    assert.equal(r.code, 1, "non-shippable must gate non-zero");
    const j = JSON.parse(r.stdout);
    const team = j.audiences.find((a) => a.audience === "team");
    assert.equal(team.shippable, false);
    assert.equal(team.digestPath, null, "no approved digest path for a non-shippable run");
    assert.ok(
      team.unshippablePath && team.unshippablePath.endsWith(".FAILED.md"),
      "only a FAILED.md"
    );
    const out = onlyRun(dir);
    assert.ok(!existsSync(path.join(out, "digest-team.md")), "no shippable digest file written");
    assert.ok(existsSync(path.join(out, "digest-team.FAILED.md")), "the FAILED file is written");
    // the admin content must not leak even into the FAILED (inspection) file
    assert.ok(
      !readFileSync(path.join(out, "digest-team.FAILED.md"), "utf8").includes("ZZSECRET")
    );
    // AIO-363: the FAILED digest points at the leak-report for detail (the owner brief has none).
    assert.ok(existsSync(path.join(out, "leak-report.json")), "leak-report.json is written");
    const leakReport = JSON.parse(readFileSync(path.join(out, "leak-report.json"), "utf8"));
    assert.ok(leakReport.entries.some((e) => e.sourceTier === "admin"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
