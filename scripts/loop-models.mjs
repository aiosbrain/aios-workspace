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
import { modelFamily, parseModelRef, isAgenticProvider } from "./model-providers.mjs";

// The default per-step matrix. `effort` is omitted for steps whose model/runner does
// not take a reasoning-effort knob. Keep this in sync with docs/loop-models.example.yaml.
export const DEFAULT_MODELS = {
  recon: { model: "claude-haiku-4-5" },
  plan: { model: "claude-opus-4-8", effort: "xhigh" },
  // plan_review/code_review moved to DeepSeek's own API (2026-07-04): the Cursor Ultra plan's
  // monthly usage cap was already exhausted, blocking gpt-5.5-high AND glm-5.2-high alike — an
  // account-wide cap, not a model-specific one. A same-diff sanity check (see
  // 2-work/experiments/glm-deepseek-review-sanity-check/REPORT.md) found deepseek-v4-pro gave an
  // accurate, honestly-reasoned review with no fabrication, while glm-5.2 (direct via Z.ai,
  // bypassing the cap) produced a confident but FALSE "Critical" finding with fabricated tool-call
  // transcripts — disqualifying for an unsupervised merge-gate role. gpt-5.5-high couldn't be
  // re-tested (still capped) so this isn't a head-to-head win over it, but deepseek-v4-pro is a
  // real, network-independent-of-Cursor, verified-accurate reviewer.
  plan_review: { model: "deepseek-v4-pro" },
  build: { model: "claude-opus-4-8", effort: "high" },
  code_review: { model: "deepseek-v4-pro" },
  fix: { model: "claude-opus-4-8", effort: "medium" },
  fix_escalated: { model: "claude-opus-4-8", effort: "high" },
  consolidate: { model: "claude-haiku-4-5" },
  safety_review: { model: "claude-opus-4-8", effort: "xhigh" },
  orchestrate: { model: "fable-5" },
  digest: { model: "claude-haiku-4-5" },
  // Spec/plan readiness harness (EE5): adversarial evaluator + fix-loop reviser. Prompt-only
  // single-shot calls — default deepseek-v4-pro (same reviewer backend as plan_review/code_review)
  // so spec grading does not consume Anthropic API credits.
  spec_eval: { model: "deepseek-v4-pro" },
  spec_fix: { model: "deepseek-v4-pro" },
  // Decision-corpus distillation (EE4 / AIO-192): a single summarization pass over the local
  // steering-decision corpus. Like spec_eval it is NOT a producer/reviewer loop — no diversity
  // pair — so it stays out of DIVERSITY_PAIRS; it runs through llm.ts (Anthropic SDK) so it IS a
  // Claude-runner step.
  decisions_distill: { model: "claude-opus-4-8", effort: "high" },
};

export { modelFamily } from "./model-providers.mjs";

export const STEPS = Object.keys(DEFAULT_MODELS);

// Agentic steps run through a tool-capable runner (Claude Code, Cursor, or OpenCode CLI).
const AGENTIC_STEPS = ["plan", "build", "fix", "fix_escalated"];

// The producer/reviewer pairs that must stay cross-family.
const DIVERSITY_PAIRS = [
  ["build", "code_review"],
  ["plan", "plan_review"],
];

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const STEP_SET = new Set(STEPS);
// A well-formed config key is `<step>_<field>`; step names contain underscores, so the
// suffix alternation is anchored and the remainder must be a known step.
const KEY_RE = /^(.+)_(model|effort|timeout_s)$/;

