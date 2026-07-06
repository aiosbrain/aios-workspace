#!/usr/bin/env node
import { parseModelRef, modelFamily, toOpenRouterModelId } from "../scripts/model-providers.mjs";

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
  ok("openrouter prefix", parseModelRef("openrouter:anthropic/claude-sonnet-4").provider === "openrouter");
  ok("opencode prefix", parseModelRef("opencode:glm-5.2").provider === "opencode");
  ok("deepseek bare", parseModelRef("deepseek-v4-pro").provider === "deepseek");
  ok("vendor/model → openrouter", parseModelRef("z-ai/glm-4.5-air").provider === "openrouter");
  ok("claude bare", parseModelRef("claude-sonnet-5").provider === "claude");
  ok("glm bare → opencode or openrouter", ["opencode", "openrouter"].includes(parseModelRef("glm-5.2").provider));
}

console.log("modelFamily diversity");
{
  ok("claude vs deepseek differ", modelFamily("claude-opus-4-8") !== modelFamily("deepseek-v4-pro"));
  ok("glm vs kimi differ", modelFamily("opencode:glm-5.2") !== modelFamily("opencode:kimi-k2.7-code"));
  ok("openrouter anthropic", modelFamily("anthropic/claude-sonnet-4") === "anthropic");
}

console.log("toOpenRouterModelId");
{
  ok("aliases glm", toOpenRouterModelId("glm-5.2").includes("/"));
}

if (failed) process.exit(1);
console.log("\nall checks passed");
