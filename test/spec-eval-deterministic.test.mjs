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
  assessScopeBound,
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

test("SR6 accepts every build-with spelling — hyphen, space, joined", () => {
  for (const heading of ["## Build-with", "## Build with", "## Buildwith"]) {
    const b = blockerIds(
      runDeterministicChecks(`# T\n\n${heading}\n\nSonnet 5 / high effort\n`, { repo: REPO })
    );
    assert.ok(!b.has("SR6"), `SR6 should pass for heading "${heading}"`);
  }
  const b = blockerIds(runDeterministicChecks("# T\n\nno tier here\n", { repo: REPO }));
  assert.ok(b.has("SR6"), "SR6 should still block when no build-with tier is stated");
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

test("SR17 — oversized multi-surface spec is a blocker (many tasks AND many surfaces)", () => {
  const b = blockerIds(runDeterministicChecks(read("oversized-multi-surface.md"), { repo: REPO }));
  assert.ok(b.has("SR17"), "SR17 blocks the mixed-concern, many-task spec");
});

test("SR17 — strong (bounded, single-purpose) spec is not a blocker", () => {
  const findings = runDeterministicChecks(read("strong-spec.md"), { repo: REPO }).filter(
    (f) => f.ruleId === "SR17"
  );
  assert.ok(
    !findings.some((f) => f.severity === "blocker"),
    "a bounded 2-surface spec never SR17-blocks"
  );
});

test("SR17 — a single tripped signal is advisory, not a blocker", () => {
  // 4 surfaces but only 3 tasks → surface signal trips alone → minor, never blocker.
  const spec = [
    "# Spec",
    "## Tasks",
    "- edit `scripts/a.mjs`",
    "- edit `gui/client/src/b.tsx`",
    "- edit `hooks/c.mjs`",
    "- also touch `validation/d.sh`",
  ].join("\n");
  const sr17 = runDeterministicChecks(spec, { repo: REPO }).filter((f) => f.ruleId === "SR17");
  assert.equal(sr17.length, 1);
  assert.equal(sr17[0].severity, "minor");
});

test("SR17 — thorough single-feature spec (code + test + docs + scaffold refs) never blocks", () => {
  // Regression (2026-07-22): a spec that dutifully names its test file, docs page, and scaffold
  // mirror is COMPLETE, not mixed-concern — those refs must not count as surfaces and hard-block.
  const spec = [
    "# Spec — one feature, thoroughly specified",
    "## Implementation Tasks",
    "- edit `scripts/feature.mjs`",
    "- extract helper in `scripts/feature-lib.mjs`",
    "- add unit tests in `test/feature.test.mjs`",
    "- add fixture `test/fixtures/feature/basic.md`",
    "- document in `docs/feature.md`",
    "- mirror into `scaffold/.claude/rules/feature.md`",
    "- wire the command in `scripts/aios.mjs`",
  ].join("\n");
  const sr17 = runDeterministicChecks(spec, { repo: REPO }).filter((f) => f.ruleId === "SR17");
  assert.ok(
    !sr17.some((f) => f.severity === "blocker"),
    "single code surface + test/docs/scaffold refs must not SR17-block"
  );
  assert.deepEqual(assessScopeBound(spec).surfaces, ["scripts"]);
});

test("SR17 — explicit increment statement downgrades the oversized blocker to advisory", () => {
  const spec = [
    read("oversized-multi-surface.md"),
    "",
    "One PR; follow-ups deferred to a sibling spec.",
  ].join("\n");
  const sr17 = runDeterministicChecks(spec, { repo: REPO }).filter((f) => f.ruleId === "SR17");
  assert.equal(sr17.length, 1);
  assert.equal(sr17[0].severity, "minor", "author-bounded increment must not hard-block");
});

test("assessScopeBound — counts tasks, distinct surfaces, and increment statement", () => {
  const spec = [
    "# Spec",
    "One PR; follow-ups deferred to a sibling spec.",
    "## Implementation",
    "- edit `scripts/a.mjs`",
    "- edit `scripts/b.mjs`",
    "- edit `gui/server/c.mjs`",
  ].join("\n");
  const s = assessScopeBound(spec);
  assert.equal(s.taskCount, 3);
  assert.deepEqual(s.surfaces, ["gui/server", "scripts"]);
  assert.equal(s.incrementStated, true);

  const bare = assessScopeBound("# Spec\nno tasks, no paths, no increment note");
  assert.equal(bare.taskCount, 0);
  assert.deepEqual(bare.surfaces, []);
  assert.equal(bare.incrementStated, false);
});

// ── AIO-573: path classification must not manufacture blockers ────────────────────────────────

test("AIO-573 — an explicit new-file marker beats the section heading", () => {
  // The heading contains "integrat", which used to classify EVERY path under it as existing
  // code — so naming a file the slice creates, in the one section specs name files in, was a
  // hard blocker. Four of the five GRAIN Wave 1 specs hit this.
  const heading = "Interface / integration points";
  for (const lineText of [
    "- new file: `scripts/ui/out.mjs` — the writer.",
    "- create `scripts/ui/out.mjs` — the writer.",
    "- `scripts/ui/out.mjs` — the writer facade; does not exist yet.",
  ]) {
    assert.equal(
      classifyPathContext({ section: heading, lineText }),
      "new",
      `an explicit marker must win over the heading: ${lineText}`
    );
  }
});

test("AIO-573 — an explicit marker after the referenced path applies to that path", () => {
  const section = "Interface / integration points";
  assert.equal(
    classifyPathContext({
      section,
      lineText: "- `scripts/ui/out.mjs` — the writer facade; does not exist yet.",
      path: "scripts/ui/out.mjs",
    }),
    "new"
  );
  assert.equal(
    classifyPathContext({
      section: "Tasks",
      lineText: "- `scripts/aios.mjs` — extends the existing dispatcher.",
      path: "scripts/aios.mjs",
    }),
    "existing"
  );
});

test("AIO-573 — the shipped template's own new-file line does not classify as existing", () => {
  // docs/agentic-ergonomics/aios-issue-template.md tells authors to write exactly this, in
  // exactly this section. Following our own template must not produce a blocker.
  assert.equal(
    classifyPathContext({
      section: "Interface / integration points",
      lineText: '- (TODO: or "new file: path/to/new-module.ts")',
    }),
    "new"
  );
});

test("AIO-573 — a sibling-repo section is advisory, not a blocker", () => {
  for (const section of [
    "Upstream work to create (sibling `aios-design` repo, separate PR)",
    "External dependencies",
    "Changes in the other repo",
  ]) {
    assert.notEqual(
      classifyPathContext({ section, lineText: "- `build/build.mjs` — the token pipeline." }),
      "existing",
      `cross-repo paths must not hard-block: ${section}`
    );
  }
});

test("AIO-573 — a genuine existing-code claim still classifies as existing", () => {
  // The fail-closed direction is preserved: claiming a path already exists, when it does not,
  // remains a blocker.
  assert.equal(
    classifyPathContext({
      section: "Interface / integration points",
      lineText: "- `scripts/aios.mjs` — extends the existing dispatcher.",
    }),
    "existing"
  );
  assert.equal(
    classifyPathContext({ section: "Reuse", lineText: "- `scripts/build.mjs`" }),
    "existing"
  );
});

test("AIO-573 — a new-file marker does not launder a phantom on the SAME line", () => {
  // Bugbot finding on the first cut of this fix: a whole-line rule let one bullet that mixes both
  // roles downgrade the integration target to an advisory. Markers are scoped per path.
  const lineText = "- new file: `scripts/ui/out.mjs` — integrates with `scripts/phantom.mjs`";
  const section = "Interface / integration points";
  assert.equal(
    classifyPathContext({ section, lineText, path: "scripts/ui/out.mjs" }),
    "new",
    "the created file is still new"
  );
  assert.equal(
    classifyPathContext({ section, lineText, path: "scripts/phantom.mjs" }),
    "existing",
    "the integration target it claims must still hard-block if it does not resolve"
  );
});

test("AIO-573 — the reverse order is scoped correctly too", () => {
  const lineText = "- extends `scripts/aios.mjs`; new file: `scripts/ui/roles.mjs`";
  assert.equal(classifyPathContext({ lineText, path: "scripts/aios.mjs" }), "existing");
  assert.equal(classifyPathContext({ lineText, path: "scripts/ui/roles.mjs" }), "new");
});
