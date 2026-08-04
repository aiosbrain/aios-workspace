import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflowPath = fileURLToPath(
  new URL("../.github/workflows/scan-on-merge.yml", import.meta.url)
);
const workflow = readFileSync(workflowPath, "utf8");
const scaffoldWorkflowPath = fileURLToPath(
  new URL("../scaffold/.github/workflows/scan-on-merge.yml", import.meta.url)
);
const scaffoldWorkflow = readFileSync(scaffoldWorkflowPath, "utf8");
const fetchScriptPath = fileURLToPath(
  new URL("../.github/scripts/fetch-brain-scanner.sh", import.meta.url)
);
const fetchScript = readFileSync(fetchScriptPath, "utf8");
const scanWithHealthPath = fileURLToPath(
  new URL("../.github/scripts/scan_with_health.py", import.meta.url)
);
const scaffoldScanWithHealthPath = fileURLToPath(
  new URL("../scaffold/.github/scripts/scan_with_health.py", import.meta.url)
);
const scanWithHealth = readFileSync(scanWithHealthPath, "utf8");
const scaffoldScanWithHealth = readFileSync(scaffoldScanWithHealthPath, "utf8");

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const SETUP_PYTHON_SHA = "5fda3b95a4ea91299a34e894583c3862153e4b97";
const BRAIN_SHA = "8c29919236e602af63508abf5e988d4ab1d97eff";

function workflowSteps(contents) {
  const lines = contents.split("\n");
  const starts = lines.flatMap((line, index) => (/^ {6}- /.test(line) ? [index] : []));
  return starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length).join("\n")
  );
}

test("scan-on-merge grants only read access to repository contents", () => {
  assert.match(workflow, /permissions:\n {2}contents: read\n/);
  assert.doesNotMatch(workflow, /(?:contents|actions|checks|packages|pull-requests): write/);
});

test("scan-on-merge pins every third-party action to an immutable commit", () => {
  assert.equal(
    (workflow.match(new RegExp(`actions/checkout@${CHECKOUT_SHA}`, "g")) ?? []).length,
    1
  );
  assert.match(workflow, new RegExp(`actions/setup-node@${SETUP_NODE_SHA}`));
  assert.match(workflow, new RegExp(`actions/setup-python@${SETUP_PYTHON_SHA}`));

  for (const [name, contents] of [
    ["repository", workflow],
    ["scaffold", scaffoldWorkflow],
  ]) {
    const actionRefs = [...contents.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/g)].map(
      (match) => match[1]
    );
    assert.ok(actionRefs.length > 0);
    assert.ok(
      actionRefs.every((ref) => /^[0-9a-f]{40}$/.test(ref)),
      `${name}: ${actionRefs.join(", ")}`
    );
  }
});

