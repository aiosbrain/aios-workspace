#!/usr/bin/env node
import {
  parseModelRef,
  modelFamily,
  toOpenRouterModelId,
  isSupportedCodexModel,
  REVIEWER_PRESETS,
  resolveReviewerPreset,
} from "../scripts/model-providers.mjs";

let failed = 0;
const ok = (label, cond) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
};

console.log("parseModelRef");
{
  ok(
    "openrouter prefix",
    parseModelRef("openrouter:anthropic/claude-sonnet-4").provider === "openrouter"
  );
  ok("opencode prefix", parseModelRef("opencode:glm-5.2").provider === "opencode");
  ok("codex prefix", parseModelRef("codex:gpt-5.6-sol").provider === "codex");
  ok("Codex Sol tier supported", isSupportedCodexModel("gpt-5.6-sol"));
  ok("Codex Terra tier supported", isSupportedCodexModel("gpt-5.6-terra"));
  ok("Codex Luna tier supported", isSupportedCodexModel("gpt-5.6-luna"));
  ok("deepseek bare", parseModelRef("deepseek-v4-pro").provider === "deepseek");
  ok("vendor/model → openrouter", parseModelRef("z-ai/glm-4.5-air").provider === "openrouter");
  ok("claude bare", parseModelRef("claude-sonnet-5").provider === "claude");
  ok(
    "glm bare → opencode or openrouter",
    ["opencode", "openrouter"].includes(parseModelRef("glm-5.2").provider)
  );
}

console.log("modelFamily diversity");
{
  ok(
    "claude vs deepseek differ",
    modelFamily("claude-opus-4-8") !== modelFamily("deepseek-v4-pro")
  );
  ok(
    "glm vs kimi differ",
    modelFamily("opencode:glm-5.2") !== modelFamily("opencode:kimi-k2.7-code")
  );
  ok("openrouter anthropic", modelFamily("anthropic/claude-sonnet-4") === "anthropic");
  ok(
    "Codex OpenAI builder vs DeepSeek reviewer differ",
    modelFamily("codex:gpt-5.6-sol") === "openai" &&
      modelFamily("deepseek:deepseek-v4-pro") === "deepseek"
  );
}

console.log("toOpenRouterModelId");
{
  ok("aliases glm", toOpenRouterModelId("glm-5.2").includes("/"));
}

console.log("reviewer presets (runtime-agnostic reviewer selection)");
{
  ok(
    "deepseek preset resolves",
    resolveReviewerPreset("deepseek")?.model === "deepseek:deepseek-v4-pro"
  );
  ok("unknown preset resolves to null", resolveReviewerPreset("not-a-preset") === null);
  ok(
    "inherited constructor preset resolves to null",
    resolveReviewerPreset("constructor") === null
  );
  ok("inherited __proto__ preset resolves to null", resolveReviewerPreset("__proto__") === null);
  ok(
    "claude-subscription preset routes through claude: provider",
    parseModelRef(REVIEWER_PRESETS["claude-subscription"].model).provider === "claude"
  );
  ok(
    "claude-subscription preset uses the supported Fable model id",
    REVIEWER_PRESETS["claude-subscription"].model === "claude:fable-5"
  );
  ok(
    "codex-subscription preset routes through codex: provider",
    parseModelRef(REVIEWER_PRESETS["codex-subscription"].model).provider === "codex"
  );
  ok(
    "codex-subscription preset uses a supported Codex tier",
    isSupportedCodexModel(parseModelRef(REVIEWER_PRESETS["codex-subscription"].model).modelId)
  );
  ok(
    "every preset declares a billing mode",
    Object.values(REVIEWER_PRESETS).every(
      (p) => p.billing === "subscription" || p.billing === "api"
    )
  );
  ok(
    "subscription and api presets both exist (runtime-agnostic)",
    Object.values(REVIEWER_PRESETS).some((p) => p.billing === "subscription") &&
      Object.values(REVIEWER_PRESETS).some((p) => p.billing === "api")
  );
}

if (failed) process.exit(1);
console.log("\nall checks passed");
await import("./model-call-codex.test.mjs");
