// model-providers.mjs — runtime-agnostic model refs for the ship/build loop.
//
// Model ids accept an optional provider prefix: `provider:modelId`
//   openrouter:anthropic/claude-sonnet-4
//   opencode:glm-5.2
//   deepseek:deepseek-v4-pro
//   claude:claude-sonnet-5
//   cursor:gpt-5.5-high
//
// Bare ids infer a provider from the id shape and available credentials.

/** @typedef {{ provider: string, modelId: string, raw: string }} ModelRef */

export const AGENTIC_PROVIDERS = new Set(["claude", "cursor", "opencode"]);
export const PROMPT_PROVIDERS = new Set(["openrouter", "deepseek", "opencode", "cursor", "claude"]);

// Bare open-model ids → OpenRouter vendor/model when OpenCode isn't keyed.
export const OPENROUTER_ALIASES = {
  "glm-5.2": "z-ai/glm-4.5-air",
  "glm-5.1": "z-ai/glm-4.5-air",
  "kimi-k2.7-code": "moonshotai/kimi-k2.5",
  "kimi-k2.6": "moonshotai/kimi-k2.5",
  "deepseek-v4-pro": "deepseek/deepseek-chat",
  "deepseek-v4-flash": "deepseek/deepseek-chat",
  "qwen3.7-max": "qwen/qwen-2.5-72b-instruct",
  "qwen3.7-plus": "qwen/qwen-2.5-72b-instruct",
  "qwen3.6-plus": "qwen/qwen-2.5-72b-instruct",
};

const OPENCODE_MESSAGES_MODELS = new Set([
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
]);

function hasEnv(...keys) {
  return keys.some((k) => Boolean(process.env[k]?.trim()));
}

function pickProvider(preferred, fallback) {
  return preferred ?? fallback;
}

/** @returns {ModelRef} */
export function parseModelRef(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { provider: "unknown", modelId: "", raw: s };

  const prefixed = /^([a-z][a-z0-9_-]*):(.+)$/i.exec(s);
  if (prefixed) {
    return { provider: prefixed[1].toLowerCase(), modelId: prefixed[2].trim(), raw: s };
  }

  if (s.startsWith("opencode-go/")) {
    return { provider: "opencode", modelId: s.slice("opencode-go/".length), raw: s };
  }

  if (s.includes("/")) {
    return { provider: "openrouter", modelId: s, raw: s };
  }

  const lower = s.toLowerCase();
  if (lower.startsWith("deepseek")) {
    return { provider: "deepseek", modelId: s, raw: s };
  }
  if (lower.startsWith("claude") || lower.startsWith("fable")) {
    return { provider: "claude", modelId: s, raw: s };
  }
  if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3")) {
    return {
      provider: pickProvider(hasEnv("OPENROUTER_API_KEY") ? "openrouter" : null, "cursor"),
      modelId: s,
      raw: s,
    };
  }
  if (/^(glm|kimi|qwen|minimax|mimo)/i.test(lower)) {
    return {
      provider: pickProvider(
        hasEnv("OPENCODE_API_KEY", "OPENCODE_GO_API_KEY") ? "opencode" : null,
        hasEnv("OPENROUTER_API_KEY") ? "openrouter" : "opencode"
      ),
      modelId: s,
      raw: s,
    };
  }

  return {
    provider: hasEnv("OPENROUTER_API_KEY") ? "openrouter" : "deepseek",
    modelId: s,
    raw: s,
  };
}

export function isAgenticProvider(provider) {
  return AGENTIC_PROVIDERS.has(provider);
}

export function toOpenRouterModelId(modelId) {
  const id = String(modelId ?? "").trim();
  if (id.includes("/")) return id;
  return OPENROUTER_ALIASES[id.toLowerCase()] ?? id;
}

export function toOpencodeModelId(modelId) {
  return String(modelId ?? "")
    .trim()
    .replace(/^opencode-go\//, "");
}

export function opencodeUsesMessagesEndpoint(modelId) {
  return OPENCODE_MESSAGES_MODELS.has(toOpencodeModelId(modelId).toLowerCase());
}

export function resolveOpencodeApiKey() {
  return process.env.OPENCODE_API_KEY ?? process.env.OPENCODE_GO_API_KEY ?? null;
}

// Family taxonomy for the cross-model diversity guard (producer vs reviewer).
export function modelFamily(model) {
  const { provider, modelId } = parseModelRef(model);
  const tail = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  const m = tail.toLowerCase();
  if (!m && provider === "deepseek") return "deepseek";
  if (m.startsWith("claude") || m.startsWith("fable")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("grok")) return "xai";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("glm")) return "zhipu";
  if (m.startsWith("kimi")) return "moonshot";
  if (m.startsWith("qwen")) return "alibaba";
  if (m.startsWith("minimax")) return "minimax";
  if (m.startsWith("mimo")) return "xiaomi";
  if (provider === "openrouter" && modelId.includes("/")) {
    const vendor = modelId.split("/")[0].toLowerCase();
    if (vendor === "anthropic") return "anthropic";
    if (vendor === "openai") return "openai";
    if (vendor === "google") return "google";
    if (vendor === "x-ai" || vendor === "xai") return "xai";
    if (vendor === "deepseek") return "deepseek";
    if (vendor === "z-ai" || vendor === "zhipu") return "zhipu";
    if (vendor === "moonshotai" || vendor === "moonshot") return "moonshot";
    if (vendor === "qwen") return "alibaba";
  }
  return "other";
}
