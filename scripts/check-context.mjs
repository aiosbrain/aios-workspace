#!/usr/bin/env node
/**
 * Context Engineering Health gate (CI wrapper around scripts/context-health.mjs).
 *
 * Prints every hard-check failure (blocking) and every soft-check miss (warning, non-
 * blocking), then exits 1 iff there's at least one hard failure — mirrors
 * check-docs-drift.mjs's console conventions (x/ok prefixes, exit 0/1).
 *
 *   node scripts/check-context.mjs [path]   (default: cwd)
 */
import path from "node:path";
import { computeContextHealth } from "./context-health.mjs";

const target = path.resolve(process.argv[2] || process.cwd());
const result = computeContextHealth(target);

console.log(`Context health (${result.mode} mode): ${result.summary}`);
console.log("");

for (const c of result.checks) {
  if (c.kind === "hard" && !c.ok) {
    console.error(`x ${c.id}: ${c.detail}`);
  } else if (c.kind === "soft" && !c.ok) {
    console.warn(`! ${c.id} (warning): ${c.detail}`);
  } else {
    console.log(`ok ${c.id}: ${c.detail}`);
  }
}

console.log("");
if (result.hardFailures > 0) {
  console.error(
    `Context health FAILED — ${result.hardFailures} hard failure(s), ${result.softMisses} soft miss(es).`
  );
  process.exit(1);
}
console.log(`Context health ok — ${result.summary}`);
process.exit(0);
