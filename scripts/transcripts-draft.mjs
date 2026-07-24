import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { callPromptModel } from "./model-call.mjs";
import { loadTranscriptEngine, parseV2Stage, statusExit } from "./transcripts-engine.mjs";
import { createTranscriptPhaseRunner, loadPhaseFixture } from "./transcripts-phases.mjs";
import {
  argValue,
  nowProvider,
  rubricBudget,
  safeWorkspacePath,
  stageRelative,
} from "./transcripts-runtime.mjs";
import {
  extractionPrompt as extractionContractPrompt,
  parseModelJson,
  prepareExtractionStage,
} from "./transcript-extraction.mjs";

const EVIDENCE_LOGS = [
  "3-log/facts-private.md",
  "3-log/facts-team.md",
  "4-shared/facts.md",
  "3-log/stakeholder-mentions-private.md",
  "3-log/stakeholder-mentions-team.md",
  "4-shared/stakeholder-mentions.md",
];

function transcriptPaths(args) {
  return String(argValue(args, "--transcripts") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function stagedPayload(root, result, stage, evidence) {
  return {
    command: "draft",
    outcome: "staged",
    status: stage.status,
    stage: stageRelative(root, result.stagePath),
    decisions: stage.decisions.length,
    tasks: stage.tasks.length,
    facts: evidence.factsAttached,
    stakeholders: evidence.stakeholdersAttached,
  };
}

function noChangesPayload(result) {
  return {
    command: "draft",
    outcome: "no_changes",
    status: "no_changes",
    decisions: 0,
    tasks: 0,
    facts: 0,
    stakeholders: 0,
    loops: result.loops?.length ?? 0,
  };
}

function readTranscriptTexts(root, paths) {
  const texts = {};
  for (const rel of paths) {
    const file = safeWorkspacePath(root, rel, { mustExist: true });
    texts[rel] = readFileSync(file, "utf8");
  }
  return texts;
}

function existingEvidenceRowKeys(root) {
  const keys = new Set();
  for (const relative of EVIDENCE_LOGS) {
    const file = path.join(root, relative);
    if (!existsSync(file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(
      /^\|\s*((?:fact|stakeholder)-[a-f0-9]{16})\s*\|/gim
    )) {
      keys.add(match[1]);
    }
  }
  return keys;
}

// The 1.12 evidence kinds (facts, stakeholder mentions) are grounded deterministically from the same
// transcripts and attached to the just-drafted stage. Deterministic sources: an injected extraction
// (deps.evidenceExtraction) or a --from-json fixture carrying facts/stakeholders arrays. Live drafts
// (no injected runner/fixture) additionally extract evidence from the model. Fixture/runner-driven
// tests that provide no evidence attach nothing — decision/task drafts stay unchanged.
async function gatherRawEvidence({ paths, fixture, args, deps }) {
  if (deps.evidenceExtraction) return deps.evidenceExtraction;
  if (fixture && (Array.isArray(fixture.facts) || Array.isArray(fixture.stakeholders))) {
    return { facts: fixture.facts ?? [], stakeholders: fixture.stakeholders ?? [] };
  }
  if (fixture || deps.runPhase) return null;
  const raw = parseModelJson(
    await (deps.modelCall ?? callPromptModel)({
      model: argValue(args, "--model") ?? "deepseek:deepseek-chat",
      prompt: extractionContractPrompt(paths),
      timeoutMs: 180_000,
      opts: { maxTokens: 8000 },
    })
  );
  return { facts: raw.facts ?? [], stakeholders: raw.stakeholders ?? [] };
}

async function attachEvidence({ root, engine, stagePath, paths, fixture, args, deps, now }) {
  const empty = { factsAttached: 0, stakeholdersAttached: 0 };
  const rawEvidence = await gatherRawEvidence({ paths, fixture, args, deps });
  if (!rawEvidence) return empty;
  const grounded = prepareExtractionStage({
    extraction: {
      decisions: [],
      tasks: [],
      facts: rawEvidence.facts ?? [],
      stakeholders: rawEvidence.stakeholders ?? [],
    },
    transcriptTexts: readTranscriptTexts(root, paths),
    existingRowKeys: existingEvidenceRowKeys(root),
    now: now(),
  });
  if (grounded.facts.length === 0 && grounded.stakeholders.length === 0) return empty;
  const result = engine.attachTranscriptEvidence({
    root,
    stagePath,
    facts: grounded.facts,
    stakeholderMentions: grounded.stakeholders,
    now,
  });
  return {
    factsAttached: result.factsAttached,
    stakeholdersAttached: result.stakeholdersAttached,
  };
}

export async function runDraftCommand(root, args, deps) {
  const paths = transcriptPaths(args);
  if (!paths.length) throw new Error("pass at least one transcript with --transcripts");
  const fixture = loadPhaseFixture(root, argValue(args, "--from-json"));
  const runPhase =
    deps.runPhase ??
    createTranscriptPhaseRunner({
      fixture,
      model: argValue(args, "--model") ?? "deepseek:deepseek-chat",
      modelCall: deps.modelCall,
    });
  const engine = await loadTranscriptEngine(deps);
  const now = nowProvider(deps);
  const result = await engine.draftTranscriptReview({
    root,
    transcriptPaths: paths,
    rubricBudget: rubricBudget(args),
    runPhase,
    now,
  });
  if (result.outcome === "no_changes") {
    const payload = noChangesPayload(result);
    return { code: 0, payload, text: "draft no_changes: 0 decisions + 0 tasks + 0 facts + 0 stakeholders" };
  }
  const evidence = await attachEvidence({
    root,
    engine,
    stagePath: result.stagePath,
    paths,
    fixture,
    args,
    deps,
    now,
  });
  const stage = parseV2Stage(engine, readStageAfterEvidence(root, result, engine));
  const payload = stagedPayload(root, result, stage, evidence);
  return {
    code: statusExit(stage.status),
    payload,
    text: `draft ${stage.status}: ${payload.decisions} decisions + ${payload.tasks} tasks + ${payload.facts} facts + ${payload.stakeholders} stakeholders — ${payload.stage}`,
  };
}

// Re-read the stage from disk after evidence attach so the reported counts reflect the persisted
// stage (evidence is written by attachTranscriptEvidence, not present on the in-memory draft result).
function readStageAfterEvidence(root, result, _engine) {
  return readFileSync(result.stagePath, "utf8");
}
