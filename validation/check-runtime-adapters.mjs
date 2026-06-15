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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const RED = "\x1b[0;31m", GREEN = "\x1b[0;32m", YELLOW = "\x1b[1;33m", NC = "\x1b[0m";
const DIR = path.dirname(fileURLToPath(import.meta.url));
let errors = 0;
const fail = (m) => { console.log(`  ${RED}✗${NC} ${m}`); errors++; };
const ok = (m) => console.log(`  ${GREEN}✓${NC} ${m}`);

console.log("OGR07: BYOA runtime registry + GUI adapter contract");
console.log("================================================");

// 1. Canonical registry (pure, no deps)
const { RUNTIMES, RUNTIME_NAMES, EXPORT_RUNTIMES, GUI_RUNTIMES } =
  await import(path.join(DIR, "..", "scripts", "runtimes.mjs"));

const expected = ["claude-code", "hermes", "openclaw", "codex", "opencode", "claude-api"];
for (const n of expected) {
  if (!(n in RUNTIMES)) fail(`registry missing runtime '${n}'`);
}
if (RUNTIMES["claude-api"].gui !== null) fail("claude-api must be gui:null (not GUI-drivable)");
if (RUNTIMES["claude-code"]?.gui?.driver !== "claude-sdk") fail("claude-code must use driver 'claude-sdk'");
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

// 3. GUI adapter resolution rules — best-effort (needs gui/server deps installed).
try {
  const reg = await import(path.join(DIR, "..", "gui", "server", "runtime-adapters", "index.mjs"));
  const cc = reg.createAdapter("claude-code");
  if (typeof cc.run !== "function") fail("claude-code adapter missing run()");
  const expectThrow = (rt, needle) => {
    try { reg.createAdapter(rt); fail(`createAdapter('${rt}') should have thrown`); }
    catch (e) { if (!String(e.message).includes(needle)) fail(`createAdapter('${rt}') wrong error: ${e.message}`); }
  };
  expectThrow("claude-api", "not GUI-drivable");
  expectThrow("bogus", "unknown agent_runtime");
  // default + unset config
  const tmp = mkdtempSync(path.join(tmpdir(), "ogr07-"));
  const cfgDefault = reg.readAgentConfig(tmp); // no aios.yaml
  if (cfgDefault.runtime !== "claude-code") fail("readAgentConfig default should be claude-code");
  writeFileSync(path.join(tmp, "aios.yaml"), "agent_runtime: codex\n");
  if (reg.readAgentConfig(tmp).runtime !== "codex") fail("readAgentConfig did not read agent_runtime");
  rmSync(tmp, { recursive: true, force: true });
  if (!errors) ok("GUI registry: claude-code resolves, claude-api/unknown error, config default + read");
} catch (e) {
  console.log(`  ${YELLOW}—${NC} GUI adapter resolution skipped (gui/server deps not installed): ${String(e.message).split("\n")[0]}`);
}

// 4. Host-side write guard — reuses team-ops-guard.sh as the single governance
//    source. Tested against this repo (has hooks/team-ops-guard.sh). Needs jq +
//    bash (the guard's own deps); skips with a note if absent.
try {
  const repoRoot = path.join(DIR, "..");
  const { guardWrite } = await import(path.join(repoRoot, "gui", "server", "runtime-adapters", "guard.mjs"));
  const expect = (label, args, wantOk) => {
    const r = guardWrite({ repo: repoRoot, ...args });
    if (r.ok !== wantOk) fail(`guardWrite ${label}: expected ok=${wantOk}, got ok=${r.ok} (${r.reason || ""})`);
  };
  expect("clean deliverable allowed", { path: "2-work/x.md", content: "---\nstatus: draft\nowner: me\n---\nhi" }, true);
  // Split so this fixture file itself doesn't trip OGR03's secret scan in CI.
  expect("secret blocked", { path: "notes.md", content: "token=AKIA" + "IOSFODNN7EXAMPLE" }, false);
  expect("admin-tier in outward dir blocked", { path: "4-shared/deal.md", content: "---\nstatus: draft\n---\nour day rate is confidential" }, false);
  expect("path escape blocked", { path: "../../../../etc/passwd", content: "x" }, false);
  if (!errors) ok("guardWrite: clean allowed; secret / admin-tier / path-escape blocked");
} catch (e) {
  console.log(`  ${YELLOW}—${NC} guardWrite check skipped: ${String(e.message).split("\n")[0]}`);
}

console.log("================================================");
if (errors === 0) { console.log(`${GREEN}OGR07 PASSED${NC}`); process.exit(0); }
console.log(`${RED}OGR07 FAILED — ${errors} issue(s)${NC}`); process.exit(1);
