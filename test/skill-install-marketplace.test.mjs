#!/usr/bin/env node
// test/skill-install-marketplace.test.mjs — the MARKETPLACE trust tier in
// gui/server/skill-library.mjs (fetch-on-install + byte-diff authenticity).
//
// The marketplace tier fetches a skill from a pinned repo@commit and byte-diffs the
// fetched bytes against the catalog's declared per-file sha256. To stay offline + fast,
// this test stands up a LOCAL git repo as the "upstream" (file:// URL), locks a catalog
// against it via scripts/lock-marketplace.mjs's hashing helpers, then drives the real
// install/scan paths by temporarily swapping gui/server/skill-library/marketplace.json.
//
// Covers: catalog parse + structural check; fetch + byte-diff verify lands the skill in
// .claude/skills/ with ledger tier:"marketplace"; a TAMPERED upstream is REFUSED; consent
// rules (refused without accept; no typed-confirm even on a code/high skill — marketplace
// is first-party vetted). Zero network. Run: node test/skill-install-marketplace.test.mjs

import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { hashDir, structuralCheck } from "../scripts/lock-marketplace.mjs";
import {
  scanSkillById,
  installSkill,
  listLibrary,
  uninstallSkill,
} from "../gui/server/skill-library.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY_DIR = path.join(DIR, "..", "gui", "server", "skill-library");
const MARKETPLACE_JSON = path.join(LIBRARY_DIR, "marketplace.json");

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
function freshRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "mktrepo-"));
  mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
  return repo;
}
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

// ── stand up a local "upstream" git repo with one skill that bundles code ──────
// (code-bearing so the advisory scan returns at least `elevated` — proving marketplace
// does NOT demand a typed confirm even when the scanner flags code.)
const upstream = mkdtempSync(path.join(tmpdir(), "mkt-upstream-"));
const PATH_IN_REPO = "plugins/demo-plugin/skills/demo-mkt-skill";
const skillDir = path.join(upstream, PATH_IN_REPO);
mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
writeFileSync(
  path.join(skillDir, "SKILL.md"),
  `---\nname: demo-mkt-skill\ndescription: A demo marketplace skill that bundles a helper script.\n---\n\n# Demo Marketplace Skill\n\nRun the helper to count words.\n`
);
writeFileSync(path.join(skillDir, "scripts", "helper.sh"), `#!/usr/bin/env bash\nwc -w "$1"\n`);
git(upstream, "init", "-q");
git(upstream, "config", "user.email", "t@t");
git(upstream, "config", "user.name", "t");
git(upstream, "add", "-A");
git(upstream, "commit", "-qm", "init");
const COMMIT = git(upstream, "rev-parse", "HEAD").trim();

// Lock a catalog against the local upstream (declared sha256 = the real fetched bytes).
const files = hashDir(skillDir);
const goodCatalog = {
  upstream_repo: `file://${upstream}`,
  upstream_commit: COMMIT,
  skills: [
    {
      id: "demo-mkt-skill",
      name: "demo-mkt-skill",
      description: "A demo marketplace skill that bundles a helper script.",
      category: "Marketplace · Anthropic",
      trust: "marketplace",
      source: { repo: `file://${upstream}`, commit: COMMIT, path_in_repo: PATH_IN_REPO },
      files,
    },
  ],
};

const backup = existsSync(MARKETPLACE_JSON) ? readFileSync(MARKETPLACE_JSON, "utf8") : null;
function installCatalog(cat) {
  writeFileSync(MARKETPLACE_JSON, JSON.stringify(cat, null, 2) + "\n");
}

