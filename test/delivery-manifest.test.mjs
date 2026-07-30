// test/delivery-manifest.test.mjs — the durable split-delivery manifest (AIO-595, epic AIO-594):
// schema validation over the canonical program fixture, `aios delivery manifest init` (the one
// sanctioned write: validate + byte-exact copy, refuse-overwrite without --force), and
// `aios delivery status --json` surfacing the installed manifest read-only. Mirrors
// test/delivery-status.test.mjs style: real temp git checkouts + a fake `gh`, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateSplitManifest,
  validateVerdictEntry,
  installManifest,
  loadManifest,
  MANIFEST_RELPATH,
} from "../scripts/delivery.mjs";
import { cmdDelivery } from "../scripts/delivery-status.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL = path.join(DIR, "fixtures", "delivery", "split-manifest.canonical.json");

function canonical() {
  return JSON.parse(readFileSync(CANONICAL, "utf8"));
}

// ── schema: the canonical AIO-594 instance ──────────────────────────────────────────────────

test("schema: accepts the canonical AIO-594 program manifest byte-for-byte", () => {
  assert.deepEqual(validateSplitManifest(canonical()), []);
});

test("schema: rejects a non-object candidate outright", () => {
  assert.deepEqual(validateSplitManifest(null), ["manifest: expected a JSON object"]);
  assert.deepEqual(validateSplitManifest([1, 2]), ["manifest: expected a JSON object"]);
});

test("schema: rejects a manifest missing schema_version", () => {
  const m = canonical();
  delete m.schema_version;
  const errors = validateSplitManifest(m);
  assert.ok(
    errors.some((e) => e === "schema_version: required"),
    `expected a schema_version error, got: ${errors.join("; ")}`
  );
});

test("schema: rejects an unknown schema_version (this validator knows exactly version 1)", () => {
  const m = canonical();
  m.schema_version = 2;
  assert.ok(validateSplitManifest(m).some((e) => /^schema_version: expected 1/.test(e)));
});

test("schema: rejects missing required top-level sections", () => {
  const m = canonical();
  delete m.baseline;
  delete m.cuts;
  delete m.verdict_log;
  const errors = validateSplitManifest(m);
  assert.ok(errors.some((e) => e === "baseline: expected an object"));
  assert.ok(errors.some((e) => e === "cuts: expected an object"));
  assert.ok(errors.some((e) => e === "verdict_log: expected an array"));
});

test("schema: rejects a baseline with a malformed source_sha", () => {
  const m = canonical();
  m.baseline.source_sha = "not-a-sha";
  assert.ok(validateSplitManifest(m).some((e) => /baseline\.source_sha/.test(e)));
});

test("schema: rejects a cut that dropped the nullable evidence keys", () => {
  const m = canonical();
  delete m.cuts["aios-workspace-gui"].rehearsal;
  delete m.cuts["aios-workspace-gui"].fresh_clone_ci;
  const errors = validateSplitManifest(m);
  assert.ok(errors.some((e) => e === "cuts.aios-workspace-gui.rehearsal: key required (use null when not yet produced)"));
  assert.ok(errors.some((e) => /cuts\.aios-workspace-gui\.fresh_clone_ci: key required/.test(e)));
});

// ── schema: verdict entries (human-authored, but still structurally auditable) ──────────────

test("schema: rejects a verdict_log entry missing decision/actor and with non-array evidence_refs", () => {
  const m = canonical();
  m.verdict_log.push({
    gate: "G1",
    decided_at: "2026-07-30T12:00:00Z",
    evidence_refs: "https://example.com/run/1",
  });
  const errors = validateSplitManifest(m);
  assert.ok(errors.some((e) => e === "verdict_log[0].decision: expected a non-empty string"));
  assert.ok(errors.some((e) => e === "verdict_log[0].actor: expected a non-empty string"));
  assert.ok(errors.some((e) => e === "verdict_log[0].evidence_refs: expected an array"));
});

test("schema: rejects a verdict entry with an unparseable decided_at, accepts a complete one", () => {
  assert.ok(
    validateVerdictEntry(
      { gate: "G1", decision: "GO", actor: "John", decided_at: "yesterday-ish", evidence_refs: [] },
      "verdict_log[0]."
    ).some((e) => /decided_at: expected an ISO-8601 timestamp/.test(e))
  );
  assert.deepEqual(
    validateVerdictEntry(
      {
        gate: "G1",
        decision: "GO",
        actor: "John",
        decided_at: "2026-07-31T17:00:00Z",
        evidence_refs: ["https://github.com/aiosbrain/aios-workspace/actions/runs/1"],
      },
      "verdict_log[0]."
    ),
    []
  );
});

