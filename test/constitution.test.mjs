#!/usr/bin/env node
// test/constitution.test.mjs — unit tests for the engineering-constitution digest loader
// (scripts/constitution.mjs) and its injection into the ship/build prompt builders.
// Zero-dep, no network. Run: node test/constitution.test.mjs

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
import { buildPlanPrompt, buildGptReviewPrompt } from "../scripts/ship.mjs";
import { buildImplementPrompt } from "../scripts/build.mjs";

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

console.log("prompt injection");
{
  const issue = { identifier: "AIO-1", title: "t", description: "d" };
  const withC = buildPlanPrompt(issue, "pack", null, DIGEST);
  const withoutC = buildPlanPrompt(issue, "pack", null);
  check("plan prompt carries digest", withC.includes(DIGEST));
  check("plan prompt unchanged without digest", !withoutC.includes("Engineering constitution"));

  const rev = buildGptReviewPrompt("plan", "diff", 7, DIGEST);
  check("review prompt carries digest", rev.includes(DIGEST));
  check("review prompt flags violations as findings", rev.includes("violates the constitution"));
  check(
    "review prompt unchanged without digest",
    !buildGptReviewPrompt("plan", "diff", 7).includes("Engineering constitution")
  );

  const impl = buildImplementPrompt("PLAN", { branch: "b", constitution: DIGEST });
  check("implement prompt carries digest", impl.includes(DIGEST));
  check(
    "digest sits before the wrap-up instruction",
    impl.indexOf(DIGEST) < impl.indexOf("When done, briefly summarize")
  );
  const implResume = buildImplementPrompt("PLAN", {
    branch: "b",
    constitution: DIGEST,
    resumeLog: "abc earlier work",
  });
  check(
    "resume splice unaffected: resume block stays before Rules",
    implResume.indexOf("earlier work") < implResume.indexOf("## Rules")
  );
  check(
    "implement prompt unchanged without digest",
    !buildImplementPrompt("PLAN", { branch: "b" }).includes("Engineering constitution")
  );
}

if (failed) {
  console.error(`\n${RED}${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}all constitution checks passed${NC}`);
