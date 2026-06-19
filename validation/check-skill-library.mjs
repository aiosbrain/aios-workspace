#!/usr/bin/env node
// check-skill-library.mjs — OGR09: the cockpit skill-library is safe to ship.
//
// The OFFICIAL tier installs only vendored, Apache-2.0 skills; the COMMUNITY tier
// (Phase 3.5) admits non-official skills behind a static-scan + consent gate. The
// invariants that must hold at build time are:
//   1. every vendored OFFICIAL skill is Apache-2.0 (LICENSE.txt; no proprietary markers)
//   2. NONE of the four proprietary document skills (docx/pdf/pptx/xlsx) is vendored
//   3. no symlinks in the official tree; ids match ^[a-z0-9-]+$
//   4. the committed index.json matches the on-disk files (integrity lock not stale)
//   5. community skills are NEVER promoted to official (disjoint id sets) and each
//      community entry resolves to a scannable source dir (so the gate can run)
//   6. MARKETPLACE skills (anthropics/claude-plugins-official, fetch-on-install) have ids
//      disjoint from official+community, trust==="marketplace", a valid pinned
//      {repo,commit,path_in_repo} source, and declared per-file sha256 hashes (the
//      install-time byte-diff authenticity anchor). No network here — structural only.
// buildManifest() enforces 1+3 (it throws), so a clean build proves them.
//
// Usage: ./validation/check-skill-library.mjs [repo]  (repo arg unused; kept for
// validate-all.sh's run_check signature).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { buildManifest, LIBRARY_DIR } from "../scripts/lock-skill-library.mjs";
import { structuralCheck as marketplaceStructuralCheck } from "../scripts/lock-marketplace.mjs";
import { scanSkill } from "../scripts/skill-scan.mjs";

const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
let errors = 0;
const fail = (m) => {
  console.log(`  ${RED}✗${NC} ${m}`);
  errors++;
};
const ok = (m) => console.log(`  ${GREEN}✓${NC} ${m}`);

const PROPRIETARY = ["docx", "pdf", "pptx", "xlsx"];

console.log("OGR09: cockpit skill-library integrity + licensing");
console.log("================================================");

let built;
try {
  // Enforces Apache-2.0 license, id shape, and symlink rejection (throws otherwise).
  built = buildManifest();
  ok(`buildManifest: ${built.skills.length} skills, all Apache-2.0, no symlinks, ids valid`);
} catch (e) {
  fail(`buildManifest threw: ${e.message}`);
}

// 2. No proprietary document skill vendored (license forbids redistribution).
for (const id of PROPRIETARY) {
  if (existsSync(path.join(LIBRARY_DIR, id)))
    fail(`proprietary doc skill '${id}' must NOT be vendored (pointer-only)`);
}
// …and they must be declared pointer-only in referenced.json.
try {
  const ref = JSON.parse(readFileSync(path.join(LIBRARY_DIR, "referenced.json"), "utf8"));
  const refIds = new Set((ref.skills || []).map((s) => s.id));
  for (const id of PROPRIETARY)
    if (!refIds.has(id)) fail(`referenced.json is missing the pointer for '${id}'`);
  if (!errors) ok("proprietary doc skills are pointer-only (referenced.json), not vendored");
} catch (e) {
  fail(`referenced.json unreadable: ${e.message}`);
}

// 4. Committed lock must match the tree (no stale/untracked tampering).
if (built) {
  const indexPath = path.join(LIBRARY_DIR, "index.json");
  const current = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  if (current !== JSON.stringify(built, null, 2) + "\n") {
    fail("index.json is STALE — run: node scripts/lock-skill-library.mjs");
  } else {
    ok("index.json matches the vendored tree (integrity lock current)");
  }
}

// 5. Community tier (Phase 3.5): disjoint from official + every entry is scannable.
const communityIds = new Set();
{
  const communityPath = path.join(LIBRARY_DIR, "community.json");
  if (!existsSync(communityPath)) {
    ok("no community.json — community tier not registered (official-only)");
  } else {
    try {
      const com = JSON.parse(readFileSync(communityPath, "utf8"));
      const officialIds = new Set((built?.skills || []).map((s) => s.id));
      let allGood = true;
      for (const s of com.skills || []) {
        communityIds.add(s.id);
        if (!/^[a-z0-9-]+$/.test(s.id)) {
          fail(`community skill id '${s.id}' must match ^[a-z0-9-]+$`);
          allGood = false;
          continue;
        }
        if (officialIds.has(s.id)) {
          fail(
            `community skill '${s.id}' collides with an OFFICIAL id — community is never promoted to official`
          );
          allGood = false;
        }
        if (s.trust && s.trust !== "community") {
          fail(`community skill '${s.id}' has trust='${s.trust}' — must be 'community'`);
          allGood = false;
        }
        const rel = (s.source && s.source.dir) || `community/${s.id}`;
        const dir = path.resolve(LIBRARY_DIR, rel);
        if (!dir.startsWith(path.resolve(LIBRARY_DIR) + path.sep)) {
          fail(`community '${s.id}' source escapes the library tree`);
          allGood = false;
          continue;
        }
        try {
          scanSkill(dir);
        } catch (e) {
          // proves the source exists, has SKILL.md, and is scannable
          fail(`community '${s.id}' is not scannable: ${e.message}`);
          allGood = false;
        }
      }
      if (allGood)
        ok(
          `community tier: ${(com.skills || []).length} skill(s), disjoint from official, all scannable`
        );
    } catch (e) {
      fail(`community.json unreadable: ${e.message}`);
    }
  }
}

// 6. Marketplace tier: disjoint from official+community, trust==="marketplace", valid
//    pinned source + declared file hashes. Structural only (the install-time byte-diff
//    against the live upstream is exercised by the offline test, not at build time).
{
  const marketplacePath = path.join(LIBRARY_DIR, "marketplace.json");
  if (!existsSync(marketplacePath)) {
    ok("no marketplace.json — marketplace tier not registered");
  } else {
    try {
      const mkt = JSON.parse(readFileSync(marketplacePath, "utf8"));
      const officialIds = new Set((built?.skills || []).map((s) => s.id));
      const problems = marketplaceStructuralCheck(mkt);
      for (const p of problems) fail(`marketplace ${p}`);
      let disjoint = true;
      for (const s of mkt.skills || []) {
        if (officialIds.has(s.id)) {
          fail(`marketplace skill '${s.id}' collides with an OFFICIAL id`);
          disjoint = false;
        }
        if (communityIds.has(s.id)) {
          fail(`marketplace skill '${s.id}' collides with a COMMUNITY id`);
          disjoint = false;
        }
      }
      if (!problems.length && disjoint)
        ok(
          `marketplace tier: ${(mkt.skills || []).length} skill(s) @ ${(mkt.upstream_commit || "").slice(0, 7)}, disjoint, valid source + declared hashes`
        );
    } catch (e) {
      fail(`marketplace.json unreadable: ${e.message}`);
    }
  }
}

console.log("================================================");
if (errors === 0) {
  console.log(`${GREEN}OGR09 PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}OGR09 FAILED — ${errors} issue(s)${NC}`);
process.exit(1);
