// AM4b instinct distill (AIO-230) — deterministic tests with mocked distillFn + tmp homunculus.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, OBS_STORE_REL } from "../scripts/analyze/maturity-store.mjs";
import {
  distillObservations,
  parseInstinctMarkdown,
  loadInstinctsState,
  saveInstinctsState,
  filterNewObservations,
  personalInstinctsDir,
} from "../scripts/instincts.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

function ws() {
  const dir = mkdtempSync(path.join(tmpdir(), "instincts-distill-"));
  const homunculus = mkdtempSync(path.join(tmpdir(), "homunculus-"));
  return { dir, homunculus };
}

function writeObs(repo, obsList) {
  const abs = path.join(repo, OBS_STORE_REL);
  mkdirSync(path.dirname(abs), { recursive: true });
  const lines = obsList.map((obs) => JSON.stringify({ v: SCHEMA_VERSION, op: "create", obs }));
  writeFileSync(abs, lines.join("\n") + "\n");
}

function mkObs(id, priorHash, createdAt, snippet = "no - use flat-yaml.mjs") {
  return {
    id,
    session_id: "sess-1",
    ts: createdAt,
    kind: "correction",
    snippet,
    prior_hash: priorHash,
    tier: "admin",
    createdAt,
  };
}

const MOCK_CANDIDATE = {
  trigger: "when editing YAML config loaders in this repo",
  action: "Use `scripts/flat-yaml.mjs` instead of ad-hoc parsing.",
  context: "Operator corrected the agent twice for re-implementing YAML parsing.",
  confidence: 0.6,
  domain: "workflow",
};

function mockDistillFn(payload) {
  return async () => JSON.stringify({ candidates: [payload ?? MOCK_CANDIDATE] });
}

