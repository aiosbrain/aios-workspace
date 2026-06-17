#!/usr/bin/env node
// test/skill-install.test.mjs — the trust-tier + consent gate in gui/server/skill-library.mjs.
//
// Covers: official one-click install; community refused without consent; community
// installs with consent; and the HIGH → typed-confirm path (via a temp community.json
// that points at the high-risk evil fixture). Zero-dep. Run: node test/skill-install.test.mjs

import { mkdtempSync, mkdirSync, existsSync, cpSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSkillById, installSkill, listLibrary } from "../gui/server/skill-library.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY_DIR = path.join(DIR, "..", "gui", "server", "skill-library");
const COMMUNITY_JSON = path.join(LIBRARY_DIR, "community.json");

let failed = 0;
const RED = "\x1b[0;31m", GREEN = "\x1b[0;32m", NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else { console.log(`  ${RED}✗${NC} ${label}`); failed++; }
}
function freshRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "skrepo-"));
  mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
  return repo;
}

console.log("install: official tier is one-click");
{
  const repo = freshRepo();
  const out = installSkill(repo, "frontend-design"); // no consent arg
  check("installed", out.installed === true && out.tier === "official");
  check("on disk", existsSync(path.join(repo, ".claude/skills/frontend-design/SKILL.md")));
}

console.log("install: community 'community-example' (elevated) requires consent");
{
  const repo = freshRepo();
  const scan = scanSkillById("community-example");
  check("scan is elevated", scan.riskClass === "elevated");
  check("no typed confirm needed", scan.requiresTypedConfirm === false);
  let refused = false, scanAttached = false;
  try { installSkill(repo, "community-example"); } catch (e) { refused = true; scanAttached = !!e.scan; }
  check("refused without consent", refused);
  check("scan attached to error", scanAttached);
  check("not on disk after refusal", !existsSync(path.join(repo, ".claude/skills/community-example")));
  const out = installSkill(repo, "community-example", { accepted: true });
  check("installs with consent.accepted", out.installed === true && out.tier === "community");
}

console.log("install: a HIGH community skill requires a typed confirm");
{
  // Temporarily register the high-risk evil fixture as a community skill, then restore.
  const backup = readFileSync(COMMUNITY_JSON, "utf8");
  const evilDest = path.join(LIBRARY_DIR, "community", "evil-demo");
  try {
    cpSync(path.join(DIR, "skill-scan-fixtures", "evil-skill"), evilDest, { recursive: true });
    writeFileSync(COMMUNITY_JSON, JSON.stringify({
      skills: [{ id: "evil-demo", name: "evil-demo", category: "Community (unverified)", trust: "community",
        source: { kind: "vendored-demo", dir: "community/evil-demo" } }],
    }, null, 2) + "\n");

    const scan = scanSkillById("evil-demo");
    check("scan is high", scan.riskClass === "high");
    check("requiresTypedConfirm true", scan.requiresTypedConfirm === true);
    check("listed in community", listLibrary(freshRepo()).community.some((s) => s.id === "evil-demo"));

    const repo = freshRepo();
    let refusedAccepted = false;
    try { installSkill(repo, "evil-demo", { accepted: true }); } // accepted but no typed
    catch { refusedAccepted = true; }
    check("refused with accepted-but-no-typed", refusedAccepted);

    let refusedWrongTyped = false;
    try { installSkill(repo, "evil-demo", { accepted: true, typed: "wrong" }); }
    catch { refusedWrongTyped = true; }
    check("refused with wrong typed value", refusedWrongTyped);

    const out = installSkill(repo, "evil-demo", { accepted: true, typed: "evil-demo" });
    check("installs with correct typed confirm", out.installed === true);
  } finally {
    writeFileSync(COMMUNITY_JSON, backup);
    rmSync(evilDest, { recursive: true, force: true });
  }
}

console.log("================================================");
if (failed === 0) { console.log(`${GREEN}skill-install tests PASSED${NC}`); process.exit(0); }
console.log(`${RED}skill-install tests FAILED — ${failed} assertion(s)${NC}`); process.exit(1);