// The config surface must fail loudly, not silently fall back to defaults. Rejects: junk /
// unknown-step keys, non-scalar values, invalid effort strings, non-numeric or non-positive
// timeouts. (A MISSING file is fine — that just means defaults; this only runs on a present file.)
function validateFileCfg(fileCfg, file) {
  for (const [key, value] of Object.entries(fileCfg)) {
    const m = KEY_RE.exec(key);
    if (!m || !STEP_SET.has(m[1])) {
      die(
        `unknown key '${key}' in ${file} — expected <step>_model / <step>_effort / ` +
          `<step>_timeout_s for a known step (${STEPS.join(", ")}).`
      );
    }
    const field = m[2];
    if (Array.isArray(value)) {
      die(`invalid '${key}' in ${file} — expected a scalar value, not a list.`);
    }
    // An empty/blank model would beat the default via the `??` chain, then silently drop the
    // `--model` arg in the runner (truthy-spread) — a hidden fallback. Reject it here instead.
    if (field === "model" && (typeof value !== "string" || !value.trim())) {
      die(`invalid ${key}='${value}' in ${file} — model must be a non-empty string.`);
    }
    if (field === "effort" && !VALID_EFFORTS.has(value)) {
      die(
        `invalid ${key}='${value}' in ${file} — effort must be one of ${[...VALID_EFFORTS].join("|")}.`
      );
    }
    if (field === "timeout_s") {
      const secs = Number(value);
      if (!Number.isInteger(secs) || secs <= 0) {
        die(
          `invalid ${key}='${value}' in ${file} — timeout_s must be a positive integer (seconds).`
        );
      }
    }
  }
}

// Same loud-failure contract for CLI overrides (unknown step, bad effort).
function validateCliOverrides(cliOverrides) {
  for (const [step, over] of Object.entries(cliOverrides)) {
    if (!STEP_SET.has(step)) {
      die(`unknown step '${step}' in CLI overrides — known steps: ${STEPS.join(", ")}.`);
    }
    if (over.model != null && (typeof over.model !== "string" || !over.model.trim())) {
      die(`invalid model '${over.model}' for ${step} — model must be a non-empty string.`);
    }
    if (over.effort != null && !VALID_EFFORTS.has(over.effort)) {
      die(
        `invalid effort '${over.effort}' for ${step} — must be one of ${[...VALID_EFFORTS].join("|")}.`
      );
    }
  }
}

function assertAgenticProviders(resolved) {
  for (const step of AGENTIC_STEPS) {
    const ref = parseModelRef(resolved[step].model);
    if (!isAgenticProvider(ref.provider)) {
      die(
        `${step} needs an agentic provider (claude, cursor, or opencode) but ` +
          `'${resolved[step].model}' resolves to '${ref.provider}'. ` +
          `Prefix with claude:, cursor:, or opencode: — or use openrouter:/deepseek:/opencode: on review steps only.`
      );
    }
  }
}

function assertDiversity(resolved) {
  for (const [producer, reviewer] of DIVERSITY_PAIRS) {
    const pf = modelFamily(resolved[producer].model);
    const rf = modelFamily(resolved[reviewer].model);
    if (pf === rf) {
      die(
        `${producer} and ${reviewer} must use different model families (both resolved to '${pf}'); ` +
          `the reviewer must be an independent model — set ${reviewer}_model to a different-family ` +
          `model (e.g. opencode:glm-5.2 or openrouter:openai/gpt-5.5) in .aios/loop-models.yaml`
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
  // A MISSING file is fine (defaults). A PRESENT-but-broken file fails loudly, never a
  // silent fall-back to defaults — an unreadable/unparseable/malformed config is a bug.
  let fileCfg = {};
  if (file && existsSync(file)) {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      die(`could not read ${file}: ${e.message}`);
    }
    try {
      // strict: a malformed line (e.g. a missing colon) throws here rather than being
      // silently dropped — otherwise the file would resolve to defaults without warning.
      fileCfg = parseFlatYaml(raw, { strict: true });
    } catch (e) {
      die(`could not parse ${file}: ${e.message}`);
    }
    validateFileCfg(fileCfg, file);
  }
  validateCliOverrides(cliOverrides);

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
      // validateFileCfg has already guaranteed a positive integer here.
      timeoutMs = Number(fileCfg[`${step}_timeout_s`]) * 1000;
    }

    const entry = { model };
    if (effort != null) entry.effort = effort;
    if (timeoutMs != null) entry.timeoutMs = timeoutMs;
    resolved[step] = entry;
  }

  // Fail closed regardless of source — defaults, file, and CLI all pass through here.
  assertAgenticProviders(resolved);
  assertDiversity(resolved);
  return resolved;
}
