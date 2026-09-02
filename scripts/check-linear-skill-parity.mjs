#!/usr/bin/env node
/**
 * check-linear-skill-parity.mjs — AIO-927: the two canonical aios-linear skill
 * copies must stay byte-identical.
 *
 *   scaffold/.claude/skills/aios-linear/  — the operative source of truth
 *                                           (toolkit-manifest src; vendored into every
 *                                           scaffolded workspace via `aios update`;
 *                                           routing documentation only since AIO-1072 —
 *                                           the implementation is `aios linear`)
 *   .claude/skills/aios-linear/           — the toolkit's own working copy
 *
 * AIO-810 consolidated the diverged copies into one; before this gate, parity was
 * a manual checklist step, so the same silent drift could recur — a scaffolded
 * workspace shipping a stale CLI while the toolkit's copy moved on.
 *
 * This is a THIN gate, not a comparator. The comparison is OGR17
 * (validation/check-skill-sync.mjs), which already byte-compares every skill
 * present in both trees — recursively, with the junk-ignore list (.DS_Store,
 * __pycache__, *.pyc, node_modules) learned from a real false-positive. This
 * wrapper adds the one case OGR17 is deliberately blind to: OGR17 checks the
 * INTERSECTION of the trees, so deleting a whole skill directory from one side
 * silently shrinks the intersection instead of failing. Here, both aios-linear
 * dirs must exist, then OGR17 decides parity.
 *
 * Deliberate divergence, if ever wanted, requires editing this check and OGR17 —
 * that is the point. Repo root comes from this file's own location (argv[2]
 * overrides, for tests), never from process.cwd(). Dependency-free, so it runs
 * in CI before `npm ci` like the rest of the `constitution` job.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(process.argv[2] ?? path.join(SCRIPT_DIR, ".."));
const OGR17 = path.join(SCRIPT_DIR, "..", "validation", "check-skill-sync.mjs");

// scaffold/ first: it is the side to trust when resolving a real divergence.
const COPIES = [
  path.join("scaffold", ".claude", "skills", "aios-linear"),
  path.join(".claude", "skills", "aios-linear"),
];

const missing = COPIES.filter((rel) => !existsSync(path.join(repo, rel)));
if (missing.length > 0) {
  console.error("✗ aios-linear skill copies diverged (AIO-927):\n");
  for (const rel of missing) console.error(`  ${rel}/ is missing entirely`);
  console.error(
    "\n  edit both copies; they must stay byte-identical — see RESOLVER.md.\n" +
      "  scaffold/.claude/skills/aios-linear/ is the operative source of truth\n" +
      "  (toolkit-manifest src; routing docs for `aios linear`) — when resolving a real\n" +
      "  divergence, trust the scaffold/ side.\n" +
      "  Deliberate divergence requires editing scripts/check-linear-skill-parity.mjs\n" +
      "  and validation/check-skill-sync.mjs (OGR17) themselves."
  );
  process.exit(1);
}

// Both dirs exist — OGR17 owns the file-for-file verdict (and prints its own report).
const result = spawnSync(process.execPath, [OGR17, repo], { stdio: "inherit" });
if (result.status !== 0) {
  console.error(
    "\n✗ aios-linear skill parity gate (AIO-927): OGR17 reported drift above.\n" +
      "  edit both copies; they must stay byte-identical — see RESOLVER.md.\n" +
      "  When resolving a real divergence, trust scaffold/.claude/skills/aios-linear/."
  );
  process.exit(result.status ?? 1);
}
console.log("✓ aios-linear skill copies present in both trees and byte-identical (via OGR17)");