test("schema: rejects a bad verdict entry inside a cut's verdicts too", () => {
  const m = canonical();
  m.cuts["aios-devtools"].verdicts.push({ gate: "", decision: "GO" });
  const errors = validateSplitManifest(m);
  assert.ok(errors.some((e) => /cuts\.aios-devtools\.verdicts\[0\]\.gate/.test(e)));
  assert.ok(errors.some((e) => /cuts\.aios-devtools\.verdicts\[0\]\.actor/.test(e)));
});

// ── manifest init: validate + copy, refuse-overwrite ────────────────────────────────────────

function captureConsole(fn) {
  const lines = [];
  const errLines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg) => lines.push(msg);
  console.error = (msg) => errLines.push(msg);
  try {
    return { result: fn(), output: lines.join("\n"), errOutput: errLines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test("installManifest: happy path is a byte-exact copy into .aios/delivery/", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "manifest-install-"));
  try {
    const res = installManifest(CANONICAL, repo);
    assert.equal(res.ok, true);
    assert.deepEqual(res.errors, []);
    assert.equal(res.dest, path.join(repo, MANIFEST_RELPATH));
    assert.equal(readFileSync(res.dest, "utf8"), readFileSync(CANONICAL, "utf8"));
    const loaded = loadManifest(repo);
    assert.equal(loaded.warning, null);
    assert.equal(loaded.manifest.program, "AIO-594 multi-repo split");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("installManifest: an invalid source is refused and nothing is written", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "manifest-invalid-"));
  try {
    const bad = path.join(repo, "bad.json");
    const m = canonical();
    delete m.schema_version;
    writeFileSync(bad, JSON.stringify(m));
    const res = installManifest(bad, repo);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => /schema_version/.test(e)));
    assert.equal(existsSync(path.join(repo, MANIFEST_RELPATH)), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cmdDelivery manifest init: happy path, refuse-overwrite, then --force", async () => {
  const target = mkdtempSync(path.join(tmpdir(), "manifest-cli-target-"));
  const cwdRepo = mkdtempSync(path.join(tmpdir(), "manifest-cli-cwd-"));
  try {
    // Happy path: install into an explicit --repo target (a LOCAL path here, unlike status).
    const first = captureConsole(() =>
      cmdDelivery(cwdRepo, {}, ["manifest", "init", CANONICAL, "--repo", target])
    );
    assert.equal(await first.result, 0);
    assert.match(first.output, /installed/);
    const dest = path.join(target, MANIFEST_RELPATH);
    assert.equal(readFileSync(dest, "utf8"), readFileSync(CANONICAL, "utf8"));

    // Refuse-overwrite: a second init without --force fails and leaves the file untouched.
    writeFileSync(dest, readFileSync(CANONICAL, "utf8") + "\n"); // simulate a human edit
    const second = captureConsole(() =>
      cmdDelivery(cwdRepo, {}, ["manifest", "init", CANONICAL, "--repo", target])
    );
    assert.equal(await second.result, 1);
    assert.match(second.errOutput, /refusing to overwrite/);
    assert.equal(readFileSync(dest, "utf8"), readFileSync(CANONICAL, "utf8") + "\n");

    // --force replaces it deliberately.
    const third = captureConsole(() =>
      cmdDelivery(cwdRepo, {}, ["manifest", "init", CANONICAL, "--repo", target, "--force"])
    );
    assert.equal(await third.result, 0);
    assert.equal(readFileSync(dest, "utf8"), readFileSync(CANONICAL, "utf8"));
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(cwdRepo, { recursive: true, force: true });
  }
});

