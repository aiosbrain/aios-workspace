// council-models.mjs — config resolution + diversity guard for `aios council` (AIO-225, P0).
// Mirrors scripts/loop-models.mjs's shape (flat-YAML override, fail-closed family guard) but
// for an N-model panel instead of a build/review pair. Extends the family taxonomy beyond
// anthropic/openai since OpenRouter exposes many labs — kept here rather than in
// loop-models.mjs per the PRD's P2 note (docs/prd-council-harness.md §5): a future pass should
// hoist this into one shared module so loop-models and council-models can't drift.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFlatYaml } from "./flat-yaml.mjs";
import { die } from "./relay-core.mjs";

export const DEFAULT_COUNCIL_MODELS = [
  "openai/gpt-5.5",
  "google/gemini-3.5-flash",
  "x-ai/grok-4.3",
];

// Family taxonomy for the diversity guard. Prefix-matched against the OpenRouter model id's
// segment after the vendor slash (e.g. "google/gemini-3-pro" -> "gemini-3-pro" -> google).
export function modelFamily(model) {
  const id = String(model ?? "").toLowerCase();
  const tail = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  if (tail.startsWith("claude") || tail.startsWith("fable")) return "anthropic";
  if (tail.startsWith("gpt") || tail.startsWith("o1") || tail.startsWith("o3")) return "openai";
  if (tail.startsWith("gemini")) return "google";
  if (tail.startsWith("grok")) return "xai";
  if (tail.startsWith("deepseek")) return "deepseek";
  if (tail.startsWith("glm")) return "zhipu";
  return "other";
}

function configPath(repo) {
  return path.join(repo, ".aios", "council-models.yaml");
}

// Precedence: CLI override > file > default. Returns { models, chairmanModel }.
export function resolveCouncilConfig(repo, { modelsOverride } = {}) {
  if (modelsOverride?.length) {
    return { models: modelsOverride, chairmanModel: null };
  }
  const file = configPath(repo);
  if (existsSync(file)) {
    const parsed = parseFlatYaml(readFileSync(file, "utf8"), { strict: true });
    const models = Array.isArray(parsed.council_models) ? parsed.council_models : null;
    if (models?.length) {
      return { models, chairmanModel: parsed.chairman_model ?? null };
    }
  }
  return { models: DEFAULT_COUNCIL_MODELS, chairmanModel: null };
}

// Fail-closed diversity guard: abort before any API call if the panel resolves to fewer than
// 2 distinct model families. Mirrors loop-models.mjs's DIVERSITY_PAIRS guard doctrine.
export function assertDiverse(models) {
  const families = new Set(models.map(modelFamily));
  if (families.size < 2) {
    die(
      `council panel has no cross-lab diversity — all ${models.length} model(s) resolve to a ` +
        `single family (${[...families][0]}). Add a model from a different family or the ` +
        `council result is just one lab talking to itself.`
    );
  }
}
