#!/usr/bin/env node
// check-skill-library.mjs — OGR09: the cockpit skill-library is safe to ship.
//
// The Skills surface installs ONLY vendored, official, Apache-2.0 skills, so the
// invariants that must hold at build time are:
//   1. every vendored skill is Apache-2.0 (has a LICENSE.txt; no proprietary markers)
//   2. NONE of the four proprietary document skills (docx/pdf/pptx/xlsx) is vendored
//   3. no symlinks in the tree; ids match ^[a-z0-9-]+$
//   4. the committed index.json matches the on-disk files (integrity lock not stale)
// buildManifest() enforces 1+3 (it throws), so a clean build proves them.
//
// Usage: ./validation/check-skill-library.mjs [repo]  (repo arg unused; kept for
// validate-all.sh's run_check signature).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { buildManifest, LIBRARY_DIR } from "../scripts/lock-skill-library.mjs";

const RED = "\x1b[0;31m", GREEN = "\x1b[0;32m", NC = "\x1b[0m";
let errors = 0;
const fail = (m) => { console.log(`  ${RED}✗${NC} ${m}`); errors++; };
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
  if (existsSync(path.join(LIBRARY_DIR, id))) fail(`proprietary doc skill '${id}' must NOT be vendored (pointer-only)`);
}
// …and they must be declared pointer-only in referenced.json.
try {
  const ref = JSON.parse(readFileSync(path.join(LIBRARY_DIR, "referenced.json"), "utf8"));
  const refIds = new Set((ref.skills || []).map((s) => s.id));
  for (const id of PROPRIETARY) if (!refIds.has(id)) fail(`referenced.json is missing the pointer for '${id}'`);
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

console.log("================================================");
if (errors === 0) { console.log(`${GREEN}OGR09 PASSED${NC}`); process.exit(0); }
console.log(`${RED}OGR09 FAILED — ${errors} issue(s)${NC}`); process.exit(1);
