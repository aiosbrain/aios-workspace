#!/usr/bin/env node
// check-modularity.mjs — OGR13: Codebase Modularity (ADVISORY, ratchetable)
//
// Deterministic architecture metrics from the codebase-memory knowledge graph
// (`codebase-memory-mcp cli <tool> <json>` — headless, zero LLM calls):
//   functions        total Function nodes (context, never gated)
//   deadCode         functions with no in/out edges, entry points excluded
//   fanOutHotspots   functions with out_degree ≥ thresholds.hotspotMinDegree (+ top-10 list)
//   highComplexity   functions with complexity > thresholds.complexityMin
//   mutualRecursion  a→b→a CALLS pairs (raw edge-pattern count)
//
// Compares against the committed baseline (validation/modularity-baseline.json) and
// prints deltas. In `mode: "advisory"` (validation/modularity.config.json) it ALWAYS
// exits 0; flipping to `mode: "ratchet"` makes any delta beyond the configured
// ratchet limits exit 1 (the Hashimoto pattern: observe first, then lock the ratchet).
//
// Usage: ./validation/check-modularity.mjs [repo-path] [--json] [--update-baseline]
// Wired into validate-all.sh as OGR13; surfaced by `aios assess-codebase`.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  YELLOW = "\x1b[0;33m",
  BLUE = "\x1b[0;34m",
  NC = "\x1b[0m";

const DEFAULT_CONFIG = {
  mode: "advisory",
  thresholds: { hotspotMinDegree: 25, complexityMin: 15 },
  ratchet: {
    maxDeadCodeDelta: 0,
    maxHotspotDelta: 0,
    maxHighComplexityDelta: 0,
    maxMutualRecursionDelta: 0,
  },
};

