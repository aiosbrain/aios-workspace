import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(ROOT, ".github/workflows/debt-patrol.yml"), "utf8");
const config = JSON.parse(readFileSync(path.join(ROOT, "config/debt-patrol.v1.json"), "utf8"));
const scanScript = path.join(ROOT, ".github/scripts/scan_with_health.py");
const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const SETUP_PYTHON_SHA = "5fda3b95a4ea91299a34e894583c3862153e4b97";
const UPLOAD_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

test("workflow schedules and target policy are one exact configuration", () => {
  for (const cron of Object.values(config.schedule_crons)) {
    assert.match(workflow, new RegExp(`cron: ["']${cron.replaceAll("*", "\\*")}["']`));
  }
  for (const target of config.targets) {
    assert.equal(target.enabled, true);
    assert.match(workflow, new RegExp(target.repository.replace("/", "\\/")));
  }
  assert.match(workflow, /AIOS_DEBT_PATROL_ENABLED/);
  assert.match(workflow, /AIOS_DEBT_PATROL_PAUSED/);
  assert.match(workflow, /--enabled "\$\{PATROL_ENABLED:-\}"/);
  assert.match(workflow, /--paused "\$\{PATROL_PAUSED:-\}"/);
  assert.match(workflow, /--workflow-ref "\$GITHUB_REF"/);
});

test("workflow is report-only and third-party actions are immutable", () => {
  assert.match(workflow, /permissions:\n {2}contents: read\n {2}pull-requests: read\n/);
  assert.doesNotMatch(workflow, /(?:contents|pull-requests|issues|actions|checks): write/);
  assert.doesNotMatch(
    workflow,
    /gh\s+(?:pr|issue)|linear(?:\.app|\.mjs)|git\s+(?:push|commit)|enable-auto-merge/i
  );
  const refs = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(refs.length >= 6);
  assert.ok(
    refs.every((ref) => /^[0-9a-f]{40}$/.test(ref)),
    refs.join(", ")
  );
  assert.ok(refs.includes(CHECKOUT_SHA));
  assert.ok(refs.includes(SETUP_NODE_SHA));
  assert.ok(refs.includes(SETUP_PYTHON_SHA));
  assert.equal(refs.filter((ref) => ref === UPLOAD_SHA).length, 2);
});

test("workflow binds analysis and health to one exact revalidated head", () => {
  assert.match(workflow, /ref: \$\{\{ matrix\.resolved_sha \}\}/);
  assert.match(workflow, /--expected-sha "\$\{\{ matrix\.resolved_sha \}\}"/);
  assert.match(workflow, /--expected-head-sha "\$\{\{ matrix\.resolved_sha \}\}"/);
  assert.match(workflow, /steps\.revalidate\.outcome == 'success'/);
  assert.match(workflow, /timeout-minutes: \$\{\{ matrix\.budget_minutes \}\}/);
  assert.match(workflow, /overwrite: false/g);
  assert.match(workflow, /retention-days: 90/g);
});

test("Brain credentials are scoped only to the final exact-head delivery step", () => {
  assert.equal((workflow.match(/secrets\.AIOS_API_KEY/g) ?? []).length, 1);
  assert.equal((workflow.match(/secrets\.AIOS_BRAIN_URL/g) ?? []).length, 1);
  assert.equal((workflow.match(/secrets\.AIOS_TEAM/g) ?? []).length, 1);
  const delivery = workflow.slice(workflow.indexOf("- name: Deliver existing full scan payload"));
  assert.match(delivery, /AIOS_API_KEY: \$\{\{ secrets\.AIOS_API_KEY \}\}/);
});

test("exact-head scan mode refuses health or analyzer SHA drift before upload", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "debt-patrol-scan-"));
  const expected = "a".repeat(40);
  const different = "b".repeat(40);
  const healthPath = path.join(dir, "health.json");
  writeFileSync(
    healthPath,
    `${JSON.stringify({
      schema_version: "2",
      rubric_version: "1.1.0",
      head_sha: expected,
      score_pct: 75,
      status: "warn",
      dimensions: { tests: { passed: 1, total: 1, band: 4, evidence_status: "complete" } },
      failed_invariant_ids: [],
      measured_at: "2026-08-04T12:00:00Z",
      profile_id: "fixture",
      profile_version: "1.0.0",
      evidence_status: "complete",
      quality_gate: "pass",
      automation_eligible: true,
      findings: [],
    })}\n`
  );
  const probe = String.raw`
import importlib.util, json, sys, types

package = types.ModuleType("aios_ingest")
analyzers = types.ModuleType("aios_ingest.analyzers")
scan_sha = sys.argv[3]
analyzers.analyze_repo = lambda *args, **kwargs: {
    "metrics": {
        "head_sha": scan_sha, "commits_window": 1, "ai_commits_window": 0
    }
}
class Client:
    def __init__(self, *args): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def push_codebase_scan(self, payload):
        print("PUSHED")
        return {"ok": True}
client = types.ModuleType("aios_ingest.brain_client")
client.BrainClient = Client
class Settings:
    base_url = "https://example.invalid"
    api_key = "fixture"
    team = "fixture"
    @classmethod
    def from_env(cls): return cls()
config = types.ModuleType("aios_ingest.config")
config.BrainSettings = Settings
sys.modules.update({
    "aios_ingest": package,
    "aios_ingest.analyzers": analyzers,
    "aios_ingest.brain_client": client,
    "aios_ingest.config": config,
})
spec = importlib.util.spec_from_file_location("scan_with_health", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sys.argv = [sys.argv[1], "--slug", "fixture", "--health-json", sys.argv[2],
            "--expected-head-sha", sys.argv[4]]
module.main()
`;
  try {
    const moved = spawnSync("python3", ["-c", probe, scanScript, healthPath, different, expected], {
      encoding: "utf8",
    });
    assert.notEqual(moved.status, 0);
    assert.doesNotMatch(moved.stdout, /PUSHED/);
    assert.match(moved.stderr, /refused upload/);

    const exact = spawnSync("python3", ["-c", probe, scanScript, healthPath, expected, expected], {
      encoding: "utf8",
    });
    assert.equal(exact.status, 0, exact.stderr);
    assert.match(exact.stdout, /PUSHED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
