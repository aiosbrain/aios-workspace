#!/usr/bin/env node
// check-runtime-adapters.mjs — OGR07: BYOA runtime registry + GUI adapter contract.
//
// Validates the single source of truth (scripts/runtimes.mjs), the flat-YAML
// config reader, and the GUI adapter registry's resolution rules — WITHOUT
// requiring any external runtime CLI (hermes/codex/opencode) to be installed.
// Live runtime smoke tests are separate/opt-in. See docs/byoa.md.
//
// Usage: ./validation/check-runtime-adapters.mjs [repo]  (repo arg unused; kept
// for validate-all.sh's run_check signature). Wired into validate-all.sh.

import path from "node:path";
import { fileURLToPath } from "node:url";

const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
const DIR = path.dirname(fileURLToPath(import.meta.url));
let errors = 0;
const fail = (m) => {
  console.log(`  ${RED}✗${NC} ${m}`);
  errors++;
};
const ok = (m) => console.log(`  ${GREEN}✓${NC} ${m}`);

console.log("OGR07: BYOA runtime registry + GUI adapter contract");
console.log("================================================");

// 1. Canonical registry (pure, no deps)
const { RUNTIMES, RUNTIME_NAMES, EXPORT_RUNTIMES, GUI_RUNTIMES } = await import(
  path.join(DIR, "..", "scripts", "runtimes.mjs")
);

const expected = ["claude-code", "hermes", "openclaw", "codex", "opencode", "claude-api"];
for (const n of expected) {
  if (!(n in RUNTIMES)) fail(`registry missing runtime '${n}'`);
}
if (RUNTIMES["claude-api"].gui !== null) fail("claude-api must be gui:null (not GUI-drivable)");
if (RUNTIMES["claude-code"]?.gui?.driver !== "claude-sdk")
  fail("claude-code must use driver 'claude-sdk'");
// Views must be consistent with the source
for (const n of RUNTIME_NAMES) {
  if (RUNTIMES[n].export && !(n in EXPORT_RUNTIMES)) fail(`${n} missing from EXPORT_RUNTIMES view`);
  if (RUNTIMES[n].gui && !(n in GUI_RUNTIMES)) fail(`${n} missing from GUI_RUNTIMES view`);
}
if (!errors) ok(`registry: ${RUNTIME_NAMES.length} runtimes, views consistent, claude-api non-GUI`);

// 2. Flat-YAML config reader (pure, no deps)
const { parseFlatYaml } = await import(path.join(DIR, "..", "scripts", "flat-yaml.mjs"));
const parsed = parseFlatYaml("version: 1\nagent_runtime: hermes\nagent_model: m\n");
if (parsed.agent_runtime !== "hermes") fail("parseFlatYaml did not read agent_runtime");
else ok("flat-yaml reads agent_runtime");

// 3+4. GUI adapter registry + host-side write guard — NOT CHECKED HERE, BY DESIGN.
//
// These used to import gui/server/runtime-adapters/{index,guard}.mjs and validate them against
// the core-owned contract in packages/foundation/src/adapter-contract.mjs (AIO-600 C5), skipping
// with a note whenever gui/server was absent. AIO-612 moved gui/ to aiosbrain/aios-workspace-gui,
// so that path can now NEVER resolve — the checks would skip on every single run, forever.
//
// A check that cannot succeed is worse than no check: it prints a reassuring "—" and looks like
// coverage. The enforcing side is the GUI repo's own co-located
// gui/server/runtime-adapters/adapter-contract.test.mjs, which runs the SAME contract functions.
// This repo still OWNS the contract (adapter-contract.mjs stays here and the GUI repo consumes
// it), so a contract change is still made here first — it is just verified there.
//
// If you are reinstating a check on the GUI registry, it belongs in aios-workspace-gui.

console.log("================================================");
if (errors === 0) {
  console.log(`${GREEN}OGR07 PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}OGR07 FAILED — ${errors} issue(s)${NC}`);
process.exit(1);
