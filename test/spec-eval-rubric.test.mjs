// test/spec-eval-rubric.test.mjs — rubric parsing (frontmatter + SR table), loud failure on a
// malformed rubric, and the rubric↔code drift guard: every deterministic must/conditional row in
// the rubric is backed by an implemented deterministic check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubric, resolveRubricPath, DETERMINISTIC_CHECK_IDS } from "../scripts/spec-eval.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RUBRIC = path.join(DIR, "..", ".claude", "rubrics", "spec-readiness.md");
const TOOLKIT_ROOT = path.join(DIR, "..");

test("loadRubric parses frontmatter + all SR rows", () => {
  const r = loadRubric(RUBRIC);
  assert.equal(r.frontmatter.kind, "rubric");
  assert.equal(r.frontmatter.budget, 2);
  assert.equal(r.frontmatter.pass, "no-must-fails");
  const ids = r.rows.map((row) => row.id);
  assert.equal(ids.length, 16);
  for (let i = 1; i <= 16; i++) assert.ok(ids.includes(`SR${i}`), `SR${i}`);
});

test("resolveRubricPath — explicit > repo-local > toolkit fallback", () => {
  // 1. explicit override is honored verbatim
  assert.equal(resolveRubricPath("/anywhere", "/tmp/custom.md"), "/tmp/custom.md");

  // 2. a repo that vendors its own rubric uses it (the toolkit checkout itself is one)
  assert.equal(resolveRubricPath(TOOLKIT_ROOT), RUBRIC);

  // 3. a repo WITHOUT a rubric (the Brain, any bare repo) falls back to the toolkit rubric —
  //    instead of the old hard exit-4 "rubric not found". The fallback must be loadable.
  const bare = mkdtempSync(path.join(tmpdir(), "no-rubric-repo-"));
  try {
    const resolved = resolveRubricPath(bare);
    assert.notEqual(resolved, path.join(bare, ".claude", "rubrics", "spec-readiness.md"));
    assert.match(resolved, /\.claude[/\\]rubrics[/\\]spec-readiness\.md$/);
    assert.equal(loadRubric(resolved).frontmatter.kind, "rubric");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("SR15 keeps its sharpened, recoverability-aware wording (locks the rubric↔prompt pair)", () => {
  // SR15 was miscalibrated: it read "the builder must design X" as an unrecoverable decision and
  // failed doc/contract-authoring specs by construction. The sharpened criterion must keep treating
  // bounded, human-reviewed design latitude as recoverable — assert it so it can't silently regress
  // (the in-prompt checklist copy in scripts/spec-eval.mjs must be updated in lockstep with this).
  const sr15 = loadRubric(RUBRIC).rows.find((row) => row.id === "SR15");
  assert.ok(sr15, "SR15 row present");
  assert.match(sr15.criterion, /bounded/i);
  assert.match(sr15.criterion, /review/i);
});

test("malformed rubric fails loudly (die)", () => {
  const d = mkdtempSync(path.join(tmpdir(), "sr-rubric-"));
  assert.throws(() => loadRubric(path.join(d, "missing.md")), /not found/);

  const noFm = path.join(d, "nofm.md");
  writeFileSync(noFm, "# just a heading, no frontmatter\n| SR1 | x | deterministic | yes |\n");
  assert.throws(() => loadRubric(noFm), /frontmatter/);

  const noRows = path.join(d, "norows.md");
  writeFileSync(noRows, "---\nkind: rubric\nbudget: 2\n---\n\n# no table here\n");
  assert.throws(() => loadRubric(noRows), /no SR criteria rows/);

  const wrongKind = path.join(d, "wrongkind.md");
  writeFileSync(wrongKind, "---\nkind: rule\n---\n\n| SR1 | x | deterministic | yes |\n");
  assert.throws(() => loadRubric(wrongKind), /kind/);
  rmSync(d, { recursive: true, force: true });
});

test("drift: every deterministic must/conditional rubric row has an implemented check", () => {
  const r = loadRubric(RUBRIC);
  const detMustRows = r.rows.filter(
    (row) => /det/i.test(row.method) && /^(yes|conditional)/i.test(row.must)
  );
  // Sanity: the rubric actually declares deterministic must rows (not a vacuous pass).
  assert.ok(detMustRows.length >= 8, `expected ≥8 det-must rows, got ${detMustRows.length}`);
  for (const row of detMustRows) {
    assert.ok(
      DETERMINISTIC_CHECK_IDS.has(row.id),
      `rubric row ${row.id} is a deterministic must but has no implemented check`
    );
  }
});
