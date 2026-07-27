// test/linear-template.test.mjs — aios-issue-template + patch-desc helpers

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDescriptionPatch,
  resolveLinearTemplate,
} from "../scaffold/.claude/skills/aios-linear/linear-template.mjs";

test("resolveLinearTemplate loads aios issue scaffold", () => {
  const body = resolveLinearTemplate("aios");
  assert.ok(body);
  assert.match(body, /## What \/ why/);
  assert.match(body, /## Outcomes/);
});

test("resolveLinearTemplate accepts legacy pick-up-able alias", () => {
  assert.equal(resolveLinearTemplate("pick-up-able"), resolveLinearTemplate("aios"));
});

test("applyDescriptionPatch replaces SEARCH blocks", () => {
  const original = "alpha\nbeta\ngamma";
  const patch = `<<<<<<< SEARCH
beta
=======
beta-replaced
>>>>>>> REPLACE`;
  assert.equal(applyDescriptionPatch(original, patch), "alpha\nbeta-replaced\ngamma");
});

test("applyDescriptionPatch errors when SEARCH missing", () => {
  assert.throws(
    () => applyDescriptionPatch("hello", "<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE"),
    /not found/
  );
});