export function loadJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// cmMcp — one-shot headless call into the codebase-memory binary. Strips the
// `level=info` log noise the binary writes to stderr; parses the JSON line.
export function makeCmMcp(bin = "codebase-memory-mcp") {
  return (tool, argsObj) => {
    const out = execFileSync(bin, ["cli", tool, JSON.stringify(argsObj)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const line = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("{") || l.startsWith("["));
    if (!line) throw new Error(`${tool}: no JSON in output`);
    const parsed = JSON.parse(line);
    if (parsed && parsed.error) throw new Error(`${tool}: ${parsed.error}`);
    return parsed;
  };
}

// Resolve the graph project for a repo path; index it when absent (CI runners and
// fresh worktrees are path-distinct projects, so indexing is the normal first step).
export function resolveProject(repoPath, cmMcp) {
  const abs = path.resolve(repoPath);
  const { projects = [] } = cmMcp("list_projects", {});
  const hit = projects.find((p) => p.root_path === abs);
  if (hit) return hit.name;
  cmMcp("index_repository", { repo_path: abs });
  const after = cmMcp("list_projects", {}).projects ?? [];
  const fresh = after.find((p) => p.root_path === abs);
  if (!fresh) throw new Error(`indexing ${abs} did not register a project`);
  return fresh.name;
}

const cypherCount = (cmMcp, project, query) => {
  const r = cmMcp("query_graph", { project, query });
  return Number(r?.rows?.[0]?.[0] ?? 0);
};

export function collectMetrics({ repoPath, cmMcp, config }) {
  const project = resolveProject(repoPath, cmMcp);
  const t = config.thresholds;

  const functions = cypherCount(cmMcp, project, "MATCH (f:Function) RETURN count(f) AS n");
  const dead = cmMcp("search_graph", {
    project,
    node_type: "function",
    max_degree: 0,
    exclude_entry_points: true,
    limit: 1,
  });
  const hotspots = cmMcp("search_graph", {
    project,
    node_type: "function",
    min_degree: t.hotspotMinDegree,
    direction: "outbound",
    limit: 10,
  });
  const highComplexity = cypherCount(
    cmMcp,
    project,
    `MATCH (f:Function) WHERE f.complexity > ${t.complexityMin} RETURN count(f) AS n`
  );
  const mutualRecursion = cypherCount(
    cmMcp,
    project,
    "MATCH (a:Function)-[:CALLS]->(b:Function)-[:CALLS]->(a) RETURN count(*) AS n"
  );

  return {
    project,
    functions,
    deadCode: dead?.total ?? 0,
    fanOutHotspots: hotspots?.total ?? 0,
    hotspotTop: (hotspots?.results ?? []).map((r) => ({
      name: r.name,
      file: r.file_path,
      outDegree: r.out_degree,
    })),
    highComplexity,
    mutualRecursion,
  };
}

const GATED = [
  ["deadCode", "maxDeadCodeDelta"],
  ["fanOutHotspots", "maxHotspotDelta"],
  ["highComplexity", "maxHighComplexityDelta"],
  ["mutualRecursion", "maxMutualRecursionDelta"],
];

export function compareToBaseline(metrics, baseline, config) {
  const deltas = {};
  const breaches = [];
  for (const [key, limitKey] of GATED) {
    const base = baseline?.[key];
    const delta = base == null ? null : metrics[key] - base;
    deltas[key] = delta;
    const limit = config.ratchet?.[limitKey];
    if (delta != null && limit != null && delta > limit) {
      breaches.push({ metric: key, base, now: metrics[key], delta, limit });
    }
  }
  return { deltas, breaches };
}

// buildReport — the full advisory report (config + baseline + deltas) for embedding
// (`aios assess-codebase`). Returns null on ANY failure: missing binary, unindexable
// repo — modularity data is best-effort information there, never a hard dependency.
export function buildReport(repoPath, { cmMcp = null } = {}) {
  try {
    const config = {
      ...DEFAULT_CONFIG,
      ...(loadJson(path.join(HERE, "modularity.config.json"), {}) ?? {}),
    };
    const baseline = loadJson(path.join(HERE, "modularity-baseline.json"));
    const metrics = collectMetrics({ repoPath, cmMcp: cmMcp ?? makeCmMcp(), config });
    const { deltas, breaches } = compareToBaseline(metrics, baseline, config);
    return { mode: config.mode, metrics, baseline, deltas, breaches };
  } catch {
    return null;
  }
}

// formatReportLines — the two-line human summary used by `aios assess-codebase`.
export function formatReportLines(report) {
  const m = report.metrics;
  const d = report.deltas ?? {};
  const delta = (k) => (d[k] == null ? "" : ` (${d[k] >= 0 ? "+" : ""}${d[k]} vs baseline)`);
  return [
    `  Modularity (OGR13, ${report.mode}):`,
    `    dead code ${m.deadCode}${delta("deadCode")} · hotspots ${m.fanOutHotspots}${delta("fanOutHotspots")} · high-complexity ${m.highComplexity}${delta("highComplexity")} · mutual recursion ${m.mutualRecursion}${delta("mutualRecursion")}`,
  ];
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const updateBaseline = args.includes("--update-baseline");
  const repoPath = args.find((a) => !a.startsWith("--")) || ".";

  const configFile = path.join(HERE, "modularity.config.json");
  const baselineFile = path.join(HERE, "modularity-baseline.json");
  const config = { ...DEFAULT_CONFIG, ...(loadJson(configFile, {}) ?? {}) };
  const baseline = loadJson(baselineFile);

  let metrics;
  try {
    metrics = collectMetrics({ repoPath, cmMcp: makeCmMcp(), config });
  } catch (e) {
    // Advisory even when the binary is missing/unindexable — modularity data is
    // information, not a governance gate (and CI runners may not carry the binary).
    console.error(`OGR13: could not collect modularity metrics: ${e.message}`);
    process.exit(0);
  }

  const { deltas, breaches } = compareToBaseline(metrics, baseline, config);
  const report = {
    mode: config.mode,
    headSha: process.env.GITHUB_SHA ?? null,
    metrics,
    baseline: baseline ?? null,
    deltas,
    breaches,
  };

  if (updateBaseline) {
    const next = {
      updatedFrom: baseline?.headSha ?? null,
      headSha: report.headSha,
      functions: metrics.functions,
      deadCode: metrics.deadCode,
      fanOutHotspots: metrics.fanOutHotspots,
      highComplexity: metrics.highComplexity,
      mutualRecursion: metrics.mutualRecursion,
      hotspotTop: metrics.hotspotTop,
    };
    writeFileSync(baselineFile, JSON.stringify(next, null, 2) + "\n");
    if (!json) console.log(`${BLUE}OGR13${NC} baseline updated → ${baselineFile}`);
  }

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const fmt = (k) =>
      `${String(metrics[k]).padStart(6)}${deltas[k] == null ? "" : ` (${deltas[k] >= 0 ? "+" : ""}${deltas[k]} vs baseline)`}`;
    console.log(`${BLUE}OGR13 — Modularity${NC} (${metrics.project}, mode: ${config.mode})`);
    console.log(`  functions        ${String(metrics.functions).padStart(6)}`);
    console.log(`  dead code        ${fmt("deadCode")}`);
    console.log(
      `  fan-out hotspots ${fmt("fanOutHotspots")} (out_degree ≥ ${config.thresholds.hotspotMinDegree})`
    );
    console.log(
      `  high complexity  ${fmt("highComplexity")} (complexity > ${config.thresholds.complexityMin})`
    );
    console.log(`  mutual recursion ${fmt("mutualRecursion")}`);
    if (!baseline) {
      console.log(`  ${YELLOW}no baseline — run with --update-baseline to set one${NC}`);
    }
    for (const b of breaches) {
      const tag = config.mode === "ratchet" ? RED : YELLOW;
      console.log(
        `  ${tag}${b.metric}: ${b.base} → ${b.now} (+${b.delta} > limit ${b.limit})${NC}`
      );
    }
    if (!breaches.length && baseline) console.log(`  ${GREEN}no ratchet breaches${NC}`);
  }

  process.exit(config.mode === "ratchet" && breaches.length ? 1 : 0);
}
