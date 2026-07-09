#!/usr/bin/env node
/**
 * File-size gate (AIO-320).
 *
 * Holds the line on oversized files (notably scripts/aios.mjs, 5.4k lines) so they can't grow while
 * AIO-315 decomposes them. Caps live in scripts/size-caps.json (a plain config the extraction PRs
 * edit — a number, not code); this script just enforces them. Line counting uses `wc -l` semantics
 * (newline count) so the cap matches what you'd see on the command line.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CONFIG = path.join(ROOT, "scripts", "size-caps.json");

function countLines(rel) {
  const content = readFileSync(path.join(ROOT, rel), "utf8");
  const nl = content.match(/\n/g);
  return nl ? nl.length : content.length > 0 ? 1 : 0;
}

const { caps } = JSON.parse(readFileSync(CONFIG, "utf8"));
const over = [];
for (const [rel, cap] of Object.entries(caps)) {
  const lines = countLines(rel);
  if (lines > cap) over.push({ rel, lines, cap });
}

if (over.length > 0) {
  console.error("✗ file-size gate exceeded:\n");
  for (const o of over) {
    console.error(`  ${o.rel}: ${o.lines} lines > cap ${o.cap} (over by ${o.lines - o.cap})`);
  }
  console.error(
    "\n  Extract to bring it under the cap, or (if intentional) raise the number in scripts/size-caps.json."
  );
  process.exit(1);
}

const summary = Object.entries(caps)
  .map(([rel, cap]) => `${rel} ${countLines(rel)}/${cap}`)
  .join(", ");
console.log(`✓ file-size gate clean (${summary})`);
