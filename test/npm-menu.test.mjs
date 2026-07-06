// scripts/npm-menu.mjs's categorization is hand-maintained — this is the cheap
// regression guard: fail loudly if a script gets added to package.json and someone
// forgets to categorize it here, instead of it silently falling through as
// undiscoverable noise (the original "THERE ARE A LOT OF NPM RUN COMMANDS!" problem).

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, loadScriptNames, uncategorized } from "../scripts/npm-menu.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every script in package.json.scripts is categorized exactly once", () => {
  const names = loadScriptNames(ROOT);
  assert.ok(names.length > 0, "sanity: package.json should have scripts");
  assert.deepEqual(uncategorized(names), []);

  const allCategorized = Object.values(CATEGORIES).flatMap((c) => c.scripts);
  const seen = new Set();
  for (const s of allCategorized) {
    assert.equal(seen.has(s), false, `"${s}" is listed in more than one category`);
    seen.add(s);
  }
});

test("every categorized script actually exists in package.json (no stale entries)", () => {
  const names = new Set(loadScriptNames(ROOT));
  for (const [category, { scripts }] of Object.entries(CATEGORIES)) {
    for (const s of scripts) {
      assert.ok(names.has(s), `"${s}" in category "${category}" isn't a real npm script`);
    }
  }
});
