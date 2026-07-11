#!/usr/bin/env node
// test/modularity.test.mjs — unit tests for OGR13 (validation/check-modularity.mjs).
// The codebase-memory binary is mocked (cmMcp fake); no graph, no network.
// The advisory/ratchet CLI contract is exercised in a child process with a stub binary.
// Run: node test/modularity.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveProject,
  collectMetrics,
  compareToBaseline,
} from "../validation/check-modularity.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

const CONFIG = {
  mode: "advisory",
  thresholds: { hotspotMinDegree: 25, complexityMin: 15 },
  ratchet: {
    maxDeadCodeDelta: 0,
    maxHotspotDelta: 0,
    maxHighComplexityDelta: 0,
    maxMutualRecursionDelta: 0,
  },
};

// Fake graph backend: records calls, scripted per-tool responses.
function makeFake(repoAbs, { indexed = true } = {}) {
  const calls = [];
  const project = "fake-project";
  const fn = (tool, args) => {
    calls.push({ tool, args });
    if (tool === "list_projects") {
      return indexed || calls.some((c) => c.tool === "index_repository")
        ? { projects: [{ name: project, root_path: repoAbs }] }
        : { projects: [] };
    }
    if (tool === "index_repository") return { ok: true };
    if (tool === "query_graph") {
      const q = args.query;
      if (q.includes("complexity")) return { rows: [["48"]] };
      if (q.includes("CALLS")) return { rows: [["3717"]] };
      return { rows: [["2197"]] };
    }
    if (tool === "search_graph") {
      if (args.max_degree === 0) return { total: 5345, results: [] };
      return {
        total: 61,
        results: [{ name: "BigFn", file_path: "src/big.ts", out_degree: 31 }],
      };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  return { fn, calls };
}

console.log("resolveProject");
{
  const abs = path.resolve("/repo/x");
  const f1 = makeFake(abs);
  check("existing project resolved by root_path", resolveProject(abs, f1.fn) === "fake-project");
  check("no index call when already indexed", !f1.calls.some((c) => c.tool === "index_repository"));

  const f2 = makeFake(abs, { indexed: false });
  check("unindexed repo gets indexed then resolved", resolveProject(abs, f2.fn) === "fake-project");
  const idx = f2.calls.find((c) => c.tool === "index_repository");
  check("index_repository called with repo_path", idx && idx.args.repo_path === abs);
}

console.log("collectMetrics");
{
  const abs = path.resolve("/repo/x");
  const f = makeFake(abs);
  const m = collectMetrics({ repoPath: abs, cmMcp: f.fn, config: CONFIG });
  check("functions from cypher", m.functions === 2197);
  check("dead code from search total", m.deadCode === 5345);
  check("hotspots from search total", m.fanOutHotspots === 61);
  check("high complexity from cypher", m.highComplexity === 48);
  check("mutual recursion from cypher", m.mutualRecursion === 3717);
  check(
    "hotspot top mapped to {name,file,outDegree}",
    m.hotspotTop[0].name === "BigFn" && m.hotspotTop[0].outDegree === 31
  );
  check(
    "threshold flows into the hotspot query",
    f.calls.some((c) => c.tool === "search_graph" && c.args.min_degree === 25)
  );
  check(
    "threshold flows into the complexity query",
    f.calls.some((c) => c.tool === "query_graph" && /complexity > 15/.test(c.args.query ?? ""))
  );
}

console.log("compareToBaseline");
{
  const metrics = {
    deadCode: 5350,
    fanOutHotspots: 61,
    highComplexity: 47,
    mutualRecursion: 3717,
  };
  const baseline = {
    deadCode: 5345,
    fanOutHotspots: 61,
    highComplexity: 48,
    mutualRecursion: 3717,
  };
  const { deltas, breaches } = compareToBaseline(metrics, baseline, CONFIG);
  check("positive delta computed", deltas.deadCode === 5);
  check("improvement is a negative delta", deltas.highComplexity === -1);
  check(
    "only the worsened metric breaches",
    breaches.length === 1 && breaches[0].metric === "deadCode"
  );
  check("breach carries base/now/limit", breaches[0].base === 5345 && breaches[0].limit === 0);

  const noBase = compareToBaseline(metrics, null, CONFIG);
  check(
    "no baseline → null deltas, no breaches",
    noBase.deltas.deadCode === null && noBase.breaches.length === 0
  );
}

console.log("CLI contract (stubbed binary in child process)");
{
  // A stub `codebase-memory-mcp` on PATH: answers every cli call from a canned map.
  const bin = mkdtempSync(path.join(tmpdir(), "ogr13-bin-"));
  const repo = mkdtempSync(path.join(tmpdir(), "ogr13-repo-"));
  const stub = path.join(bin, "codebase-memory-mcp");
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const tool = process.argv[3];
const args = JSON.parse(process.argv[4] ?? "{}");
if (tool === "list_projects") console.log(JSON.stringify({ projects: [{ name: "p", root_path: ${JSON.stringify(repo)} }] }));
else if (tool === "query_graph") console.log(JSON.stringify({ rows: [[args.query.includes("complexity") ? "48" : args.query.includes("CALLS") ? "3717" : "2197"]] }));
else if (tool === "search_graph") console.log(JSON.stringify(args.max_degree === 0 ? { total: 9999, results: [] } : { total: 61, results: [] }));
else console.log("{}");
`
  );
  chmodSync(stub, 0o755);

  const script = path.join(REPO_ROOT, "validation", "check-modularity.mjs");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const run = () => {
    try {
      const stdout = execFileSync(process.execPath, [script, repo, "--json"], {
        env,
        encoding: "utf8",
        // The validator reads config/baseline beside itself in validation/ — that's the
        // real repo's advisory config, which is what we want to exercise.
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout };
    } catch (e) {
      return { code: e.status, stdout: e.stdout ?? "" };
    }
  };

  const r = run();
  check("advisory mode exits 0 even with a huge dead-code regression", r.code === 0);
  const report = JSON.parse(r.stdout);
  check("json report carries metrics", report.metrics.deadCode === 9999);
  check(
    "dead-code breach reported vs committed baseline",
    report.breaches.some((b) => b.metric === "deadCode")
  );
  check("mode is advisory from committed config", report.mode === "advisory");

  // Missing binary → advisory skip, still exit 0 (CI runners without the binary).
  try {
    const out = execFileSync(process.execPath, [script, repo, "--json"], {
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    check("missing binary → exit 0 (advisory skip)", true);
    void out;
  } catch {
    check("missing binary → exit 0 (advisory skip)", false);
  }

  rmSync(bin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}

console.log("committed baseline sanity");
{
  const baseline = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "validation", "modularity-baseline.json"), "utf8")
  );
  for (const k of ["deadCode", "fanOutHotspots", "highComplexity", "mutualRecursion"]) {
    check(`baseline has numeric ${k}`, Number.isFinite(baseline[k]));
  }
}

if (failed) {
  console.error(`\n${RED}${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}all modularity checks passed${NC}`);
