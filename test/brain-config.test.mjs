#!/usr/bin/env node
// test/brain-config.test.mjs — resolveBrainConfig merges aios.yaml with env/.env.
// Spec: stamped workspaces put brain_url + team_id in aios.yaml and the API key in .env;
// OAuth/CLI/GUI must reach the brain without requiring duplicate AIOS_BRAIN_URL env.
// Zero-dep. Run: node test/brain-config.test.mjs

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveBrainConfig } from "../scripts/brain-config.mjs";

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

const repo = mkdtempSync(path.join(tmpdir(), "braincfg-"));
try {
  writeFileSync(
    path.join(repo, "aios.yaml"),
    "brain_url: https://brain-from-yaml.example\nteam_id: yaml-team\napi_key_env: AIOS_API_KEY\n"
  );
  writeFileSync(path.join(repo, ".env"), "AIOS_API_KEY=yaml-only-key\n");

  const savedBrain = process.env.AIOS_BRAIN_URL;
  const savedTeam = process.env.AIOS_TEAM;
  const savedKey = process.env.AIOS_API_KEY;
  delete process.env.AIOS_BRAIN_URL;
  delete process.env.AIOS_TEAM;
  // process.env wins over .env, so clear any ambient key (e.g. a dotenvx cascade)
  // to actually exercise the .env fallback path this test asserts.
  delete process.env.AIOS_API_KEY;

  const cfg = resolveBrainConfig(repo);
  check("brain_url falls back to aios.yaml", cfg.brain_url === "https://brain-from-yaml.example");
  check("team_id falls back to aios.yaml", cfg.team_id === "yaml-team");
  check("api_key from .env", cfg.api_key === "yaml-only-key");

  process.env.AIOS_BRAIN_URL = "https://env-wins.example";
  process.env.AIOS_TEAM = "env-team";
  const overridden = resolveBrainConfig(repo);
  check("AIOS_BRAIN_URL env wins over yaml", overridden.brain_url === "https://env-wins.example");
  check("AIOS_TEAM env wins over yaml", overridden.team_id === "env-team");

  if (savedBrain == null) delete process.env.AIOS_BRAIN_URL;
  else process.env.AIOS_BRAIN_URL = savedBrain;
  if (savedTeam == null) delete process.env.AIOS_TEAM;
  else process.env.AIOS_TEAM = savedTeam;
  if (savedKey == null) delete process.env.AIOS_API_KEY;
  else process.env.AIOS_API_KEY = savedKey;
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log("================================================");
if (failed === 0) {
  console.log(`${GREEN}brain-config tests PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}brain-config tests FAILED — ${failed} assertion(s)${NC}`);
process.exit(1);
