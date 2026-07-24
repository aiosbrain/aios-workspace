import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callPromptModel } from "../../scripts/model-call.mjs";
import {
  extractionPrompt,
  parseModelJson,
  prepareExtractionStage,
} from "../../scripts/transcript-extraction.mjs";
import {
  factCandidateToMarkdownRow,
  stakeholderCandidateToMarkdownRow,
} from "../../scripts/transcript-adapters.mjs";
import { validateItemPayload } from "../../scripts/workspace-parse.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = path.join(SCRIPT_DIR, "gold-v1.json");
const PLURALS = ["decisions", "tasks", "facts", "stakeholders"];

function normalized(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value) {
  return new Set(normalized(value).split(" ").filter(Boolean));
}

function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

function content(kind, candidate) {
  if (kind === "decisions") return candidate.decision;
  if (kind === "tasks") return candidate.task;
  if (kind === "facts") return candidate.title;
  return [candidate.name, candidate.role, candidate.context].filter(Boolean).join(" ");
}

function semanticMatch(kind, actual, expected) {
  if (actual.transcript !== expected.transcript) return false;
  if (kind === "facts" && actual.factType !== expected.factType) return false;
  if (kind === "stakeholders") return normalized(actual.name) === normalized(expected.name);
  return similarity(content(kind, actual), content(kind, expected)) >= 0.45;
}

function perKindScore(kind, actual, expected) {
  const used = new Set();
  let matches = 0;
  for (const candidate of actual) {
    const index = expected.findIndex(
      (gold, goldIndex) => !used.has(goldIndex) && semanticMatch(kind, candidate, gold)
    );
    if (index < 0) continue;
    used.add(index);
    matches++;
  }
  return {
    extracted: actual.length,
    expected: expected.length,
    matches,
    precision: actual.length ? matches / actual.length : expected.length ? 0 : 1,
    recall: expected.length ? matches / expected.length : 1,
  };
}

function grounding(extraction, transcripts) {
  const candidates = PLURALS.flatMap((kind) =>
    (extraction[kind] ?? []).map((candidate) => ({ kind, candidate }))
  );
  const grounded = candidates.filter(({ kind, candidate }) => {
    const quote = String(candidate.sourceQuote ?? "").trim();
    const source = transcripts[candidate.transcript];
    const stakeholderMatches =
      kind !== "stakeholders" ||
      normalized(quote).includes(normalized(candidate.name));
    return (
      quote &&
      typeof source === "string" &&
      source.includes(quote) &&
      stakeholderMatches
    );
  }).length;
  return {
    grounded,
    total: candidates.length,
    rate: candidates.length ? grounded / candidates.length : 1,
  };
}

export function scoreAcceptedExtraction(stage, corpus) {
  return Object.fromEntries(
    PLURALS.map((kind) => [kind, perKindScore(kind, stage[kind], corpus.gold[kind])])
  );
}

function adaptersConform(stage) {
  const base = {
    project: "eval",
    content_sha256: "a".repeat(64),
    actor: "eval",
    access: "team",
    frontmatter: {},
    body: "synthetic approved rows only",
  };
  const factValid = validateItemPayload({
    ...base,
    path: "3-log/facts-team.md",
    kind: "fact",
    rows: stage.facts.map(factCandidateToMarkdownRow),
  }).success;
  const stakeholderValid = validateItemPayload({
    ...base,
    path: "3-log/stakeholder-mentions-team.md",
    kind: "stakeholder_mention",
    rows: stage.stakeholders.map(stakeholderCandidateToMarkdownRow),
  }).success;
  return factValid && stakeholderValid;
}

function evaluate(extraction, corpus) {
  const stage = prepareExtractionStage({
    extraction,
    transcriptTexts: corpus.transcripts,
    now: "2026-07-24T00:00:00.000Z",
  });
  const scores = scoreAcceptedExtraction(stage, corpus);
  const thresholdsMet = PLURALS.every(
    (kind) => scores[kind].precision >= 0.8 && scores[kind].recall >= 0.8
  );
  return {
    grounding: grounding(extraction, corpus.transcripts),
    scores,
    rejected: stage.rejected,
    adaptersConform: adaptersConform(stage),
    thresholdsMet,
  };
}

export function runDeterministicEval(corpus) {
  const result = evaluate(corpus.fixedModelOutput, corpus);
  const reasons = result.rejected.map((item) => item.reason).sort();
  const expected = [...corpus.expectedRejectedReasons].sort();
  return {
    mode: "deterministic",
    corpusVersion: corpus.corpusVersion,
    ...result,
    pass:
      JSON.stringify(reasons) === JSON.stringify(expected) &&
      result.adaptersConform &&
      result.thresholdsMet,
  };
}

function livePrompt(corpus) {
  return `${extractionPrompt(Object.keys(corpus.transcripts))}

SYNTHETIC TRANSCRIPTS:
${Object.entries(corpus.transcripts)
  .map(([name, body]) => `--- ${name} ---\n${body}`)
  .join("\n\n")}`;
}

export async function runLiveEval(corpus, { model, modelCall = callPromptModel }) {
  const runs = [];
  for (let run = 1; run <= 3; run++) {
    try {
      const extraction = parseModelJson(
        await modelCall({
          model,
          prompt: livePrompt(corpus),
          timeoutMs: 180_000,
          opts: { maxTokens: 8000, temperature: 0 },
        })
      );
      runs.push({ run, ...evaluate(extraction, corpus) });
    } catch (error) {
      runs.push({
        run,
        error: error instanceof Error ? error.message : String(error),
        grounding: { grounded: 0, total: 0, rate: 0 },
        scores: {},
        rejected: [],
        adaptersConform: false,
        thresholdsMet: false,
      });
    }
  }
  const allGrounded = runs.every((result) => result.grounding.rate === 1);
  const passingRuns = runs.filter(
    (result) => result.thresholdsMet && result.adaptersConform
  ).length;
  return {
    mode: "live",
    corpusVersion: corpus.corpusVersion,
    model,
    runs,
    allGrounded,
    passingRuns,
    pass: allGrounded && passingRuns >= 2,
  };
}

export function loadCorpus(file = DEFAULT_CORPUS) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const corpus = loadCorpus(argValue(args, "--corpus"));
  const live = args.includes("--live");
  const result = live
    ? await runLiveEval(corpus, {
        model: argValue(args, "--model") ?? process.env.AIOS_TRANSCRIPT_MODEL ?? "deepseek:deepseek-chat",
      })
    : runDeterministicEval(corpus);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
