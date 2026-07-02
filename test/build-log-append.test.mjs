#!/usr/bin/env node
// test/build-log-append.test.mjs — makeLogger({ append: true }) preserves prior
// sections across two runs (the G7 behavior: standalone `aios build --log X` twice
// must not clobber the first run). Zero-dep. Run: node test/build-log-append.test.mjs

import { makeLogger } from "../scripts/relay-core.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

console.log("append: true preserves prior sections across runs");
{
  const dir = mkdtempSync(path.join(tmpdir(), "build-log-"));
  const file = path.join(dir, "build.log.md");

  // Run 1: writes header + one section.
  const log1 = makeLogger(file, "# aios build\n\nRun 1 header\n", { append: true });
  log1("Build round 1 — builder", "first run round 1 body");

  // Run 2: same file, append mode — header exists, so it's NOT rewritten; new sections add.
  const log2 = makeLogger(file, "# aios build\n\nRun 2 header\n", { append: true });
  log2("Build round 1 — builder", "second run round 1 body");

  const txt = readFileSync(file, "utf8");
  check("first run's section survives", txt.includes("first run round 1 body"));
  check("first run header survives", txt.includes("Run 1 header"));
  check("second run's section is appended", txt.includes("second run round 1 body"));
  check("second run adds a fresh header (not a clobber)", txt.includes("Run 2 header"));
  check("both round-1 sections present", txt.split("## Build round 1 — builder").length === 3);

  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
