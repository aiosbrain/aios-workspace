/**
 * Parallel spec authoring. A plan is shared context; each input slice is the sole authority for
 * one output spec, so calls can safely fan out without concurrent writes to the same file.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { c } from "./relay-core.mjs";
import { callPromptModel, requirePromptModelKey } from "./model-call.mjs";
import { parseModelRef } from "./model-providers.mjs";
import { loadRubric, runDeterministicChecks } from "./spec-eval.mjs";

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

function prompt({ plan, slice, rubric }) {
  return [
    "Write exactly one implementation-ready Markdown spec for the issue slice below.",
    "Use the shared plan for context, but do not expand the issue slice's scope.",
    "Satisfy every criterion in the supplied spec-readiness rubric. Output Markdown only.",
    "\n# Shared plan\n",
    plan,
    "\n# Assigned issue slice\n",
    slice,
    "\n# Rubric\n",
    rubric.raw,
  ].join("\n");
}

async function authorOne({ plan, slice, rubric, authorCfg, authorFn }) {
  const specText = await authorFn({ plan, slice, rubric, authorCfg });
  return {
    specText: specText.trim(),
    deterministic: runDeterministicChecks(specText, { repo: authorCfg.repo }),
  };
}

/** Deterministic, post-fan-out consistency signals. Warnings do not replace each spec's gate. */
export function checkAuthoringConsistency(results) {
  const warnings = [];
  const titles = new Map();
  const paths = new Map();
  for (const result of results) {
    const title = /^#\s+(.+)$/m.exec(result.specText)?.[1]?.trim();
    if (title) (titles.get(title) ?? titles.set(title, []).get(title)).push(result.file);
    for (const match of result.specText.matchAll(/`((?:src|test)\/[^`\s]+)`/g)) {
      const ref = match[1];
      (paths.get(ref) ?? paths.set(ref, []).get(ref)).push(result.file);
    }
  }
  for (const [title, files] of titles)
    if (files.length > 1) warnings.push({ kind: "duplicate_title", title, files });
  for (const [ref, files] of paths)
    if (files.length > 1) warnings.push({ kind: "shared_path", ref, files });
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
  const out = [];
  for (let index = 0; index < slices.length; index += concurrency) {
    const batch = slices.slice(index, index + concurrency);
    out.push(
      ...(await Promise.all(
        batch.map(async (file) => ({
          file,
          ...(await authorOne({
            plan,
            slice: readFileSync(file, "utf8"),
            rubric,
            authorCfg: { ...authorCfg, repo },
            authorFn,
          })),
        }))
      ))
    );
  }
  return { results: out, consistency: checkAuthoringConsistency(out) };
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
  const concurrency = Math.min(8, Math.max(1, Number(flag("--concurrency") ?? 6) || 6));
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
      : async ({ plan, slice, rubric: currentRubric, authorCfg }) =>
          callPromptModel({
            model: authorCfg.model,
            prompt: prompt({ plan, slice, rubric: currentRubric }),
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
    for (const item of run.results)
      writeFileSync(path.join(outputDir, path.basename(item.file)), `${item.specText}\n`);
  }
  const blockers = run.results.filter((item) =>
    item.deterministic.some((finding) => finding.severity === "blocker")
  );
  const summary = {
    outputDir,
    model: authorCfg.model,
    effort: authorCfg.effort ?? null,
    results: run.results.map((item) => ({
      file: item.file,
      blockers: item.deterministic.filter((finding) => finding.severity === "blocker").length,
    })),
    consistency: run.consistency,
  };
  if (has("--json")) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(c.blue("\n── spec author batch ───────────────────────────────────"));
    for (const item of summary.results)
      console.log(`  ${path.basename(item.file)}\tblockers: ${item.blockers}`);
    console.log(`  consistency warnings: ${run.consistency.length}`);
    if (!has("--dry-run")) console.log(c.dim(`  wrote: ${outputDir}`));
  }
  return blockers.length ? 1 : 0;
}
