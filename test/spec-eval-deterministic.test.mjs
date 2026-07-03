// test/spec-eval-deterministic.test.mjs — the zero-LLM readiness layer: each weak fixture maps to
// its expected SR findings (resolved against the REAL repo tree), plus units for the helpers and
// the section-aware SR3 (new-file-under-Implementation is advisory, reuse-context is a blocker).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runDeterministicChecks,
  looksObservable,
  findReferencedPaths,
  touchesSyncSurface,
  classifyPathContext,
} from "../scripts/spec-eval.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const FIXTURES = path.join(DIR, "fixtures", "spec-eval");
const read = (f) => readFileSync(path.join(FIXTURES, f), "utf8");
const blockerIds = (findings) =>
  new Set(findings.filter((f) => f.severity === "blocker").map((f) => f.ruleId));

test("weak-missing-acceptance → SR2 blocker only", () => {
  const b = blockerIds(runDeterministicChecks(read("weak-missing-acceptance.md"), { repo: REPO }));
  assert.ok(b.has("SR2"));
  assert.deepEqual([...b].sort(), ["SR2"]);
});

test("weak-vague-criteria → SR2 (present but not observable)", () => {
  const b = blockerIds(runDeterministicChecks(read("weak-vague-criteria.md"), { repo: REPO }));
  assert.deepEqual([...b].sort(), ["SR2"]);
});

test("weak-phantom-paths → SR3 + SR16 (phantom path resolved against the real tree)", () => {
  const b = blockerIds(runDeterministicChecks(read("weak-phantom-paths.md"), { repo: REPO }));
  assert.ok(b.has("SR3"));
  assert.ok(b.has("SR16"));
});

test("weak-no-deps → SR4 blocker only", () => {
  const b = blockerIds(runDeterministicChecks(read("weak-no-deps.md"), { repo: REPO }));
  assert.deepEqual([...b].sort(), ["SR4"]);
});

test("weak-tier-unsafe → SR7 blocker (sync surface, no tier posture)", () => {
  const b = blockerIds(runDeterministicChecks(read("weak-tier-unsafe.md"), { repo: REPO }));
  assert.deepEqual([...b].sort(), ["SR7"]);
});

test("strong-spec → no deterministic blockers", () => {
  const b = blockerIds(runDeterministicChecks(read("strong-spec.md"), { repo: REPO }));
  assert.equal(b.size, 0);
});

test("acceptance-demo-weak → the full deterministic blocker set", () => {
  const b = blockerIds(runDeterministicChecks(read("acceptance-demo-weak.md"), { repo: REPO }));
  for (const id of ["SR2", "SR3", "SR4", "SR5", "SR6", "SR7", "SR16"]) assert.ok(b.has(id), id);
});

test("looksObservable — concrete signals pass, vibes fail", () => {
  assert.ok(looksObservable("`aios spec eval` returns exit code 1"));
  assert.ok(looksObservable("A new test in `foo.test.mjs` asserts the shape"));
  assert.ok(!looksObservable("It works well and is fast"));
  assert.ok(!looksObservable("Feels clean and reads nicely"));
  assert.ok(!looksObservable(""));
});

test("findReferencedPaths — finds paths, excludes globs and <placeholder>", () => {
  const spec = [
    "Uses `scripts/relay.mjs` and `src/operator-loop/signal.ts`.",
    "Not a path: `foo bar`, a glob `src/**/*.ts`, a placeholder `<name>.ts`, a url `https://x/y.md`.",
  ].join("\n");
  const paths = findReferencedPaths(spec).map((r) => r.path);
  assert.ok(paths.includes("scripts/relay.mjs"));
  assert.ok(paths.includes("src/operator-loop/signal.ts"));
  assert.ok(!paths.some((p) => p.includes("*")));
  assert.ok(!paths.some((p) => p.includes("<")));
  assert.ok(!paths.some((p) => p.includes("://")));
});

test("touchesSyncSurface — brain/push triggers, local does not", () => {
  assert.ok(touchesSyncSurface("then push the digest to the brain"));
  assert.ok(touchesSyncSurface("this syncs to the team brain"));
  assert.ok(!touchesSyncSurface("a purely local CLI that writes to a file"));
});

test("section-aware SR3 — new-file-under-Implementation is advisory, reuse-context is a blocker", () => {
  const newFile = [
    "## Implementation",
    "- Create a new file `src/nowhere/brandnew.ts` for the fold.",
  ].join("\n");
  const newFindings = runDeterministicChecks(newFile, { repo: REPO }).filter(
    (f) => f.ruleId === "SR3"
  );
  assert.equal(newFindings.length, 1);
  assert.equal(newFindings[0].severity, "minor"); // advisory, not a must-fail

  const reuse = ["## Reuse", "This reuses `src/nowhere/ghost.ts` for the fold."].join("\n");
  const reuseFindings = runDeterministicChecks(reuse, { repo: REPO }).filter(
    (f) => f.ruleId === "SR3"
  );
  assert.equal(reuseFindings[0].severity, "blocker");
});

test("classifyPathContext — existing vs new vs ambiguous", () => {
  assert.equal(classifyPathContext({ section: "Reuse", lineText: "reuses `x.ts`" }), "existing");
  assert.equal(
    classifyPathContext({ section: "Implementation", lineText: "create a new file `x.ts`" }),
    "new"
  );
  assert.equal(classifyPathContext({ section: "Notes", lineText: "see `x.ts`" }), "ambiguous");
});
