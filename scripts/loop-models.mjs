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
  // Spec/plan readiness harness (EE5): the adversarial evaluator + the fix-loop reviser. Both
  // run on the Anthropic SDK, so both are Claude-runner steps. There is NO diversity pair here —
  // spec eval is a single adversarial pass, not a producer/reviewer loop (prompt-discipline, not
  // model-family independence, is what makes it trustworthy).
  spec_eval: { model: "claude-opus-4-8", effort: "xhigh" },
  spec_fix: { model: "claude-opus-4-8", effort: "high" },
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

// Steps whose model is handed to a Claude runner: the Claude Code CLI (callClaudeAgent —
// build/fix/fix_escalated) or the Claude Agent SDK (plan). Their model MUST be Claude-family
// (anthropic), or a non-Claude id (e.g. gpt-5.3-codex) would be passed straight to a Claude
// runner and fail obscurely. The reviewer steps run on Cursor and are unconstrained here.
const CLAUDE_RUNNER_STEPS = ["plan", "build", "fix", "fix_escalated", "spec_eval", "spec_fix"];

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
    if (over.effort != null && !VALID_EFFORTS.has(over.effort)) {
      die(
        `invalid effort '${over.effort}' for ${step} — must be one of ${[...VALID_EFFORTS].join("|")}.`
      );
    }
  }
}

// Claude-runner steps must resolve to a Claude-family (anthropic) model.
function assertRunnerFamilies(resolved) {
  for (const step of CLAUDE_RUNNER_STEPS) {
    const fam = modelFamily(resolved[step].model);
    if (fam !== "anthropic") {
      die(
        `${step} runs on a Claude runner and needs a Claude-family model, but ` +
          `'${resolved[step].model}' resolves to '${fam}'. Set ${step}_model to a ` +
          `claude-*/fable-* model in .aios/loop-models.yaml (or pass --model with a Claude id).`
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
  assertRunnerFamilies(resolved);
  assertDiversity(resolved);
  return resolved;
}
