#!/usr/bin/env node
// test/ship-recon-annotation.test.mjs — AIO-186 F2: recon truncation is SURFACED, never silent.
// (1) buildOmittedRefsNote lists the cap-exceeded referenced files (and only those). (2) In a
// real runShip pass, the recon prompt carries both the omitted-refs note and a per-file
// `[truncated: …]` marker when a file body exceeds RECON_FILE_CAP.
// Run: node test/ship-recon-annotation.test.mjs

import { runShip, buildOmittedRefsNote, RECON_FILE_CAP, SHIP_EXIT } from "../scripts/ship.mjs";
import { resolveLoopModels } from "../scripts/loop-models.mjs";

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

console.log("buildOmittedRefsNote — only cap-exceeded entries, empty when none");
{
  check("empty on no skips", buildOmittedRefsNote([]) === "");
  check("empty on undefined", buildOmittedRefsNote(undefined) === "");
  check(
    "empty when skips are all non-cap (security filters, not truncation)",
    buildOmittedRefsNote([
      { raw: "../x", reason: "parent-traversal" },
      { raw: ".env", reason: "denied" },
      { raw: "missing.mjs", reason: "not-tracked" },
    ]) === ""
  );
  const note = buildOmittedRefsNote([
    { raw: "scripts/a.mjs", reason: "cap-exceeded" },
    { raw: "missing.mjs", reason: "not-tracked" },
    { raw: "scripts/b.mjs", reason: "cap-exceeded" },
  ]);
  check("note has the Omitted references heading", /## Omitted references/.test(note));
  check(
    "note counts the 2 cap-exceeded refs",
    /2 referenced repo file\(s\) were dropped/.test(note)
  );
  check(
    "note lists the cap-exceeded files",
    /`scripts\/a\.mjs`/.test(note) && /`scripts\/b\.mjs`/.test(note)
  );
  check("note EXCLUDES non-cap skips", !/missing\.mjs/.test(note));
}

console.log("runShip recon prompt — carries the omitted-refs note + truncation marker");
{
  // 13 tracked files referenced → maxFiles=12 default drops the 13th as cap-exceeded.
  const files = Array.from({ length: 13 }, (_, i) => `scripts/f${i}.mjs`);
  const tracked = new Set(files);
  const bigBody = "x".repeat(RECON_FILE_CAP + 500); // exceeds the per-file cap → marked truncated

  let capturedRecon = null;
  const deps = {
    linear: {
      getIssue: async () => ({
        identifier: "AIO-1",
        title: "Recon annotation",
        description: files.map((f) => `\`${f}\``).join(" "),
        comments: [],
        children: [],
        blockedBy: [],
      }),
    },
    resolveModels: resolveLoopModels,
    callClaudeAgent: async (prompt) => {
      if (/recon context pack/.test(prompt)) {
        capturedRecon = prompt;
        throw new Error("stop after recon (prompt already captured)");
      }
      return "";
    },
    gitLsFiles: () => tracked,
    statFile: () => ({ size: 100 }),
    readFile: () => bigBody,
    writeAudit: () => {},
    isTty: true,
  };
  const { code } = await runShip({
    repo: "/tmp/recon-anno",
    issue: "AIO-1",
    opts: {
      auto: false,
      autoMerge: false,
      planRunner: "cli",
      reviewers: ["bugbot"],
      maxFixRounds: 1,
    },
    deps,
  });
  check("recon short-circuited (RECON_FAILED after capture)", code === SHIP_EXIT.RECON_FAILED);
  check("recon prompt captured", typeof capturedRecon === "string");
  check(
    "prompt carries the per-file truncation marker",
    new RegExp(`\\[truncated: first ${RECON_FILE_CAP} of ${bigBody.length} chars\\]`).test(
      capturedRecon
    )
  );
  check("prompt carries the omitted-refs note", /## Omitted references/.test(capturedRecon));
  check(
    "omitted-refs note names the 13th (cap-exceeded) file",
    /`scripts\/f12\.mjs`/.test(capturedRecon)
  );
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