test("Team Brain scanner checkout uses the anonymous fetch script", () => {
  assert.match(workflow, /run: bash \.github\/scripts\/fetch-brain-scanner\.sh \.brain-scanner/);
  assert.doesNotMatch(workflow, /BRAIN_REPO_TOKEN/);
  assert.doesNotMatch(workflow, /token:\s*["']{0,2}\s*$/m);
});

test("anonymous fetch is syntactically valid, sparse, credential-free, and fail-closed", () => {
  const syntax = spawnSync("bash", ["-n", fetchScriptPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);

  assert.match(fetchScript, new RegExp(`readonly BRAIN_SHA="${BRAIN_SHA}"`));
  assert.match(fetchScript, /GIT_CONFIG_NOSYSTEM=1/);
  assert.match(fetchScript, /GIT_CONFIG_GLOBAL=\/dev\/null/);
  assert.match(fetchScript, /GIT_TERMINAL_PROMPT=0/);
  assert.match(fetchScript, /GIT_ASKPASS=\/bin\/false/);
  assert.match(fetchScript, /git -c credential\.helper=/);
  assert.match(fetchScript, /sparse-checkout set ingestion/);
  assert.match(fetchScript, /fetch --depth=1 --filter=blob:none origin "\$BRAIN_SHA"/);
  assert.match(fetchScript, /resolved_sha[\s\S]*?!= "\$BRAIN_SHA"/);
  assert.match(fetchScript, /head_sha[\s\S]*?!= "\$BRAIN_SHA"/);
  assert.match(fetchScript, /ingestion\/pyproject\.toml/);
});

test("workspace checkout discards credentials", () => {
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 1);
  assert.equal((scaffoldWorkflow.match(/persist-credentials: false/g) ?? []).length, 1);
});

test("Brain secrets are scoped only to the configuration probe and final upload", () => {
  for (const [name, contents] of [
    ["repository", workflow],
    ["scaffold", scaffoldWorkflow],
  ]) {
    assert.doesNotMatch(contents, /^ {4}env:\n(?:^ {6}.+\n)+/m, `${name}: job env is forbidden`);
    const credentialSteps = workflowSteps(contents).filter((step) =>
      /secrets\.AIOS_(?:API_KEY|BRAIN_URL|TEAM)/.test(step)
    );
    assert.equal(credentialSteps.length, 2, name);
    assert.match(credentialSteps[0], /- name: Check Brain configuration/);
    assert.match(credentialSteps[1], /- name: Scan this (?:repo|workspace) into the brain/);
    for (const step of workflowSteps(contents).filter((candidate) =>
      /(?:uses:|npm (?:ci|install)|pip install|coverage|codebase health|Fetch the ingestion)/i.test(
        candidate
      )
    )) {
      if (/Check Brain configuration|Scan this (?:repo|workspace) into the brain/.test(step))
        continue;
      assert.doesNotMatch(step, /secrets\./, `${name}: setup step received a secret`);
      assert.doesNotMatch(step, /^\s+AIOS_API_KEY:/m);
    }
  }
});

test("secret-bearing scans can run only after a push to protected main", () => {
  for (const contents of [workflow, scaffoldWorkflow]) {
    assert.match(contents, /^on:\n {2}push:\n {4}branches: \[main\]$/m);
    assert.doesNotMatch(contents, /workflow_dispatch/);
    assert.doesNotMatch(contents, /pull_request(?:_target)?:/);
  }
});

test("scanner dependencies are exact, hashed, binary-only, and scaffolded", () => {
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(scaffoldWorkflow, /npm install -g @aiosbrain\/aios@0\.9\.1 --ignore-scripts/);
  assert.match(scaffoldWorkflow, /npm ci --ignore-scripts/);
  assert.doesNotMatch(scaffoldWorkflow, /npm ci \|\| npm install/);
  for (const contents of [workflow, scaffoldWorkflow]) {
    assert.match(contents, /pip install --only-binary=:all: --require-hashes/);
    assert.doesNotMatch(contents, /pip install -e/);
  }

  const requirements = readFileSync(
    fileURLToPath(new URL("../.github/scripts/brain-scanner-requirements.txt", import.meta.url)),
    "utf8"
  );
  const scaffoldRequirements = readFileSync(
    fileURLToPath(
      new URL("../scaffold/.github/scripts/brain-scanner-requirements.txt", import.meta.url)
    ),
    "utf8"
  );
  assert.equal(scaffoldRequirements, requirements);
  const requirementLines = requirements.split("\n").filter((line) => /^[a-z]/.test(line));
  assert.ok(requirementLines.length > 0);
  for (const line of requirementLines) assert.match(line, /^[a-z][a-z0-9-]*==[^ ]+ \\$/);
  assert.equal(
    (requirements.match(/--hash=sha256:[0-9a-f]{64}/g) ?? []).length,
    requirementLines.length
  );
});

test("optional coverage dependency failures do not abort the Brain scan", () => {
  for (const [name, contents] of [
    ["repository", workflow],
    ["scaffold", scaffoldWorkflow],
  ]) {
    assert.match(
      contents,
      /if npm ci --ignore-scripts; then[\s\S]*?npm run test:coverage \|\| true/,
      name
    );
    assert.match(
      contents,
      /else\n\s+echo "dependency install failed — continuing without a coverage report\."/,
      name
    );
  }
});

test("health upload failures are not retried with a destructive plain upload", () => {
  for (const [name, contents] of [
    ["repository", workflow],
    ["scaffold", scaffoldWorkflow],
  ]) {
    assert.doesNotMatch(
      contents,
      /scan_with_health\.py[\s\S]*?\|\|\s+python -m aios_ingest\.cli scan/,
      name
    );
  }
});

test("repository and scaffold scanners preserve the exact-head fail-closed mode", () => {
  for (const [name, contents] of [
    ["repository", scanWithHealth],
    ["scaffold", scaffoldScanWithHealth],
  ]) {
    assert.match(contents, /"--expected-head-sha"/, name);
    assert.match(contents, /len\(args\.expected_head_sha\) != 40/, name);
    assert.match(contents, /health\["head_sha"\] != args\.expected_head_sha/, name);
    assert.match(contents, /scan_sha != args\.expected_head_sha/, name);
    assert.match(contents, /exact-head patrol refused upload/, name);
  }
});

test("health transport accepts closed v1/v1.0/v2 shapes and rejects extra fields", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-with-health-"));
  const probe = `
import importlib.util, json, sys, types

package = types.ModuleType("aios_ingest")
analyzers = types.ModuleType("aios_ingest.analyzers")
analyzers.analyze_repo = lambda *args, **kwargs: None
client = types.ModuleType("aios_ingest.brain_client")
client.BrainClient = object
config = types.ModuleType("aios_ingest.config")
config.BrainSettings = object
sys.modules.update({
    "aios_ingest": package,
    "aios_ingest.analyzers": analyzers,
    "aios_ingest.brain_client": client,
    "aios_ingest.config": config,
})
spec = importlib.util.spec_from_file_location("scan_with_health", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.load_health(sys.argv[2])))
`;
  const base = {
    schema_version: "1",
    rubric_version: "1.1.0",
    head_sha: "abc1234",
    score_pct: 75,
    status: "warn",
    dimensions: { tests: { passed: 1, total: 2 } },
    failed_invariant_ids: [],
    measured_at: "2026-08-04T00:00:00Z",
  };
  const v2 = {
    ...base,
    schema_version: "2",
    profile_id: "aios.workspace",
    profile_version: "1.0.0",
    evidence_status: "partial",
    quality_gate: "unknown",
    automation_eligible: false,
    findings: [],
  };
  const load = (scriptPath, name, health) => {
    const fixture = path.join(dir, `${name}.json`);
    writeFileSync(fixture, `${JSON.stringify(health)}\n`);
    const result = spawnSync("python3", ["-c", probe, scriptPath, fixture], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    for (const [name, scriptPath] of [
      ["repository", scanWithHealthPath],
      ["scaffold", scaffoldScanWithHealthPath],
    ]) {
      assert.deepEqual(load(scriptPath, `${name}-v1`, base), base);
      assert.deepEqual(load(scriptPath, `${name}-v1.0`, { ...base, schema_version: "1.0" }), {
        ...base,
        schema_version: "1.0",
      });
      assert.deepEqual(load(scriptPath, `${name}-v2`, v2), v2);
      assert.equal(load(scriptPath, `${name}-v2-extra`, { ...v2, path: "secret/file" }), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scaffold's exact toolkit pin resolves from the public npm registry", () => {
  const match = scaffoldWorkflow.match(
    /npm install -g (@aiosbrain\/aios@(\d+\.\d+\.\d+)) --ignore-scripts/
  );
  assert.ok(match, "missing exact toolkit install pin");
  const [, specifier, expectedVersion] = match;
  const result = spawnSync("npm", ["view", specifier, "version", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(JSON.parse(result.stdout), expectedVersion);
});
