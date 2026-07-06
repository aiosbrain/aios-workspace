// council-models.mjs — config resolution + diversity guard for `aios council` (AIO-225, P0).
// Family taxonomy lives in model-providers.mjs (shared with loop-models).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFlatYaml } from "./flat-yaml.mjs";
import { die } from "./relay-core.mjs";
import { modelFamily } from "./model-providers.mjs";

export { modelFamily } from "./model-providers.mjs";

// Trailing commas and empty YAML items are tolerated; normalizePanelModels requires ≥2 models.
export const DEFAULT_COUNCIL_MODELS = [
  "openai/gpt-5.5",
  "google/gemini-3.5-flash",
  "x-ai/grok-4.3",
];
export function normalizePanelModels(models, { label = "council_models" } = {}) {
  if (!Array.isArray(models)) {
    die(`${label} must be a non-empty list of OpenRouter model ids`);
  }
  const cleaned = models.map((m) => String(m ?? "").trim()).filter(Boolean);
  if (cleaned.length < 2) {
    die(
      `${label} must list at least 2 non-empty model ids (got ${cleaned.length} after dropping blanks)`
    );
  }
  return cleaned;
}

function configPath(repo) {
  return path.join(repo, ".aios", "council-models.yaml");
}

// Precedence: CLI override > file > default. Returns { models }.
export function resolveCouncilConfig(repo, { modelsOverride } = {}) {
  if (modelsOverride != null) {
    return { models: normalizePanelModels(modelsOverride, { label: "--models" }) };
  }
  const file = configPath(repo);
  if (existsSync(file)) {
    let parsed;
    try {
      parsed = parseFlatYaml(readFileSync(file, "utf8"), { strict: true });
    } catch (err) {
      die(`invalid ${file}: ${err.message}`);
    }
    if (!Array.isArray(parsed.council_models)) {
      die(`${file} exists but council_models is missing or not a list — fix the file or remove it`);
    }
    return { models: normalizePanelModels(parsed.council_models, { label: "council_models" }) };
  }
  return { models: DEFAULT_COUNCIL_MODELS };
}

// Fail-closed diversity guard: abort before any API call if the panel resolves to fewer than
// 2 distinct model families. Mirrors loop-models.mjs's DIVERSITY_PAIRS guard doctrine.
export function assertDiverse(models) {
  const panel = normalizePanelModels(models);
  const families = new Set(panel.map(modelFamily));
  if (families.size < 2) {
    die(
      `council panel has no cross-lab diversity — all ${panel.length} model(s) resolve to a ` +
        `single family (${[...families][0]}). Add a model from a different family or the ` +
        `council result is just one lab talking to itself.`
    );
  }
  return panel;
}
