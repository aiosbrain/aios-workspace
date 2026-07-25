// test/cli-registry.test.mjs — parity guard for the aios.mjs command registry (AIO-512 Phase 1).
//
// The registry replaced a 45-branch if/else-if chain plus a hand-maintained USAGE string. These
// tests are the proof that the replacement is behavior-identical: the command set, each
// command's root-resolution mode, the help text, the help/unknown-command exit codes, the
// `--repo` carve-out, and the exit-code contract of each `exit` mode. The last test is the one
// that makes the refactor worth doing: `aios status` must not drag ship/build/spec-eval into
// its startup graph.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS, findCommand, renderUsage } from "../scripts/cli/registry.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const PROBE = path.join(DIR, "helpers", "import-probe.mjs");
const USAGE_FIXTURE = path.join(DIR, "fixtures", "aios-usage.txt");

// ── the pre-refactor truth, transcribed from the if/else-if chain + OFFLINE_CMDS set + the
// `update` / `mcp` carve-outs at scripts/aios.mjs@737116f. Do NOT regenerate this from the
// registry — it is the independent side of the parity assertion.
const PRE_REFACTOR = {
  // workspace: findRepoRoot, aios.yaml REQUIRED
  status: "workspace",
  review: "workspace",
  push: "workspace",
  work: "workspace",
  pull: "workspace",
  whoami: "workspace",
  stakeholders: "workspace",
  query: "workspace",
  member: "workspace",
  "pull-bundle": "workspace",
  transcripts: "workspace",
  pm: "workspace",
  promote: "workspace",
  // offline: findRepoRootOffline, aios.yaml optional
  "export-okf": "offline",
  graph: "offline",
  "install-skill": "offline",
  connect: "offline",
  onboard: "offline",
  skills: "offline",
  "assess-codebase": "offline",
  "context-health": "offline",
  learn: "offline",
  analyze: "offline",
  relay: "offline",
  build: "offline",
  simplify: "offline",
  spec: "offline",
  pr: "offline",
  "consolidate-findings": "offline",
  "review-bugbot": "offline",
  ship: "offline",
  "roadmap-run": "offline",
  loop: "offline",
  time: "offline",
  asks: "offline",
  inbox: "offline",
  decisions: "offline",
  mode: "offline",
  rails: "offline",
  council: "offline",
  "maturity-week": "offline",
  instincts: "offline",
  worktree: "offline",
  timeline: "offline",
  // special resolution
  update: "update-root",
  mcp: "pre-config",
};

