#!/usr/bin/env node
// test/linear-filerefs.test.mjs — [R-Blocker] extractRepoFileRefs safety.
// Untrusted Linear text can never smuggle .env*/.aios/absolute/../ or an untracked path into
// the allowed set; every rejection is recorded in `skipped` with a reason; skipped paths are
// never stat'd/read; maxFiles/maxBytes caps enforced. Run: node test/linear-filerefs.test.mjs

import { extractRepoFileRefs } from "../scripts/linear-client.mjs";

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

const tracked = new Set(["docs/brain-api.md", "scripts/ship.mjs", "README.md"]);

console.log("dangerous references never allowed; recorded as skipped");
{
  const text = [
    "See `docs/brain-api.md` and `scripts/ship.mjs`.",
    "Do not read `.env` `.env.local` `.aios/loop/x.md` `../escape.txt` `/abs/path.txt` `~/x.txt`.",
    "Also `node_modules/pkg/index.js` and `.git/config` and a `secret.key` and a `cert.pem`.",
    "An untracked-but-existing file `untracked.txt` should be excluded too.",
  ].join("\n");

  // statFile records which paths were stat'd — must NEVER include a skipped path.
  const statted = [];
  const statFile = (rel) => {
    statted.push(rel);
    return 100;
  };
  const { allowed, skipped } = extractRepoFileRefs(text, { trackedFiles: tracked, statFile });

  const notAllowed = (p) => !allowed.includes(p);
  check("docs/brain-api.md allowed (tracked)", allowed.includes("docs/brain-api.md"));
  check("scripts/ship.mjs allowed (tracked)", allowed.includes("scripts/ship.mjs"));
  check(".env never allowed", notAllowed(".env"));
  check(".env.local never allowed", notAllowed(".env.local"));
  check(".aios path never allowed", notAllowed(".aios/loop/x.md"));
  check("../escape never allowed", notAllowed("../escape.txt") && notAllowed("escape.txt"));
  check("absolute never allowed", notAllowed("/abs/path.txt"));
  check("node_modules never allowed", notAllowed("node_modules/pkg/index.js"));
  check(".git never allowed", notAllowed(".git/config"));
  check("*.key never allowed", notAllowed("secret.key"));
  check("*.pem never allowed", notAllowed("cert.pem"));
  check("untracked file excluded", notAllowed("untracked.txt"));

  const reasonFor = (raw) => skipped.find((s) => s.raw.includes(raw))?.reason;
  check(".env skipped reason denied", reasonFor(".env") === "denied");
  check(".aios skipped reason denied", reasonFor(".aios") === "denied");
  check("../ skipped reason parent-traversal", reasonFor("..") === "parent-traversal");
  check("absolute skipped reason absolute-path", reasonFor("/abs/path.txt") === "absolute-path");
  check("untracked skipped reason not-tracked", reasonFor("untracked.txt") === "not-tracked");

  // The crucial safety property: no skipped path was ever stat'd (contents never read).
  const skippedRaws = [".env", ".aios/loop/x.md", "/abs/path.txt", "untracked.txt", "cert.pem"];
  check(
    "skipped paths are never stat'd",
    skippedRaws.every((p) => !statted.includes(p))
  );
  check(
    "only allowed paths were stat'd",
    statted.every((p) => allowed.includes(p))
  );
}

console.log("maxFiles cap → overflow becomes cap-exceeded");
{
  const many = new Set(["a.md", "b.md", "c.md", "d.md"]);
  const text = "`a.md` `b.md` `c.md` `d.md`";
  const { allowed, skipped } = extractRepoFileRefs(text, { trackedFiles: many, maxFiles: 2 });
  check("only 2 allowed", allowed.length === 2);
  check(
    "overflow recorded cap-exceeded",
    skipped.filter((s) => s.reason === "cap-exceeded").length === 2
  );
}

console.log("maxBytes cap → overflow becomes cap-exceeded");
{
  const many = new Set(["a.md", "b.md", "c.md"]);
  const text = "`a.md` `b.md` `c.md`";
  const statFile = () => 200 * 1024; // each 200KB
  const { allowed, skipped } = extractRepoFileRefs(text, {
    trackedFiles: many,
    maxBytes: 256 * 1024,
    statFile,
  });
  check("only first fits under maxBytes", allowed.length === 1);
  check(
    "byte overflow recorded cap-exceeded",
    skipped.some((s) => s.reason === "cap-exceeded")
  );
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
