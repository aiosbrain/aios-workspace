import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { MANAGED_PATHS, PERSONAL_PATHS, SCAFFOLD_UNMANAGED } from "../scripts/toolkit-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scaffold = readFileSync(path.join(here, "../scripts/scaffold-project.sh"), "utf8");

/**
 * Every toolkit path `scaffold-project.sh` stamps into a fresh workspace must be
 * classified into EXACTLY ONE of three buckets: MANAGED (synced by `aios update`),
 * PERSONAL (never touched), or SCAFFOLD_UNMANAGED (written once, deliberately not
 * synced). This test fails when someone adds a new `"$OUTPUT/<path>"` destination to
 * the scaffold without classifying it — the "kept in lockstep by hand" footgun that
 * let hydration/config paths drift silently. Variable destinations (`$OUTPUT/.claude/$d`)
 * are skipped: they can't be resolved statically, and their concrete children are
 * already covered by the buckets.
 */
function scaffoldDestinations() {
  const dests = new Set();
  // Match "$OUTPUT/<path>" and "$OUTPUT"/<path> forms; drop the ones with shell vars.
  const re = /"\$OUTPUT\/([^"$ ]+)"|"\$OUTPUT"\/([^"$ ]+)/g;
  let m;
  while ((m = re.exec(scaffold))) {
    const p = (m[1] || m[2]).replace(/\/$/, "");
    if (p && !p.includes("$")) dests.add(p);
  }
  return [...dests];
}

const CLASSIFIED = [...MANAGED_PATHS.map((e) => e.dest), ...PERSONAL_PATHS, ...SCAFFOLD_UNMANAGED];

/** D is covered if some classified path equals it, contains it, or is contained by it. */
function isCovered(d) {
  return CLASSIFIED.some((c) => c === d || d.startsWith(c + "/") || c.startsWith(d + "/"));
}

test("every scaffold-written toolkit path is classified (manifest ↔ scaffold parity)", () => {
  const dests = scaffoldDestinations();
  assert.ok(dests.length > 10, "sanity: extracted a plausible number of destinations");
  const unclassified = dests.filter((d) => !isCovered(d));
  assert.deepEqual(
    unclassified,
    [],
    `scaffold writes these paths but the manifest doesn't classify them ` +
      `(add to MANAGED_PATHS, PERSONAL_PATHS, or SCAFFOLD_UNMANAGED): ${unclassified.join(", ")}`
  );
});

test("the three manifest buckets don't overlap", () => {
  const managed = new Set(MANAGED_PATHS.map((e) => e.dest));
  for (const p of [...PERSONAL_PATHS, ...SCAFFOLD_UNMANAGED]) {
    assert.ok(!managed.has(p), `${p} is both managed and personal/unmanaged`);
  }
  const personal = new Set(PERSONAL_PATHS);
  for (const p of SCAFFOLD_UNMANAGED) {
    assert.ok(!personal.has(p), `${p} is both personal and scaffold-unmanaged`);
  }
});
