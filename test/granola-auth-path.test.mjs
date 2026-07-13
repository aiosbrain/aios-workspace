#!/usr/bin/env node
// test/granola-auth-path.test.mjs — AIO-356: the Granola connector is dual-auth (optional
// portable API key, falling back to the local desktop-app session) and previously picked
// a path silently. This asserts granolaAuthPath() (scripts/connector.mjs) and the
// `auth_path` field it feeds into listConnectors() correctly reports which path is active,
// without touching the real vault or the real Granola desktop-app token file.
//
// Zero-dep. Run: node test/granola-auth-path.test.mjs   (exit 0 = pass)

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { granolaAuthPath, listConnectors, vaultSet } from "../scripts/connector.mjs";

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

// Build a minimal repo dir with just enough of .claude/ for readDescriptors to find the
// bundled scaffold descriptors (connector.mjs falls back to the bundled scaffold when a
// repo has no local .claude/descriptors/ copy — see BUNDLED_SCAFFOLD in connector.mjs).
function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-granola-auth-"));
  mkdirSync(path.join(repo, ".claude"), { recursive: true });
  return repo;
}

let hasDotenvx = true;
try {
  execFileSync("dotenvx", ["--version"], { stdio: "ignore" });
} catch {
  hasDotenvx = false;
}

console.log("granola auth-path: no API key set → reports desktop-app session");
{
  const repo = makeRepo();
  const result = granolaAuthPath(repo);
  check("mode is desktop-app", result.mode === "desktop-app");
  check("label mentions desktop-app session", /desktop-app session/.test(result.label));
  rmSync(repo, { recursive: true, force: true });
}

if (hasDotenvx) {
  console.log("granola auth-path: GRANOLA_API_KEY set → reports api-key");
  {
    const repo = makeRepo();
    vaultSet(repo, "GRANOLA_API_KEY", "grn_fake_test_key");
    const result = granolaAuthPath(repo);
    check("mode is api-key", result.mode === "api-key");
    check("label is 'API key'", result.label === "API key");
    rmSync(repo, { recursive: true, force: true });
  }
} else {
  console.log(`  ${GREEN}✓${NC} (skipped: dotenvx not on PATH — api-key branch covered by CI)`);
}

console.log("granola auth-path: surfaced via listConnectors() for granola only");
{
  const repo = makeRepo();
  const connectors = listConnectors(repo);
  const granola = connectors.find((c) => c.id === "granola");
  check("granola connector is present", !!granola);
  check("granola.auth_path is set", !!(granola && granola.auth_path));
  check(
    "granola.auth_path.mode is desktop-app (no key set)",
    !!(granola && granola.auth_path && granola.auth_path.mode === "desktop-app")
  );
  const other = connectors.find((c) => c.id !== "granola");
  check(
    "a non-granola connector has auth_path: null (not a general mechanism)",
    other && other.auth_path === null
  );
  rmSync(repo, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${RED}${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}all checks passed${NC}`);