test("cmdDelivery manifest init: an invalid candidate exits 1 with the schema errors", async () => {
  const target = mkdtempSync(path.join(tmpdir(), "manifest-cli-bad-"));
  try {
    const bad = path.join(target, "bad.json");
    writeFileSync(bad, "{ not json");
    const { result, errOutput } = captureConsole(() =>
      cmdDelivery(target, {}, ["manifest", "init", bad, "--repo", target])
    );
    assert.equal(await result, 1);
    assert.match(errOutput, /invalid JSON/);
    assert.equal(existsSync(path.join(target, MANIFEST_RELPATH)), false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ── status --json surfaces the manifest (read-only) ─────────────────────────────────────────

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function initRepo(name) {
  const dir = mkdtempSync(path.join(tmpdir(), `manifest-status-${name}-`));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "a.txt"), "1\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

// Minimal fake `gh` (see test/delivery-status.test.mjs for the recording variant): answers
// `pr list` with an empty set and refuses anything else, so any mutating call fails loudly.
async function withFakeGh(fn) {
  const bin = mkdtempSync(path.join(tmpdir(), "manifest-status-fakegh-"));
  writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      "const argv = process.argv.slice(2);",
      "if (argv[0] !== 'pr' || argv[1] !== 'list') { process.stderr.write('refused'); process.exit(1); }",
      "process.stdout.write('[]');",
    ].join("\n")
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  const originalPath = process.env.PATH;
  const originalGhBin = process.env.AIOS_DELIVERY_GH_BIN;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.AIOS_DELIVERY_GH_BIN = path.join(bin, "gh");
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
    if (originalGhBin === undefined) delete process.env.AIOS_DELIVERY_GH_BIN;
    else process.env.AIOS_DELIVERY_GH_BIN = originalGhBin;
    rmSync(bin, { recursive: true, force: true });
  }
}

test("status --json: surfaces the installed manifest, and null + a warning when absent", async () => {
  const workspaceRepo = initRepo("ws");
  const brainRepo = initRepo("brain");
  try {
    const locals = [
      "--local",
      `aiosbrain/aios-workspace=${workspaceRepo}`,
      "--local",
      `aiosbrain/aios-team-brain=${brainRepo}`,
    ];

    await withFakeGh(async () => {
      // No manifest installed yet: manifest is null and the warning says how to install one.
      const before = captureConsole(() =>
        cmdDelivery(workspaceRepo, {}, ["status", "--json", ...locals])
      );
      assert.equal(await before.result, 0, "an absent manifest must not change the exit code");
      const parsedBefore = JSON.parse(before.output);
      assert.equal(parsedBefore.manifest, null);
      assert.match(parsedBefore.manifestWarning, /no split manifest installed/);

      // Install via the CLI (the sanctioned write path), then status reports it.
      const init = captureConsole(() =>
        cmdDelivery(workspaceRepo, {}, ["manifest", "init", CANONICAL, "--repo", workspaceRepo])
      );
      assert.equal(await init.result, 0);
      const after = captureConsole(() =>
        cmdDelivery(workspaceRepo, {}, ["status", "--json", ...locals])
      );
      assert.equal(await after.result, 0);
      const parsedAfter = JSON.parse(after.output);
      assert.equal(parsedAfter.manifestWarning, null);
      assert.equal(parsedAfter.manifest.program, "AIO-594 multi-repo split");
      assert.equal(parsedAfter.manifest.schema_version, 1);
      assert.deepEqual(parsedAfter.manifest.verdict_log, []);

      // `--repo <absolute path>` on status is a workspace-path override, not a slug filter:
      // both slugs stay in the report and the manifest is loaded from that path.
      const viaPath = captureConsole(() =>
        cmdDelivery("/nonexistent-dispatch-root", {}, [
          "status",
          "--json",
          "--repo",
          workspaceRepo,
          ...locals,
        ])
      );
      assert.equal(await viaPath.result, 0);
      const parsedViaPath = JSON.parse(viaPath.output);
      assert.equal(parsedViaPath.repos.length, 2, "a path-form --repo must not filter slugs");
      assert.equal(parsedViaPath.manifest.program, "AIO-594 multi-repo split");

      // A corrupted installed manifest degrades to null + warning, never an exception.
      writeFileSync(path.join(workspaceRepo, MANIFEST_RELPATH), "{ broken");
      const broken = captureConsole(() =>
        cmdDelivery(workspaceRepo, {}, ["status", "--json", ...locals])
      );
      assert.equal(await broken.result, 0);
      const parsedBroken = JSON.parse(broken.output);
      assert.equal(parsedBroken.manifest, null);
      assert.match(parsedBroken.manifestWarning, /invalid/);
    });
  } finally {
    rmSync(workspaceRepo, { recursive: true, force: true });
    rmSync(brainRepo, { recursive: true, force: true });
  }
});
