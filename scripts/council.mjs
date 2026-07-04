#!/usr/bin/env node
// council.mjs — `aios council "<question>"` (AIO-225, P0 prototype).
//
// Scope is deliberately P0 only (docs/prd-council-harness.md §7): fan a question out to the
// configured panel in parallel over OpenRouter, print each model's raw first opinion, persist
// an inspectable JSON transcript. No stage-2 anonymized ranking, no stage-3 chairman synthesis
// yet — those are P1.
//
// Usage: node scripts/council.mjs "<question>" [--models id,id,id] [--repo <path>]

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { c, die } from "./relay-core.mjs";
import { resolveCouncilConfig, assertDiverse, modelFamily } from "./council-models.mjs";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 120_000;

export function parseCouncilArgs(argv) {
  const rest = [...argv];
  let modelsOverride = null;
  const positional = [];
  while (rest.length) {
    const a = rest.shift();
    if (a === "--models") {
      const raw = rest.shift();
      if (raw === undefined) die('usage: aios council "<question>" [--models id,id,id]');
      modelsOverride = raw.split(",").map((s) => s.trim());
    } else positional.push(a);
  }
  return { question: positional.join(" "), modelsOverride };
}

async function askOneModel(model, question, apiKey) {
  const startedAt = Date.now();
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/aios-alpha",
        "X-Title": "aios council (P0 prototype)",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: question }],
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const durationMs = Date.now() - startedAt;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { model, ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}`, durationMs };
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? null;
    if (!text) return { model, ok: false, error: "no content in response", durationMs };
    return { model, ok: true, text, durationMs };
  } catch (err) {
    return {
      model,
      ok: false,
      error: String(err?.message ?? err),
      durationMs: Date.now() - startedAt,
    };
  }
}

// `repo` + `rest` let aios.mjs's `cmdCouncil` call this directly (repo-aware, like cmdAsks);
// direct `node scripts/council.mjs` invocation below passes repo=cwd + the raw argv tail.
export async function runCouncil(repo, rest) {
  const { question, modelsOverride } = parseCouncilArgs(rest);
  if (!question.trim()) die('usage: aios council "<question>" [--models id,id,id]');

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) die("OPENROUTER_API_KEY is not set — council needs it to reach OpenRouter");

  const { models: configured } = resolveCouncilConfig(repo, { modelsOverride });
  const models = assertDiverse(configured);

  console.error(
    c.yellow("⚠ aios council — third-party egress") +
      c.dim("  your question is sent to OpenRouter and each configured model provider")
  );

  console.log(c.blue("aios council") + c.dim(`  ${models.length} models · P0 (stage 1 only)`));
  for (const m of models) console.log(c.dim(`  · ${m}  [${modelFamily(m)}]`));
  console.log("");

  const results = await Promise.all(models.map((m) => askOneModel(m, question, apiKey)));

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  for (const r of results) {
    console.log(c.blue(`── ${r.model} `) + c.dim(`(${r.durationMs}ms)`));
    if (r.ok) console.log(r.text);
    else console.log(c.dim(`  [failed: ${r.error}]`));
    console.log("");
  }
  if (failed.length) {
    console.log(
      c.dim(`  ${failed.length}/${models.length} model(s) failed — proceeding with the rest.`)
    );
  }
  if (!succeeded.length) die("all council models failed — nothing to synthesize");

  const dir = path.join(repo, ".aios", "loop", "council");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(dir, `${stamp}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        question,
        models,
        stage1: results,
        createdAt: new Date().toISOString(),
        phase: "P0 — stage 1 only, no ranking/synthesis yet",
      },
      null,
      2
    )
  );
  console.log(c.dim(`  transcript: ${outPath}`));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runCouncil(process.cwd(), process.argv.slice(2));