// Commands that owned their own `--repo` flag before the refactor and must keep it.
const PRE_REFACTOR_OWNS_REPO = ["pr", "consolidate-findings", "timeline"];

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [AIOS, ...args], {
    encoding: "utf8",
    ...opts,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tmpDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// ── registry shape ───────────────────────────────────────────────────────────

test("registry: every command is registered exactly once", () => {
  const seen = new Set();
  for (const d of COMMANDS) {
    for (const n of [d.name, ...(d.aliases ?? [])]) {
      assert.ok(!seen.has(n), `duplicate registration for '${n}'`);
      seen.add(n);
    }
  }
  assert.equal(
    seen.size,
    COMMANDS.length + COMMANDS.reduce((a, d) => a + (d.aliases?.length ?? 0), 0)
  );
});

test("registry: command set matches the pre-refactor dispatch chain exactly", () => {
  const registered = COMMANDS.map((d) => d.name).sort();
  const expected = Object.keys(PRE_REFACTOR).sort();
  assert.deepEqual(registered, expected);
});

test("registry: each command keeps its pre-refactor resolution mode", () => {
  // A silent widening from "workspace" to "offline" would let a sync command run against an
  // unconfigured directory — this is the tier-safety assertion, not a style check.
  for (const [name, mode] of Object.entries(PRE_REFACTOR)) {
    assert.equal(findCommand(name)?.resolution, mode, `${name} resolution drifted`);
  }
});

test("registry: only pr/consolidate-findings/timeline own the --repo flag", () => {
  const owners = COMMANDS.filter((d) => d.ownsRepoFlag)
    .map((d) => d.name)
    .sort();
  assert.deepEqual(owners, [...PRE_REFACTOR_OWNS_REPO].sort());
});

test("registry: every descriptor declares a usage block and a valid exit mode", () => {
  for (const d of COMMANDS) {
    assert.ok(Array.isArray(d.usage), `${d.name} has no usage array`);
    assert.ok(typeof d.adapt === "function", `${d.name} has no adapt`);
    assert.ok(
      d.exit === undefined || ["none", "exit-code", "exit-status"].includes(d.exit),
      `${d.name} has an unknown exit mode '${d.exit}'`
    );
  }
});

test("registry: loaders are lazy — no descriptor holds an eagerly-resolved module", () => {
  for (const d of COMMANDS) {
    if (d.loader === undefined) continue;
    assert.equal(typeof d.loader, "function", `${d.name} loader must be a thunk`);
    assert.equal(d.loader.length, 0, `${d.name} loader must take no arguments`);
  }
});

// ── help text ────────────────────────────────────────────────────────────────

test("registry: renderUsage matches the checked-in snapshot", () => {
  assert.ok(existsSync(USAGE_FIXTURE), "test/fixtures/aios-usage.txt is missing");
  assert.equal(`${renderUsage()}\n`, readFileSync(USAGE_FIXTURE, "utf8"));
});

test("registry: every help line beginning `aios <cmd>` names a registered command", () => {
  const named = new Set();
  for (const d of COMMANDS) {
    for (const line of d.usage) {
      const m = /^ {2}aios ([a-z0-9-]+)/.exec(line);
      if (m) named.add(m[1]);
    }
  }
  for (const n of named) {
    assert.ok(findCommand(n), `help documents '${n}' but nothing is registered under that name`);
  }
});

test("registry: usage blocks are owned by their own command", () => {
  for (const d of COMMANDS) {
    const first = d.usage[0];
    if (!first) continue;
    assert.ok(
      first.startsWith(`  aios ${d.name}`),
      `${d.name}'s usage block starts with someone else's line: ${first}`
    );
  }
});

// ── CLI behavior parity (child processes) ────────────────────────────────────

test("cli: help works with no workspace anywhere above cwd", () => {
  const dir = tmpDir("aios-nohelp-");
  try {
    for (const args of [[], ["-h"], ["--help"], ["help"]]) {
      const r = run(args, { cwd: dir });
      assert.equal(r.code, 0, `\`aios ${args.join(" ")}\` exited ${r.code}`);
      assert.match(r.stdout, /^aios — AIOS Team Brain sync client/);
      assert.match(r.stdout, /aios roadmap-run/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: unknown command prints the help text and exits 1", () => {
  const dir = tmpDir("aios-unknown-");
  try {
    const r = run(["not-a-command"], { cwd: dir });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, `${renderUsage()}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: an offline command runs in a workspace with no aios.yaml", () => {
  // `graph` is offline-resolution: findRepoRootOffline accepts a project.yaml workspace and
  // loadOfflineConfig stands in for the missing aios.yaml. It must NOT die with the
  // workspace-mode "no aios.yaml found" error.
  const dir = tmpDir("aios-offline-");
  try {
    writeFileSync(path.join(dir, "project.yaml"), "project: sample\n");
    const r = run(["graph"], { cwd: dir });
    assert.doesNotMatch(r.stderr, /no aios\.yaml found walking up from cwd/);
    assert.doesNotMatch(r.stderr, /could not locate repo root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: a workspace command still hard-fails without aios.yaml", () => {
  const dir = tmpDir("aios-noyaml-");
  try {
    const r = run(["status"], { cwd: dir });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no aios\.yaml found walking up from cwd/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: `update` keeps its own root resolution and rejects a bare directory", () => {
  const dir = tmpDir("aios-update-");
  try {
    const r = run(["update", "--check", "--repo", dir]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /must run in a workspace \(aios\.yaml\) or the toolkit checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: exit codes are preserved for an exit-code command", () => {
  // `spec` publishes an explicit exit-code contract (0/1/2/3, 4 on IO error).
  assert.equal(run(["spec", "eval", "/nonexistent/spec.md", "--repo", REPO]).code, 4);
});

test("cli: `--repo` is still forwarded, not consumed, for a flag-owning command", () => {
  // consolidate-findings takes `--repo owner/repo` (a GitHub slug). If dispatch consumed it,
  // the command would instead complain about a missing --repo / resolve a bogus workspace.
  const r = run(["consolidate-findings", "--repo", "aiosbrain/aios-workspace"]);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.stderr, /could not locate repo root/);
});

// ── the point of the refactor ────────────────────────────────────────────────

const HEAVY = ["scripts/ship.mjs", "scripts/build.mjs", "scripts/spec-eval.mjs"];

function traceStartup(args, cwd) {
  const dir = tmpDir("aios-trace-");
  const out = path.join(dir, "trace.txt");
  writeFileSync(out, "");
  const r = run(args, { cwd, env: { AIOS_IMPORT_TRACE: out, NODE_OPTIONS: `--import ${PROBE}` } });
  const trace = readFileSync(out, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { trace, ...r };
}

test("lazy: `aios status` never loads ship.mjs / build.mjs / spec-eval.mjs", () => {
  const ws = tmpDir("aios-lazyws-");
  try {
    writeFileSync(path.join(ws, "aios.yaml"), "workspace: sample\nbrain_url: \nteam_id: t\n");
    const { trace } = traceStartup(["status", "--repo", ws], ws);
    // sanity: the probe actually captured the startup graph
    assert.match(trace, /scripts\/aios\.mjs/);
    assert.match(trace, /scripts\/cli\/registry\.mjs/);
    assert.match(trace, /scripts\/cli\/dispatch\.mjs/);
    for (const heavy of HEAVY) {
      assert.ok(!trace.includes(heavy), `aios status pulled in ${heavy}:\n${trace}`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("lazy: `aios help` loads no command module at all", () => {
  const dir = tmpDir("aios-lazyhelp-");
  try {
    const { trace, code } = traceStartup(["--help"], dir);
    assert.equal(code, 0);
    for (const heavy of [...HEAVY, "scripts/roadmap-run.mjs", "scripts/timeline.mjs"]) {
      assert.ok(!trace.includes(heavy), `aios --help pulled in ${heavy}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lazy: the heavy modules are still reachable when their command runs", () => {
  // The mirror of the test above — proves the loaders work, not just that nothing loads.
  const { trace } = traceStartup(["spec", "eval", "/nonexistent/spec.md", "--repo", REPO], REPO);
  assert.match(trace, /scripts\/spec-eval\.mjs/);
});
