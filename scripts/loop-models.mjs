// loop-models.mjs — per-step model + effort + timeout resolver for the agent relay
// (plan/build) and, later, `aios ship` / roadmap-run / the consolidator. Zero-dep;
// mirrors scripts/loop-config.mjs. The default matrix is baked in code; an optional
// flat-YAML file at .aios/loop-models.yaml tunes it, and CLI flags win over both.
//
// Precedence (applied per field): CLI overrides > file > defaults.
//
// Diversity guard (fail closed): the builder and its reviewer — and the planner and
// its reviewer — MUST be different model families, so the reviewer is a genuinely
// independent model. The defaults satisfy it (Anthropic build/plan vs OpenAI reviews).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFlatYaml } from "./flat-yaml.mjs";
import { die } from "./relay-core.mjs";

// The default per-step matrix. `effort` is omitted for steps whose model/runner does
// not take a reasoning-effort knob. Keep this in sync with docs/loop-models.example.yaml.
export const DEFAULT_MODELS = {
  recon: { model: "claude-haiku-4-5" },
  plan: { model: "claude-opus-4-8", effort: "xhigh" },
  plan_review: { model: "gpt-5.5-high" },
  build: { model: "claude-opus-4-8", effort: "high" },
  code_review: { model: "gpt-5.5-high" },
  fix: { model: "claude-opus-4-8", effort: "medium" },
  fix_escalated: { model: "claude-opus-4-8", effort: "high" },
  consolidate: { model: "claude-haiku-4-5" },
  safety_review: { model: "claude-opus-4-8", effort: "xhigh" },
  orchestrate: { model: "fable-5" },
  digest: { model: "claude-haiku-4-5" },
};

export const STEPS = Object.keys(DEFAULT_MODELS);

// Family for the diversity guard: Anthropic (claude*/fable*), OpenAI (gpt*), else other.
export function modelFamily(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.startsWith("claude") || m.startsWith("fable")) return "anthropic";
  if (m.startsWith("gpt")) return "openai";
  return "other";
}

// The producer/reviewer pairs that must stay cross-family.
const DIVERSITY_PAIRS = [
  ["build", "code_review"],
  ["plan", "plan_review"],
];

function assertDiversity(resolved) {
  for (const [producer, reviewer] of DIVERSITY_PAIRS) {
    const pf = modelFamily(resolved[producer].model);
    const rf = modelFamily(resolved[reviewer].model);
    if (pf === rf) {
      die(
        `${producer} and ${reviewer} must use different model families (both resolved to '${pf}'); ` +
          `the reviewer must be an independent model — set ${reviewer}_model to a different-family ` +
          `model (e.g. a gpt-* model) in .aios/loop-models.yaml`
      );
    }
  }
}

/**
 * Resolve { [step]: { model, effort, timeoutMs } } for every step in the matrix.
 *
 * @param {object}  [o]
 * @param {string}  [o.configPath]     path to .aios/loop-models.yaml (default: <repo>/.aios/loop-models.yaml)
 * @param {string}  [o.repo]           repo root, used to derive the default configPath
 * @param {object}  [o.cliOverrides]   { [step]: { model?, effort?, timeoutMs? } } — win over file + defaults
 */
export function resolveLoopModels({ configPath, repo, cliOverrides = {} } = {}) {
  const file = configPath ?? (repo ? path.join(repo, ".aios", "loop-models.yaml") : null);
  let fileCfg = {};
  if (file && existsSync(file)) {
    try {
      fileCfg = parseFlatYaml(readFileSync(file, "utf8"));
    } catch {
      fileCfg = {};
    }
  }

  const resolved = {};
  for (const step of STEPS) {
    const def = DEFAULT_MODELS[step];
    const over = cliOverrides[step] ?? {};

    const model = over.model ?? fileCfg[`${step}_model`] ?? def.model;

    const effort = over.effort ?? fileCfg[`${step}_effort`] ?? def.effort;

    let timeoutMs;
    if (over.timeoutMs != null) {
      timeoutMs = over.timeoutMs;
    } else if (fileCfg[`${step}_timeout_s`] != null) {
      const secs = parseInt(fileCfg[`${step}_timeout_s`], 10);
      if (Number.isFinite(secs) && secs > 0) timeoutMs = secs * 1000;
    }

    const entry = { model };
    if (effort != null) entry.effort = effort;
    if (timeoutMs != null) entry.timeoutMs = timeoutMs;
    resolved[step] = entry;
  }

  // Fail closed regardless of source — defaults, file, and CLI all pass through here.
  assertDiversity(resolved);
  return resolved;
}