try {
  console.log("marketplace: catalog parses + passes structural check");
  {
    check("structural check clean", structuralCheck(goodCatalog).length === 0);
    const bad = JSON.parse(JSON.stringify(goodCatalog));
    bad.skills[0].trust = "official";
    check(
      "structural check flags wrong trust",
      structuralCheck(bad).some((p) => /trust must be/.test(p))
    );
    const badPath = JSON.parse(JSON.stringify(goodCatalog));
    badPath.skills[0].source.path_in_repo = "../escape";
    check(
      "structural check flags path escape",
      structuralCheck(badPath).some((p) => /escapes the repo/.test(p))
    );
  }

  console.log("marketplace: scan fetches + byte-diff verifies, advisory only");
  installCatalog(goodCatalog);
  {
    const scan = scanSkillById("demo-mkt-skill");
    check("tier is marketplace", scan.tier === "marketplace");
    check(
      "scan sees bundled code (elevated)",
      scan.bundlesCode === true && scan.riskClass === "elevated"
    );
    check("no typed confirm for marketplace", scan.requiresTypedConfirm === false);
    check(
      "listed in marketplace[]",
      listLibrary(freshRepo()).marketplace.some((s) => s.id === "demo-mkt-skill")
    );
  }

  console.log("marketplace: install fetch+verify lands skill, ledger tier:marketplace");
  {
    const repo = freshRepo();
    let refused = false,
      scanAttached = false;
    try {
      installSkill(repo, "demo-mkt-skill");
    } catch (e) {
      refused = true;
      scanAttached = !!e.scan;
    }
    check("refused without consent", refused);
    check("scan attached to refusal", scanAttached);
    check(
      "not on disk after refusal",
      !existsSync(path.join(repo, ".claude/skills/demo-mkt-skill"))
    );

    const out = installSkill(repo, "demo-mkt-skill", { accepted: true });
    check(
      "installs with accept (no typed confirm)",
      out.installed === true && out.tier === "marketplace"
    );
    check(
      "SKILL.md on disk",
      existsSync(path.join(repo, ".claude/skills/demo-mkt-skill/SKILL.md"))
    );
    check(
      "bundled helper on disk",
      existsSync(path.join(repo, ".claude/skills/demo-mkt-skill/scripts/helper.sh"))
    );

    const led = JSON.parse(readFileSync(path.join(repo, ".aios/skills-installed.json"), "utf8"));
    const rec = led.skills.find((s) => s.id === "demo-mkt-skill");
    check("ledger records tier:marketplace", rec && rec.tier === "marketplace");
    check("ledger records the pinned commit", rec && rec.upstream_commit === COMMIT);

    // Safe uninstall still works for a marketplace skill.
    const un = uninstallSkill(repo, "demo-mkt-skill");
    check(
      "uninstall removes it",
      un.installed === false && !existsSync(path.join(repo, ".claude/skills/demo-mkt-skill"))
    );
  }

  console.log("marketplace: a TAMPERED upstream is REFUSED (byte-diff authenticity)");
  {
    // Mutate the upstream working tree + commit a new sha, but keep the catalog's OLD
    // declared hashes/commit pinned to the original — install must refuse on mismatch.
    const tamperedCatalog = JSON.parse(JSON.stringify(goodCatalog));

    // (a) declared hash drift: flip one declared sha256 → fetched bytes won't match.
    const driftCatalog = JSON.parse(JSON.stringify(goodCatalog));
    driftCatalog.skills[0].files = driftCatalog.skills[0].files.map((f) =>
      f.path === "SKILL.md" ? { ...f, sha256: "0".repeat(64) } : f
    );
    installCatalog(driftCatalog);
    let refusedDrift = false,
      msgDrift = "";
    try {
      installSkill(freshRepo(), "demo-mkt-skill", { accepted: true });
    } catch (e) {
      refusedDrift = true;
      msgDrift = e.message;
    }
    check(
      "refused when declared hash != fetched bytes",
      refusedDrift && /authenticity check FAILED/i.test(msgDrift)
    );

    // (b) extra file upstream not in the catalog → "unexpected" mismatch.
    writeFileSync(path.join(skillDir, "EXTRA.md"), "surprise payload\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-qm", "tamper");
    const tamperCommit = git(upstream, "rev-parse", "HEAD").trim();
    tamperedCatalog.skills[0].source.commit = tamperCommit; // point at the tampered commit
    tamperedCatalog.skills[0].upstream_commit = tamperCommit;
    installCatalog(tamperedCatalog);
    let refusedExtra = false,
      msgExtra = "";
    try {
      installSkill(freshRepo(), "demo-mkt-skill", { accepted: true });
    } catch (e) {
      refusedExtra = true;
      msgExtra = e.message;
    }
    check(
      "refused when upstream gains an undeclared file",
      refusedExtra && /authenticity check FAILED/i.test(msgExtra)
    );
    check(
      "tampered skill never landed on disk",
      !existsSync(path.join(freshRepo(), ".claude/skills/demo-mkt-skill"))
    );
  }
} finally {
  if (backup !== null) writeFileSync(MARKETPLACE_JSON, backup);
  else rmSync(MARKETPLACE_JSON, { force: true });
  rmSync(upstream, { recursive: true, force: true });
}

console.log("================================================");
if (failed === 0) {
  console.log(`${GREEN}skill-install-marketplace tests PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}skill-install-marketplace tests FAILED — ${failed} assertion(s)${NC}`);
process.exit(1);
