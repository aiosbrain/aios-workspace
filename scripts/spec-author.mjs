/**
 * Parallel spec authoring. A plan is shared context; each input slice is the sole authority for
 * one output spec, so calls can safely fan out without concurrent writes to the same file.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { c } from "./relay-core.mjs";
import { callPromptModel, requirePromptModelKey } from "./model-call.mjs";
import { parseModelRef } from "./model-providers.mjs";
import { loadRubric, runDeterministicChecks, SPEC_BATCH_CONCURRENCY_MAX } from "./spec-checks.mjs";
import { loadSkillContext, parseDeclaredSkills } from "./skill-context.mjs";

const DEFAULT_RUBRIC_REL = path.join(".claude", "rubrics", "spec-readiness.md");
const TIMEOUT_MS = 300_000;
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function sliceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function prompt({ plan, slice, rubric, skillContext }) {
  return [
    "Write exactly one implementation-ready Markdown spec for the issue slice below.",
    "Use the shared plan for context, but do not expand the issue slice's scope.",
    "Satisfy every criterion in the supplied spec-readiness rubric. Output Markdown only.",
    "\n# Stage skill\n",
    skillContext.prompt,
    "\n# Shared plan\n",
    plan,
    "\n# Assigned issue slice\n",
    slice,
    "\n# Rubric\n",
    rubric.raw,
  ].join("\n");
}

async function authorOne({ plan, slice, rubric, skillContext, authorCfg, authorFn }) {
  const specText = await authorFn({ plan, slice, rubric, skillContext, authorCfg });
  const declaredSkills = parseDeclaredSkills(specText);
  const suitePath = path.join(authorCfg.repo, ".claude", "skill-suite.json");
  if (existsSync(suitePath)) {
    loadSkillContext({
      repo: authorCfg.repo,
      ids: declaredSkills,
      stage: "builder",
      source: declaredSkills.length ? "spec" : "none",
    });
  } else if (declaredSkills.length) {
    throw new Error("spec declares focused skills but .claude/skill-suite.json is missing");
  }
  return {
    specText: specText.trim(),
    declaredSkills,
    deterministic: runDeterministicChecks(specText, { repo: authorCfg.repo }),
  };
}

/** Deterministic, post-fan-out consistency signals. Warnings do not replace each spec's gate. */
export function checkAuthoringConsistency(results) {
  const warnings = [];
  const titles = new Map();
  const paths = new Map();
  const declarations = new Map();
  for (const result of results) {
    if (typeof result.specText !== "string") continue;
    const title = /^#\s+(.+)$/m.exec(result.specText)?.[1]?.trim();
    if (title) (titles.get(title) ?? titles.set(title, []).get(title)).push(result.file);
    for (const match of result.specText.matchAll(/`((?:src|test)\/[^`\s]+)`/g)) {
      const ref = match[1];
      (paths.get(ref) ?? paths.set(ref, []).get(ref)).push(result.file);
    }
    const key = JSON.stringify(result.declaredSkills ?? parseDeclaredSkills(result.specText));
    (declarations.get(key) ?? declarations.set(key, []).get(key)).push(result.file);
  }
  for (const [title, files] of titles)
    if (files.length > 1) warnings.push({ kind: "duplicate_title", title, files });
  for (const [ref, files] of paths)
    if (files.length > 1) warnings.push({ kind: "shared_path", ref, files });
  if (declarations.size > 1)
    warnings.push({
      kind: "declared_skills_mismatch",
      declarations: [...declarations.entries()].map(([skills, files]) => ({
        skills: JSON.parse(skills),
        files,
      })),
    });
  return warnings;
}

export async function runSpecAuthor({
  plan,
  slices,
  repo,
  rubric,
  authorCfg,
  concurrency = 6,
  authorFn,
}) {
  const suitePath = path.join(repo, ".claude", "skill-suite.json");
  const skillContext = existsSync(suitePath)
    ? loadSkillContext({
        repo,
        ids: ["author-ready-spec"],
        stage: "spec-author",
        source: "workflow",
      })
    : {
        source: "none",
        stage: "spec-author",
        bytes: 0,
        skills: [],
        prompt: "(focused delivery skill suite is not installed)",
        audit: [],
      };
  const out = [];
  for (let index = 0; index < slices.length; index += concurrency) {
    const batch = slices.slice(index, index + concurrency);
    out.push(
      ...(await Promise.all(
        batch.map(async (file) => {
          try {
            return {
              file,
              ...(await authorOne({
                plan,
                slice: readFileSync(file, "utf8"),
                rubric,
                skillContext,
                authorCfg: { ...authorCfg, repo },
                authorFn,
              })),
            };
          } catch (error) {
            return {
              file,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        })
      ))
    );
  }
  return {
    results: out,
    consistency: checkAuthoringConsistency(out),
    injectedSkills: skillContext.audit,
  };
}

export async function cmdSpecAuthor(repo, args, { models }) {
  const flag = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? null : args[index + 1];
  };
  const has = (name) => args.includes(name);
  const planFile = args.find(
    (arg, index) =>
      !arg.startsWith("--") &&
      !["--slices", "--out", "--concurrency", "--model", "--effort"].includes(args[index - 1])
  );
  const slicesDir = flag("--slices");
  if (!planFile || !slicesDir)
    throw new Error(
      "usage: aios spec author <plan> --slices <dir> [--out <dir>] [--concurrency N] [--model <id>] [--effort <level>]"
    );
  const planPath = path.resolve(planFile);
  const slices = sliceFiles(path.resolve(slicesDir));
  if (!existsSync(planPath) || !slices.length)
    throw new Error("spec author needs a readable plan and at least one Markdown issue slice");
  const rubric = loadRubric(path.join(repo, DEFAULT_RUBRIC_REL));
  const outputDir = path.resolve(flag("--out") ?? path.join(path.dirname(planPath), "specs"));
  const concurrency = Math.min(
    SPEC_BATCH_CONCURRENCY_MAX,
    Math.max(1, Number(flag("--concurrency") ?? 6) || 6)
  );
  const authorCfg = {
    ...models.spec_author,
    ...(flag("--model") ? { model: flag("--model") } : {}),
    ...(flag("--effort") ? { effort: flag("--effort") } : {}),
  };
  if (flag("--effort") && !VALID_EFFORTS.has(authorCfg.effort)) {
    throw new Error(
      `invalid --effort '${authorCfg.effort}' (expected ${[...VALID_EFFORTS].join("|")})`
    );
  }
  const stub = process.env.AIOS_SPEC_AUTHOR_STUB;
  if (stub == null) requirePromptModelKey(authorCfg.model, "spec_author");
  const authorFn =
    stub != null
      ? async () => (existsSync(stub) ? readFileSync(stub, "utf8") : stub)
      : async ({ plan, slice, rubric: currentRubric, skillContext, authorCfg }) =>
          callPromptModel({
            model: authorCfg.model,
            prompt: prompt({ plan, slice, rubric: currentRubric, skillContext }),
            timeoutMs: authorCfg.timeoutMs ?? TIMEOUT_MS,
            // The prompt-model layer is provider-neutral; effort is a Claude CLI option only.
            // Do not leak a CLI-only option into OpenRouter/DeepSeek request payloads.
            opts:
              authorCfg.effort && parseModelRef(authorCfg.model).provider === "claude"
                ? { extraArgs: ["--effort", authorCfg.effort] }
                : {},
          });
  const run = await runSpecAuthor({
    plan: readFileSync(planPath, "utf8"),
    slices,
    repo,
    rubric,
    authorCfg,
    concurrency,
    authorFn,
  });
  if (!has("--dry-run")) {
    mkdirSync(outputDir, { recursive: true });
    const names = run.results.map((item) => path.basename(item.file));
    if (new Set(names).size !== names.length) {
      throw new Error("spec author output collision: issue slices must have unique filenames");
    }
    for (const item of run.results) {
      if (item.error) continue;
      writeFileSync(path.join(outputDir, path.basename(item.file)), `${item.specText}\n`);
    }
  }
  const blockers = run.results.filter(
    (item) => item.error || item.deterministic.some((finding) => finding.severity === "blocker")
  );
  const summary = {
    outputDir,
    model: authorCfg.model,
    effort: authorCfg.effort ?? null,
    injectedSkills: run.injectedSkills,
    results: run.results.map((item) => ({
      file: item.file,
      blockers:
        item.error != null
          ? 1
          : item.deterministic.filter((finding) => finding.severity === "blocker").length,
      error: item.error ?? null,
    })),
    consistency: run.consistency,
  };
  if (has("--json")) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(c.blue("\n── spec author batch ───────────────────────────────────"));
    for (const item of summary.results) {
      const detail = item.error ? ` (${item.error})` : "";
      console.log(`  ${path.basename(item.file)}\tblockers: ${item.blockers}${detail}`);
    }
    console.log(`  consistency warnings: ${run.consistency.length}`);
    if (!has("--dry-run")) console.log(c.dim(`  wrote: ${outputDir}`));
  }
  return blockers.length ? 1 : 0;
}
