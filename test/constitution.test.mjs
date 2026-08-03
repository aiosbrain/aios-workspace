#!/usr/bin/env node
// test/constitution.test.mjs — unit tests for the engineering-constitution digest loader
// (scripts/constitution.mjs). Zero-dep, no network. Run: node test/constitution.test.mjs
//
// SCOPE (AIO-662): this file covers the loader only — extraction, file resolution, and the
// prompt LINES it produces. Whether ship/build actually splice those lines into their prompts
// is devtools behaviour and is asserted in aios-devtools (test/constitution-injection.test.mjs).
// Keeping the injection assertions here would mean core importing scripts/ship.mjs and
// scripts/build.mjs purely to test them — exactly the coupling the repo split exists to remove.
// The seam between the two halves is `constitutionPromptLines`, which is verified below.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DIGEST_START,
  DIGEST_END,
  CONSTITUTION_RELPATH,
  extractDigest,
  loadConstitutionDigest,
  constitutionPromptLines,
} from "../scripts/constitution.mjs";

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

const DIGEST = "- Domains are siblings, not friends.\n- Tier safety is non-negotiable.";
const DOC = `# Constitution\n\nprose\n\n${DIGEST_START}\n${DIGEST}\n${DIGEST_END}\n\nmore prose\n`;

console.log("extractDigest");
{
  check("extracts body between markers", extractDigest(DOC) === DIGEST);
  check("null on missing markers", extractDigest("# doc without markers") === null);
  check("null on empty input", extractDigest("") === null && extractDigest(null) === null);
  check("null on reversed markers", extractDigest(`${DIGEST_END}\nx\n${DIGEST_START}`) === null);
  check("null on empty digest body", extractDigest(`${DIGEST_START}\n   \n${DIGEST_END}`) === null);
}

console.log("loadConstitutionDigest");
{
  const repo = mkdtempSync(path.join(tmpdir(), "aios-constitution-"));
  try {
    check("null when file missing", loadConstitutionDigest(repo) === null);
    mkdirSync(path.join(repo, "docs"), { recursive: true });
    writeFileSync(path.join(repo, CONSTITUTION_RELPATH), DOC);
    check(
      "loads digest from docs/ENGINEERING-CONSTITUTION.md",
      loadConstitutionDigest(repo) === DIGEST
    );
    writeFileSync(path.join(repo, CONSTITUTION_RELPATH), "# no markers");
    check("null when markers absent", loadConstitutionDigest(repo) === null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  check(
    "injectable readFile",
    loadConstitutionDigest("/nowhere", { readFile: () => DOC }) === DIGEST
  );
}

console.log("constitutionPromptLines");
{
  check("empty array without digest", constitutionPromptLines(null).length === 0);
  const lines = constitutionPromptLines(DIGEST);
  check(
    "section heading present",
    lines.some((l) => l.startsWith("## Engineering constitution"))
  );
  check("digest is last line", lines.at(-1) === DIGEST);
}

// The consumer contract, asserted without importing a consumer. Devtools' prompt builders splice
// exactly this array; pinning its shape here is what lets the injection tests live in the other
// repo without the two halves silently drifting apart.
console.log("prompt-lines contract (the seam devtools consumes)");
{
  const lines = constitutionPromptLines(DIGEST);
  check(
    "returns an array of strings",
    Array.isArray(lines) && lines.every((l) => typeof l === "string")
  );
  check("no digest → nothing to splice", constitutionPromptLines(null).length === 0);
  check("undefined behaves as absent", constitutionPromptLines(undefined).length === 0);
  check(
    "heading is stable — devtools greps 'Engineering constitution' to assert absence",
    lines.filter((l) => l.startsWith("## Engineering constitution")).length === 1
  );
  check("digest body is carried verbatim", lines.at(-1) === DIGEST);
}

if (failed) {
  console.error(`\n${RED}${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}all constitution checks passed${NC}`);
