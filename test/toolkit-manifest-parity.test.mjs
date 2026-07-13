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

/**
 * Does a MANAGED dir entry actually cover `d` as a synced path? A dir entry's
 * `exclude`d children (e.g. `.claude/rules/access-control.md`) are scaffold-written
 * but NOT synced by `aios update` — they must fall through to SCAFFOLD_UNMANAGED
 * instead, so they're excluded from the managed match here.
 */
function managedCovers(entry, d) {
  if (entry.kind !== "dir") {
    // A file entry also "covers" a scaffold path that is one of ITS ancestor dirs
    // (e.g. scaffold destination "scripts" is covered because "scripts/aios.mjs" is
    // managed) — mirrors the original containment check.
    return d === entry.dest || entry.dest.startsWith(d + "/");
  }
  if (d !== entry.dest && !d.startsWith(entry.dest + "/") && !entry.dest.startsWith(d + "/"))
    return false;
  const tail = d.startsWith(entry.dest + "/") ? d.slice(entry.dest.length + 1) : undefined;
  if (tail && (entry.exclude || []).includes(tail)) return false;
  return true;
}

/** D is covered if some classified path equals it, contains it, or is contained by it. */
function isCovered(d) {
  if (MANAGED_PATHS.some((e) => managedCovers(e, d))) return true;
  return [...PERSONAL_PATHS, ...SCAFFOLD_UNMANAGED].some(
    (c) => c === d || d.startsWith(c + "/") || c.startsWith(d + "/")
  );
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
  for (const p of [...PERSONAL_PATHS, ...SCAFFOLD_UNMANAGED]) {
    assert.ok(
      !MANAGED_PATHS.some((e) => managedCovers(e, p)),
      `${p} is both managed and personal/unmanaged`
    );
  }
  const personal = new Set(PERSONAL_PATHS);
  for (const p of SCAFFOLD_UNMANAGED) {
    assert.ok(!personal.has(p), `${p} is both personal and scaffold-unmanaged`);
  }
});

test("a dir entry's excluded child is SCAFFOLD_UNMANAGED, not managed (AIO-351 dogfood)", () => {
  const rulesEntry = MANAGED_PATHS.find((e) => e.dest === ".claude/rules");
  assert.ok(rulesEntry?.exclude?.includes("access-control.md"), "exclude is configured");
  const excludedDest = ".claude/rules/access-control.md";
  assert.ok(
    !managedCovers(rulesEntry, excludedDest),
    "the excluded file must not be covered by the managed dir entry"
  );
  assert.ok(
    SCAFFOLD_UNMANAGED.includes(excludedDest),
    "the excluded file must be explicitly classified as scaffold-unmanaged"
  );
});
