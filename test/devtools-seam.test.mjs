// Devtools-seam guarantee (AIO-594; docs/devtools-toolkit-contract.md): the devtools-bound
// file set must not statically (or via literal dynamic import/require) import the stays-core
// engine set — those modules are reachable only through the toolkit-locate seam. This is the
// rehearsal's F1/F3/F4/F6 regression test; scripts/check-boundaries.mjs cannot express it
// (R6 covers the opposite direction), so it lives here, reusing the gate's parser mechanics.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The devtools path set (mirrors DEVTOOLS_PATH_RE in scripts/check-boundaries.mjs).
const DEVTOOLS_FILES = [
  "scripts/ship.mjs",
  "scripts/build.mjs",
  "scripts/roadmap-run.mjs",
  "scripts/spec-eval.mjs",
  "scripts/spec-publish.mjs",
  "scripts/consolidate-findings.mjs",
  ...readdirSync(path.join(repoRoot, "scripts", "ship"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `scripts/ship/${f}`),
];

// Stays-core modules the seam declares (contract table) — never a direct import target.
const FORBIDDEN = [
  /^\.\.?\/review-bugbot(\.mjs|\/)/,
  /^\.\.?\/simplify\.mjs$/,
  /^\.\.?\/relay\.mjs$/,
  /^\.\.?\/spec-author\.mjs$/,
];

// Parser mechanics mirror scripts/check-boundaries.mjs (static import/export-from, bare
// import, literal dynamic import()/require()).
function parseImports(content) {
  const specs = [];
  const reFrom = /^[ \t]*(?:export|import)\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/gm;
  const reBare = /^\s*import\s+["']([^"']+)["']/gm;
  const reDyn = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [reFrom, reBare, reDyn]) {
    let m;
    while ((m = re.exec(content)) !== null) specs.push(m[1]);
  }
  return specs;
}

test("devtools files reach stays-core engines only through the toolkit seam", () => {
  const violations = [];
  for (const rel of DEVTOOLS_FILES) {
    const content = readFileSync(path.join(repoRoot, rel), "utf8");
    for (const spec of parseImports(content)) {
      if (FORBIDDEN.some((re) => re.test(spec))) violations.push(`${rel} → ${spec}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `devtools files must load stays-core modules via loadToolkitModule() ` +
      `(docs/devtools-toolkit-contract.md), found direct imports:\n${violations.join("\n")}`
  );
});

test("the seam file set matches check-boundaries' devtools set (drift guard)", () => {
  const gate = readFileSync(path.join(repoRoot, "scripts", "check-boundaries.mjs"), "utf8");
  // Scope to the DEVTOOLS_PATH_RE definition itself — a whole-file substring search could
  // be satisfied by an unrelated comment while the regex omits a file (CodeRabbit, #511).
  const def = gate.match(/const DEVTOOLS_PATH_RE\s*=\s*([\s\S]*?);/);
  assert.ok(def, "DEVTOOLS_PATH_RE definition missing from check-boundaries.mjs");
  // Every non-ship/ member must appear in DEVTOOLS_PATH_RE; ship/ is covered by `ship\/`.
  for (const rel of DEVTOOLS_FILES.filter((f) => !f.startsWith("scripts/ship/"))) {
    const base = rel.replace("scripts/", "").replace(".mjs", "");
    assert.ok(def[1].includes(base), `${rel} missing from check-boundaries DEVTOOLS_PATH_RE`);
  }
});

test("build resolves the review engine only on a Bugbot-enabled path", () => {
  const build = readFileSync(path.join(repoRoot, "scripts", "build.mjs"), "utf8");
  const gateStart = build.indexOf("if (bugbot && !dryRun)");
  const eagerLoad = build.indexOf('loadToolkitModule("review-bugbot.mjs")');
  assert.ok(gateStart >= 0, "build must retain the Bugbot-enabled gate");
  assert.ok(
    eagerLoad > gateStart,
    "build must not require a toolkit checkout when the Bugbot engine is disabled"
  );
});
