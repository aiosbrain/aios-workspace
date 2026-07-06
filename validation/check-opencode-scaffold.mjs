#!/usr/bin/env node
/**
 * check-opencode-scaffold.mjs — OGR12: scaffold ships OpenCode-native dual citizenship.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
let errors = 0;
const fail = (m) => {
  console.log(`  ${RED}✗${NC} ${m}`);
  errors++;
};
const ok = (m) => console.log(`  ${GREEN}✓${NC} ${m}`);

console.log("OGR12: scaffold ships OpenCode-native surface");
console.log("============================================");

const tmp = mkdtempSync(path.join(tmpdir(), "ogr12-"));
const ws = path.join(tmp, "ws");
try {
  execFileSync(
    "bash",
    [
      path.join(REPO, "scripts", "scaffold-project.sh"),
      "--slug",
      "ogr12-check",
      "--owner",
      "tester",
      "--context",
      "employee",
      "--output",
      ws,
      "--org",
      "test-org",
    ],
    { cwd: REPO, stdio: "pipe", env: { ...process.env, CI: "1" } },
  );
} catch (e) {
  fail(`scaffold-project.sh failed: ${String(e.stderr || e.message).split("\n")[0]}`);
}

if (existsSync(ws)) {
  const cfgPath = path.join(ws, "opencode.json");
  if (!existsSync(cfgPath)) fail("workspace missing opencode.json");
  else {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    if (cfg.default_agent !== "aios-orchestrator") fail("default_agent must be aios-orchestrator");
    else ok("opencode.json default_agent");
    if (!Array.isArray(cfg.instructions) || !cfg.instructions.includes(".claude/rules/access-control.md")) {
      fail("opencode.json missing governance instructions");
    } else ok("opencode.json instructions");
    if (!Array.isArray(cfg.plugin) || cfg.plugin.length === 0) fail("opencode.json missing plugin");
    else ok("opencode.json plugin");
  }

  for (const agent of [
    "aios-orchestrator.md",
    "decision-extractor.md",
    "scope-auditor.md",
    "weekly-synthesizer.md",
  ]) {
    const p = path.join(ws, ".opencode", "agents", agent);
    if (!existsSync(p)) fail(`missing agent ${agent}`);
    else {
      const text = readFileSync(p, "utf8");
      if (!text.includes("AIOS workspace")) fail(`${agent} missing AIOS workspace phrase`);
      else ok(`${agent} present`);
    }
  }

  const cmdDir = path.join(ws, ".opencode", "command");
  const cmdFiles = existsSync(cmdDir) ? readdirSync(cmdDir).filter((f) => f.endsWith(".md")) : [];
  if (cmdFiles.length < 6) fail(`expected >=6 OpenCode commands, got ${cmdFiles.length}`);
  else ok(`${cmdFiles.length} OpenCode commands`);

  const plugin = path.join(ws, ".opencode", "plugins", "aios-instincts.ts");
  if (!existsSync(plugin)) fail("missing aios-instincts plugin");
  else ok("instincts plugin source");

  const index = readFileSync(path.join(ws, "0-context", "index.md"), "utf8");
  if (!index.includes("runtime-agnostic")) fail("0-context/index.md missing runtime-agnostic blurb");
  else ok("0-context/index.md agent layer");

  const agentsMd = readFileSync(path.join(ws, "AGENTS.md"), "utf8");
  if (!agentsMd.includes(".opencode")) fail("AGENTS.md missing OpenCode section");
  else ok("AGENTS.md OpenCode section");
} else {
  fail("no workspace generated");
}

try {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
} catch {
  /* best-effort */
}

console.log("============================================");
if (errors === 0) {
  console.log(`${GREEN}OGR12 PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}OGR12 FAILED — ${errors} issue(s)${NC}`);
process.exit(1);
