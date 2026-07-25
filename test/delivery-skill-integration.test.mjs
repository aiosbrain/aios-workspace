import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCodeReviewPrompt,
  buildImplementPrompt,
  parseBuildArgs,
  resolveBuilderSkillContext,
} from "../scripts/build.mjs";
import {
  buildPlanPrompt,
  buildPlanReviewPrompt,
  builderSkillCheckpoint,
  builderSkillCheckpointMatches,
  parseShipArgs,
} from "../scripts/ship.mjs";
import { evaluateSpec } from "../scripts/spec-eval.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const STRONG = readFileSync(path.join(DIR, "fixtures", "spec-eval", "strong-spec.md"), "utf8");
const RUBRIC = { raw: "", frontmatter: { budget: 2 }, rows: [] };

test("build accepts repeatable builder skills and spec declarations when flags are absent", () => {
  const parsed = parseBuildArgs([
    "plan.md",
    "feat/aio",
    "--builder-skill",
    "evolve-versioned-contract",
    "--builder-skill",
    "verify-schema-validator-parity",
  ]);
  assert.deepEqual(parsed.builderSkills, [
    "evolve-versioned-contract",
    "verify-schema-validator-parity",
  ]);
  const plan =
    "---\nskills:\n  - evolve-versioned-contract\n  - verify-schema-validator-parity\n---\n# Plan";
  const fromSpec = resolveBuilderSkillContext({ repo: REPO, plan });
  assert.equal(fromSpec.source, "spec");
  assert.deepEqual(
    fromSpec.audit.map((entry) => entry.id),
    ["evolve-versioned-contract", "verify-schema-validator-parity"]
  );
});

test("explicit builder flags override spec declarations and full bodies reach only builder prompts", () => {
  const plan = "---\nskills: [protect-transcript-data]\n---\n# Plan";
  const context = resolveBuilderSkillContext({
    repo: REPO,
    plan,
    builderSkills: ["verify-generated-distribution"],
  });
  assert.equal(context.source, "flag");
  assert.deepEqual(
    context.audit.map((entry) => entry.id),
    ["verify-generated-distribution"]
  );
  const implement = buildImplementPrompt(plan, { branch: "feat/aio", builderContext: context });
  assert.match(implement, /# Verify generated distribution/);

  const review = buildCodeReviewPrompt({
    skill: "/ai-code-review",
    plan,
    diff: "diff",
    diffStat: "stat",
    logOneline: "commit",
    secretsResult: "clear",
    branch: "feat/aio",
    round: 1,
    maxRounds: 2,
    builderSkillAudit: context.audit,
  });
  assert.match(review, /verify-generated-distribution sha256=/);
  assert.doesNotMatch(review, /# Verify generated distribution/);
});

test("ship parses repeatable flags and separates plan bodies from reviewer audit pointers", () => {
  const parsed = parseShipArgs([
    "AIO-1",
    "--builder-skill",
    "evolve-versioned-contract",
    "--builder-skill",
    "verify-schema-validator-parity",
  ]);
  assert.deepEqual(parsed.builderSkills, [
    "evolve-versioned-contract",
    "verify-schema-validator-parity",
  ]);
  const context = resolveBuilderSkillContext({
    repo: REPO,
    plan: "# Plan",
    builderSkills: ["evolve-versioned-contract"],
  });
  const issue = { identifier: "AIO-1", title: "Contract", description: "Task" };
  assert.match(
    buildPlanPrompt(issue, "context", null, null, context),
    /# Evolve a versioned contract/
  );
  const review = buildPlanReviewPrompt("# Plan", 1, 3, null, context.audit);
  assert.match(review, /evolve-versioned-contract sha256=/);
  assert.doesNotMatch(review, /# Evolve a versioned contract/);
});

test("resume checkpoint changes when any selected skill hash changes", () => {
  const context = resolveBuilderSkillContext({
    repo: REPO,
    plan: "# Plan",
    builderSkills: ["evolve-versioned-contract"],
  });
  const checkpoint = builderSkillCheckpoint(context);
  assert.equal(builderSkillCheckpointMatches(checkpoint, structuredClone(checkpoint)), true);
  const changed = structuredClone(checkpoint);
  changed.skills[0].sha256 = "0".repeat(64);
  assert.equal(builderSkillCheckpointMatches(checkpoint, changed), false);
});

test("unknown spec declarations fail before the adversarial model is called", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      evaluateSpec({
        specText: `---\nskills: [not-a-real-skill]\n---\n${STRONG}`,
        repo: REPO,
        rubric: RUBRIC,
        evalFn: () => {
          calls++;
          return JSON.stringify({ verdict: "SPEC_READY", score: 100, findings: [] });
        },
      }),
    /unknown skill/
  );
  assert.equal(calls, 0);
});

test("publishable evaluation refuses SPEC_READY when the evaluated tree is dirty", async () => {
  const result = await evaluateSpec({
    specText: STRONG,
    repo: REPO,
    rubric: RUBRIC,
    evalFn: () => JSON.stringify({ verdict: "SPEC_READY", score: 100, findings: [] }),
    requireCleanRepo: true,
    resolveRepoState: () => ({ repoSha: "1".repeat(40), repoDirty: true }),
  });
  assert.equal(result.verdict, "NOT_READY");
  assert.equal(result.exitCode, 1);
  assert.equal(result.publishable, false);
  assert.ok(result.findings.some((finding) => finding.ruleId === "SR0"));
});

test("legacy no-skill plans preserve the old prompt shape", () => {
  const context = resolveBuilderSkillContext({ repo: REPO, plan: "# Plan" });
  assert.equal(context.source, "none");
  assert.equal(context.audit.length, 0);
  assert.doesNotMatch(
    buildImplementPrompt("# Plan", { branch: "feat/aio", builderContext: context }),
    /Selected builder skills/
  );
});
