// model-call.mjs — unified prompt + agent model dispatch for the ship/build loop.
//
// callPromptModel  — single-shot completions (reviews, recon, consolidate, …)
// callAgentModel   — tool-capable runners (plan/build/fix via claude/cursor/opencode CLI)

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  callClaudeAgent,
  callCursorAgent,
  callDeepSeekDirect,
  NO_TOOLS_ARGS,
} from "./relay-core.mjs";
import {
  parseModelRef,
  isAgenticProvider,
  toOpenRouterModelId,
  toOpencodeModelId,
  opencodeUsesMessagesEndpoint,
  resolveOpencodeApiKey,
} from "./model-providers.mjs";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENCODE_CHAT_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const OPENCODE_MESSAGES_URL = "https://opencode.ai/zen/go/v1/messages";

async function fetchCompletion(url, headers, body, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`${label} request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} exited ${res.status}`);
  const json = JSON.parse(text);
  const content =
    json?.choices?.[0]?.message?.content ??
    json?.content?.[0]?.text ??
    json?.content?.[0]?.content ??
    null;
  if (!content) throw new Error(`${label} returned no content`);
  return String(content).trim();
}

export async function callOpenRouter(prompt, timeoutMs, opts = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set — required for openrouter:* models");
  const model = toOpenRouterModelId(opts.model ?? opts.modelId ?? "openai/gpt-4o-mini");
  return fetchCompletion(
    OPENROUTER_URL,
    {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/aios-alpha",
      "X-Title": "aios ship loop",
    },
    { model, messages: [{ role: "user", content: prompt }], max_tokens: opts.maxTokens ?? 8000 },
    timeoutMs,
    `openrouter (${model})`
  );
}

export async function callOpencodeApi(prompt, timeoutMs, opts = {}) {
  const key = resolveOpencodeApiKey();
  if (!key) {
    throw new Error(
      "OPENCODE_API_KEY (or OPENCODE_GO_API_KEY) not set — required for opencode:* models"
    );
  }
  const model = toOpencodeModelId(opts.model ?? opts.modelId ?? "deepseek-v4-flash");
  if (opencodeUsesMessagesEndpoint(model)) {
    return fetchCompletion(
      OPENCODE_MESSAGES_URL,
      { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      {
        model,
        max_tokens: opts.maxTokens ?? 8000,
        messages: [{ role: "user", content: prompt }],
      },
      timeoutMs,
      `opencode messages (${model})`
    );
  }
  return fetchCompletion(
    OPENCODE_CHAT_URL,
    { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: opts.maxTokens ?? 8000,
    },
    timeoutMs,
    `opencode chat (${model})`
  );
}

function extractOpencodeRunText(events) {
  let text = "";
  for (const ev of events) {
    if (typeof ev === "string") {
      text += ev;
      continue;
    }
    if (ev?.type === "text" && typeof ev.text === "string") text += ev.text;
    if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block?.type === "text" && typeof block.text === "string") text += block.text;
      }
    }
    if (ev?.type === "result" && typeof ev.result === "string" && !text) text = ev.result;
  }
  return text.trim();
}

export async function callOpencodeAgent(prompt, timeoutMs, opts = {}) {
  const modelId = toOpencodeModelId(opts.model ?? "deepseek-v4-flash");
  const providerModel = modelId.includes("/") ? modelId : `opencode-go/${modelId}`;
  const args = [
    "run",
    prompt,
    "--format",
    "json",
    "--model",
    providerModel,
    "--dangerously-skip-permissions",
  ];
  if (opts.cwd) args.push("--dir", opts.cwd);

  return new Promise((resolve, reject) => {
    const proc = spawn("opencode", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd ?? process.cwd(),
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`opencode agent timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const rl = createInterface({ input: proc.stdout });
    const errBufs = [];
    const events = [];
    proc.stderr.on("data", (d) => errBufs.push(d));
    rl.on("line", (line) => {
      const raw = line.trim();
      if (!raw) return;
      try {
        events.push(JSON.parse(raw));
      } catch {
        events.push(raw);
      }
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const text = extractOpencodeRunText(events);
      if ((code === 0 || text) && text) resolve(text);
      else {
        const errMsg = Buffer.concat(errBufs).toString().trim();
        reject(
          new Error(`opencode agent exited ${code}${errMsg ? ": " + errMsg.slice(0, 400) : ""}`)
        );
      }
    });
  });
}

/** Fail loud when the resolved prompt model's provider env is missing. */
export function requirePromptModelKey(model, step) {
  const ref = parseModelRef(model);
  const label = step ? `${step} (${model})` : model;
  if (ref.provider === "deepseek" && !process.env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error(`DEEPSEEK_API_KEY is not set — required for ${label}`);
  }
  if (ref.provider === "openrouter" && !process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error(`OPENROUTER_API_KEY is not set — required for ${label}`);
  }
  if (
    ref.provider === "opencode" &&
    !process.env.OPENCODE_API_KEY?.trim() &&
    !process.env.OPENCODE_GO_API_KEY?.trim()
  ) {
    throw new Error(`OPENCODE_API_KEY (or OPENCODE_GO_API_KEY) is not set — required for ${label}`);
  }
}

/** Route a single-shot model call by resolved provider. */
export async function callPromptModel({ model, prompt, timeoutMs, opts = {} }) {
  const ref = parseModelRef(model);
  switch (ref.provider) {
    case "deepseek":
      return callDeepSeekDirect(prompt, timeoutMs, { model: ref.modelId, ...opts });
    case "openrouter":
      return callOpenRouter(prompt, timeoutMs, { model: ref.modelId, ...opts });
    case "opencode":
      return callOpencodeApi(prompt, timeoutMs, { model: ref.modelId, ...opts });
    case "cursor":
      return callCursorAgent(prompt, timeoutMs, {
        ...opts,
        extraArgs: [...(opts.extraArgs ?? []), ...(ref.modelId ? ["--model", ref.modelId] : [])],
      });
    case "claude":
      return callClaudeAgent(prompt, timeoutMs, {
        ...opts,
        model: ref.modelId,
        extraArgs: [...(opts.extraArgs ?? []), ...NO_TOOLS_ARGS],
      });
    default:
      throw new Error(
        `unsupported prompt model '${model}' (provider '${ref.provider}') — use openrouter:, opencode:, deepseek:, claude:, or cursor:`
      );
  }
}

/** Route a tool-capable agent call (build/plan/fix). */
export async function callAgentModel({ model, prompt, timeoutMs, opts = {} }) {
  const ref = parseModelRef(model);
  if (!isAgenticProvider(ref.provider)) {
    throw new Error(
      `Model '${model}' resolves to prompt-only provider '${ref.provider}'. ` +
        `Agentic steps need claude:, cursor:, or opencode: — e.g. opencode:glm-5.2 or claude:claude-sonnet-5`
    );
  }
  switch (ref.provider) {
    case "claude":
      return callClaudeAgent(prompt, timeoutMs, { ...opts, model: ref.modelId });
    case "cursor":
      return callCursorAgent(prompt, timeoutMs, {
        ...opts,
        extraArgs: [...(opts.extraArgs ?? []), ...(ref.modelId ? ["--model", ref.modelId] : [])],
      });
    case "opencode":
      return callOpencodeAgent(prompt, timeoutMs, { ...opts, model: ref.modelId, cwd: opts.cwd });
    default:
      throw new Error(`unsupported agent model '${model}'`);
  }
}

/** Back-compat shim used by ship/build/review-bugbot. */
export function reviewCallForModel(model) {
  return (prompt, timeoutMs, opts = {}) => callPromptModel({ model, prompt, timeoutMs, opts });
}
