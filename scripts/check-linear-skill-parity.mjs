#!/usr/bin/env node
/**
 * check-linear-skill-parity.mjs — AIO-927: the two canonical aios-linear skill
 * copies must stay byte-identical.
 *
 *   .claude/skills/aios-linear/           — the toolkit's own (canonical) copy
 *   scaffold/.claude/skills/aios-linear/  — vendored into every scaffolded
 *                                           workspace via `aios update`
 *
 * AIO-810 consolidated the diverged copies into one; before this gate, parity
 * was a manual checklist step, so the same silent drift could recur — a
 * scaffolded workspace shipping a stale CLI while the toolkit's copy moved on.
 *
 * The comparison is file-for-file by content over the FULL directory trees
 * (recursive, no hardcoded file list), so a file added to only one copy, or a
 * file missing from one copy, fails just like edited content does. Deliberate
 * divergence, if ever wanted, requires editing this check — that is the point.
 *
 * Bespoke check-* style (error text = remediation prompt, exit 1 on violation);
 * dependency-free (node:fs/node:path) so it runs in CI before `npm ci`, like
 * the rest of the `constitution` job. Reporting mirrors
 * scripts/check-domain-isolation.mjs.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const COPY_A = path.join(".claude", "skills", "aios-linear");
export const COPY_B = path.join("scaffold", ".claude", "skills", "aios-linear");

// walk(dir) → sorted relative paths of every regular file under dir (recursive).
function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * parityFailures(root) → string[] of human-readable violations (empty = parity).
 * Pure over the filesystem; exported so the unit test can exercise both
 * difference modes (content drift, presence/absence) without spawning.
 */
export function parityFailures(root) {
  const dirA = path.join(root, COPY_A);
  const dirB = path.join(root, COPY_B);
  const failures = [];
  for (const [dir, rel] of [
    [dirA, COPY_A],
    [dirB, COPY_B],
  ]) {
    if (!existsSync(dir)) failures.push(`${rel}/ is missing entirely`);
  }
  if (failures.length) return failures;

  const filesA = walk(dirA);
  const filesB = walk(dirB);
  const union = [...new Set([...filesA, ...filesB])].sort();
  for (const rel of union) {
    const inA = filesA.includes(rel);
    const inB = filesB.includes(rel);
    if (!inB) {
      failures.push(`${path.join(COPY_A, rel)} exists but ${path.join(COPY_B, rel)} is missing`);
    } else if (!inA) {
      failures.push(`${path.join(COPY_B, rel)} exists but ${path.join(COPY_A, rel)} is missing`);
    } else if (!readFileSync(path.join(dirA, rel)).equals(readFileSync(path.join(dirB, rel)))) {
      failures.push(`content differs: ${path.join(COPY_A, rel)} vs ${path.join(COPY_B, rel)}`);
    }
  }
  return failures;
}

function main() {
  const root = process.cwd();
  const failures = parityFailures(root);
  if (failures.length > 0) {
    console.error("✗ aios-linear skill copies diverged (AIO-927):\n");
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      "\n  edit both copies; they must stay byte-identical — see RESOLVER.md.\n" +
        "  Deliberate divergence requires editing scripts/check-linear-skill-parity.mjs itself."
    );
    process.exit(1);
  }
  const count = walk(path.join(root, COPY_A)).length;
  console.log(`✓ aios-linear skill copies byte-identical (${count} files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