test("3 observations sharing prior_hash → one instinct with all origin_obs", async () => {
  const { dir, homunculus } = ws();
  const projectId = "testproj0001";
  const prior = "abc123";
  const obs = [
    mkObs("o1", prior, "2026-07-03T10:00:00.000Z"),
    mkObs("o2", prior, "2026-07-03T10:01:00.000Z"),
    mkObs("o3", prior, "2026-07-03T10:02:00.000Z"),
  ];

  const summary = await distillObservations({
    observations: obs,
    distillFn: mockDistillFn(),
    homunculusDir: homunculus,
    projectId,
    now: () => new Date("2026-07-03T10:05:00.000Z"),
  });

  assert.equal(summary.written, 1);
  assert.equal(summary.processedGroups, 1);
  const outDir = personalInstinctsDir(homunculus, projectId);
  const files = readdirSync(outDir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1);
  const parsed = parseInstinctMarkdown(readFileSync(path.join(outDir, files[0]), "utf8"));
  assert.equal(parsed.domain, "workflow");
  assert.equal(parsed.confidence, 0.6);
  assert.equal(parsed.created_at, "2026-07-03T10:05:00Z");
  assert.deepEqual(parsed.origin_obs.sort(), ["o1", "o2", "o3"]);
  assert.match(parsed.id, /^instinct-/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(homunculus, { recursive: true, force: true });
});

test("watermark: second run idle; fresh observation picked up", async () => {
  const { dir, homunculus } = ws();
  const projectId = "testproj0002";
  const prior = "hash-a";
  const obs1 = [
    mkObs("a1", prior, "2026-07-03T10:00:00.000Z"),
    mkObs("a2", prior, "2026-07-03T10:01:00.000Z"),
  ];
  writeObs(dir, obs1);
  saveInstinctsState(dir, { lastCreatedAt: null, lastObsId: null });

  let calls = 0;
  const distillFn = async () => {
    calls += 1;
    return JSON.stringify({ candidates: [MOCK_CANDIDATE] });
  };

  const fresh1 = filterNewObservations(obs1, loadInstinctsState(dir));
  assert.equal(fresh1.length, 2);
  await distillObservations({
    observations: fresh1,
    distillFn,
    homunculusDir: homunculus,
    projectId,
  });
  saveInstinctsState(dir, { lastCreatedAt: "2026-07-03T10:01:00.000Z", lastObsId: "a2" });

  const fresh2 = filterNewObservations(obs1, loadInstinctsState(dir));
  assert.equal(fresh2.length, 0);

  const obs2 = [...obs1, mkObs("a3", "hash-b", "2026-07-03T10:05:00.000Z")];
  writeObs(dir, obs2);
  const fresh3 = filterNewObservations(obs2, loadInstinctsState(dir));
  assert.equal(fresh3.length, 1);
  assert.equal(fresh3[0].id, "a3");

  await distillObservations({
    observations: fresh3,
    distillFn,
    homunculusDir: homunculus,
    projectId,
  });
  assert.equal(calls, 2);
  rmSync(dir, { recursive: true, force: true });
  rmSync(homunculus, { recursive: true, force: true });
});

test("dedup-by-trigger updates confidence instead of duplicating", async () => {
  const { dir, homunculus } = ws();
  const projectId = "testproj0003";
  const outDir = personalInstinctsDir(homunculus, projectId);
  mkdirSync(outDir, { recursive: true });
  const existingPath = path.join(outDir, "instinct-when-editing-yaml-config-loaders-ab12.md");
  writeFileSync(
    existingPath,
    [
      "---",
      "id: instinct-when-editing-yaml-config-loaders-ab12",
      'trigger: "when editing YAML config loaders in this repo"',
      "confidence: 0.5",
      "domain: workflow",
      "source: personal",
      "scope: project",
      "created_at: 2026-07-01T10:00:00Z",
      "origin_obs: [old1]",
      "---",
      "## Context",
      "Old context",
      "## Action",
      "Old action",
      "",
    ].join("\n")
  );

  const obs = [mkObs("n1", "prior-new", "2026-07-03T11:00:00.000Z")];
  const summary = await distillObservations({
    observations: obs,
    distillFn: mockDistillFn({ ...MOCK_CANDIDATE, confidence: 0.75 }),
    homunculusDir: homunculus,
    projectId,
  });

  assert.equal(summary.written, 0);
  assert.equal(summary.updated, 1);
  const files = readdirSync(outDir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1);
  const parsed = parseInstinctMarkdown(readFileSync(path.join(outDir, files[0]), "utf8"));
  assert.equal(parsed.confidence, 0.75);
  assert.deepEqual(parsed.origin_obs.sort(), ["n1", "old1"].sort());
  assert.equal(parsed.created_at, "2026-07-01T10:00:00Z");
  rmSync(dir, { recursive: true, force: true });
  rmSync(homunculus, { recursive: true, force: true });
});

test("sub-0.4 confidence candidates are dropped", async () => {
  const { dir, homunculus } = ws();
  const summary = await distillObservations({
    observations: [mkObs("low1", "ph", "2026-07-03T12:00:00.000Z")],
    distillFn: mockDistillFn({ ...MOCK_CANDIDATE, confidence: 0.2 }),
    homunculusDir: homunculus,
    projectId: "testproj0004",
  });
  assert.equal(summary.droppedLowConfidence, 1);
  assert.equal(summary.written, 0);
  rmSync(dir, { recursive: true, force: true });
  rmSync(homunculus, { recursive: true, force: true });
});

test("dry-run writes nothing and does not call distillFn", async () => {
  const { dir, homunculus } = ws();
  let called = false;
  const summary = await distillObservations({
    observations: [mkObs("d1", "ph", "2026-07-03T13:00:00.000Z")],
    distillFn: async () => {
      called = true;
      throw new Error("should not run");
    },
    homunculusDir: homunculus,
    projectId: "testproj0005",
    dryRun: true,
  });
  assert.equal(called, false);
  assert.equal(summary.records[0].dryRun, true);
  assert.equal(existsSync(personalInstinctsDir(homunculus, "testproj0005")), false);
  rmSync(dir, { recursive: true, force: true });
  rmSync(homunculus, { recursive: true, force: true });
});

test("malformed distillFn output is rejected without crashing", async () => {
  const { dir, homunculus } = ws();
  const badFn = async () => JSON.stringify({ candidates: [{ trigger: "x", confidence: 2 }] });
  const summary = await distillObservations({
    observations: [mkObs("b1", "ph", "2026-07-03T14:00:00.000Z")],
    distillFn: badFn,
    homunculusDir: homunculus,
    projectId: "testproj0006",
  });
  assert.equal(summary.written, 0);
  assert.ok(summary.rejected >= 1);
  assert.ok(summary.warnings.length >= 1);
  rmSync(dir, { recursive: true, force: true });
  rmSync(homunculus, { recursive: true, force: true });
});

test("CLI --dry-run is offline-capable", () => {
  const { dir, homunculus } = ws();
  writeFileSync(path.join(dir, "README.md"), "# test workspace\n");
  writeObs(dir, [mkObs("c1", "ph", "2026-07-03T15:00:00.000Z")]);
  const out = execFileSync(
    "node",
    [CLI, "instincts", "distill", "--repo", dir, "--dry-run", "--json"],
    {
      env: { ...process.env, AIOS_HOMUNCULUS_DIR: homunculus },
      encoding: "utf8",
    }
  );
  const payload = JSON.parse(out);
  assert.equal(payload.groupsProcessed, 1);
  assert.equal(payload.written, 0);
  rmSync(dir, { recursive: true, force: true });
  rmSync(homunculus, { recursive: true, force: true });
});
