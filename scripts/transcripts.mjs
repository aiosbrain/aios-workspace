import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callPromptModel } from "./model-call.mjs";
import {
  extractionPrompt as extractionContractPrompt,
  parseModelJson,
  prepareExtractionStage,
} from "./transcript-extraction.mjs";
import {
  approveTranscriptStageFile,
  TRANSCRIPT_STAGING_REL,
} from "./transcript-approval.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STAGING_REL = TRANSCRIPT_STAGING_REL;

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function safeWorkspacePath(repo, value) {
  const resolved = path.resolve(repo, value);
  if (resolved !== repo && !resolved.startsWith(repo + path.sep)) {
    throw new Error(`path escapes workspace: ${value}`);
  }
  return resolved;
}

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function existingDecisionTexts(markdown) {
  return new Set(
    markdown
      .split("\n")
      .filter((line) => /^\|\s*\d+\s*\|/.test(line))
      .map((line) => normalize(line.split("|")[3]))
      .filter(Boolean)
  );
}

function existingTaskTexts(markdown) {
  return new Set(
    markdown
      .split("\n")
      .filter((line) => /^\|\s*TT\d+\s*\|/i.test(line))
      .map((line) => normalize(line.split("|")[2]))
      .filter(Boolean)
  );
}

function existingEvidenceRowKeys(markdowns) {
  const keys = new Set();
  for (const markdown of markdowns) {
    for (const match of markdown.matchAll(
      /^\|\s*((?:fact|stakeholder)-[a-f0-9]{16})\s*\|/gim
    )) {
      keys.add(match[1]);
    }
  }
  return keys;
}

export function prepareStage({
  extraction,
  transcriptTexts,
  decisionLog = "",
  tasksLog = "",
  evidenceLogs = [],
  now,
}) {
  const knownDecisions = existingDecisionTexts(decisionLog);
  const knownTasks = existingTaskTexts(tasksLog);
  const stage = prepareExtractionStage({
    extraction,
    transcriptTexts,
    existingDecisionTexts: knownDecisions,
    existingTaskTexts: knownTasks,
    existingRowKeys: existingEvidenceRowKeys(evidenceLogs),
    now,
  });
  return { ...stage, transcripts: Object.keys(transcriptTexts) };
}

function extractionPrompt(transcriptTexts, decisionLog, tasksLog) {
  return `${extractionContractPrompt(Object.keys(transcriptTexts))}
Exclude decisions and tasks already present in the logs.

EXISTING DECISION LOG:
${decisionLog}

EXISTING TEAM TASKS:
${tasksLog}

TRANSCRIPTS:
${Object.entries(transcriptTexts)
  .map(([name, body]) => `\n--- ${name} ---\n${body}`)
  .join("\n")}`;
}

export async function draftTranscriptReview({
  repo,
  transcriptPaths,
  model = "deepseek:deepseek-chat",
  modelCall = callPromptModel,
  extraction,
  now = new Date().toISOString(),
}) {
  if (!transcriptPaths.length) throw new Error("pass at least one transcript with --transcripts");
  const transcriptTexts = {};
  for (const rel of transcriptPaths) {
    const file = safeWorkspacePath(repo, rel);
    if (!existsSync(file)) throw new Error(`transcript not found: ${rel}`);
    transcriptTexts[rel] = readFileSync(file, "utf8");
  }
  const decisionPath = path.join(repo, "3-log", "decision-log.md");
  const tasksPath = path.join(repo, "3-log", "tasks-team.md");
  const decisionLog = existsSync(decisionPath) ? readFileSync(decisionPath, "utf8") : "";
  const tasksLog = existsSync(tasksPath) ? readFileSync(tasksPath, "utf8") : "";
  const evidenceLogs = [
    "3-log/facts-private.md",
    "3-log/facts-team.md",
    "4-shared/facts.md",
    "3-log/stakeholder-mentions-private.md",
    "3-log/stakeholder-mentions-team.md",
    "4-shared/stakeholder-mentions.md",
  ]
    .map((relativePath) => path.join(repo, relativePath))
    .filter(existsSync)
    .map((file) => readFileSync(file, "utf8"));
  const raw =
    extraction ??
    parseModelJson(
      await modelCall({
        model,
        prompt: extractionPrompt(transcriptTexts, decisionLog, tasksLog),
        timeoutMs: 180_000,
        opts: { maxTokens: 8000 },
      })
    );
  const stage = prepareStage({
    extraction: raw,
    transcriptTexts,
    decisionLog,
    tasksLog,
    evidenceLogs,
    now,
  });
  const dir = path.join(repo, STAGING_REL);
  mkdirSync(dir, { recursive: true });
  const stamp = now.replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}.json`);
  writeFileSync(file, JSON.stringify(stage, null, 2) + "\n", { mode: 0o600 });
  return { file, stage };
}

export function approveTranscriptStage({ repo, stageFile }) {
  return approveTranscriptStageFile({ repo, stageFile });
}

export function enableTranscriptSync(repo) {
  const file = path.join(repo, "aios.yaml");
  const yaml = readFileSync(file, "utf8");
  if (/^\s*-\s+1-inbox\/transcripts\s*$/m.test(yaml)) return false;
  const marker = /^sync_exclude:/m;
  if (!marker.test(yaml)) throw new Error("aios.yaml has no sync_exclude section");
  writeFileSync(file, yaml.replace(marker, "  - 1-inbox/transcripts\nsync_exclude:"));
  return true;
}

export async function cmdTranscripts(repo, _cfg, args) {
  const sub = args[0];
  const json = args.includes("--json");
  if (sub === "enable-sync") {
    const changed = enableTranscriptSync(repo);
    const out = { changed, path: "1-inbox/transcripts" };
    console.log(
      json
        ? JSON.stringify(out)
        : changed
          ? "enabled transcript sync"
          : "transcript sync already enabled"
    );
    return;
  }
  if (sub === "draft") {
    const values = String(argValue(args, "--transcripts") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const fixture = argValue(args, "--from-json");
    const extraction = fixture
      ? JSON.parse(readFileSync(safeWorkspacePath(repo, fixture), "utf8"))
      : undefined;
    const result = await draftTranscriptReview({
      repo,
      transcriptPaths: values,
      model: argValue(args, "--model") ?? undefined,
      extraction,
    });
    const out = {
      stage: path.relative(repo, result.file),
      decisions: result.stage.decisions.length,
      tasks: result.stage.tasks.length,
      facts: result.stage.facts.length,
      stakeholders: result.stage.stakeholders.length,
      rejected: result.stage.rejected.length,
      status: result.stage.status,
    };
    console.log(
      json
        ? JSON.stringify(out)
        : `${out.decisions} decisions + ${out.tasks} tasks + ${out.facts} facts + ${out.stakeholders} stakeholders pending review (${out.rejected} rejected) — ${out.stage}`
    );
    return;
  }
  if (sub === "list") {
    const dir = path.join(repo, STAGING_REL);
    const files = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .sort()
      : [];
    const stages = files.map((name) => {
      const stage = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      return {
        file: path.join(STAGING_REL, name),
        status: stage.status,
        decisions: stage.decisions?.length ?? 0,
        tasks: stage.tasks?.length ?? 0,
        facts: stage.facts?.length ?? 0,
        stakeholders: stage.stakeholders?.length ?? 0,
      };
    });
    console.log(
      json
        ? JSON.stringify({ stages })
        : stages
            .map((s) => `${s.status}  ${s.decisions} decisions + ${s.tasks} tasks + ${s.facts} facts + ${s.stakeholders} stakeholders  ${s.file}`)
            .join("\n")
    );
    return;
  }
  if (sub === "approve") {
    if (!args[1] || args[1].startsWith("--"))
      throw new Error("usage: aios transcripts approve <stage-file> [--no-push]");
    const result = approveTranscriptStage({ repo, stageFile: args[1] });
    if (
      !args.includes("--no-push") &&
      (result.decisions || result.tasks || result.facts || result.stakeholders)
    ) {
      execFileSync(process.execPath, [path.join(SCRIPT_DIR, "aios.mjs"), "push", "--repo", repo], {
        stdio: "inherit",
      });
    }
    console.log(
      json
        ? JSON.stringify(result)
        : `approved ${result.decisions} decisions + ${result.tasks} tasks + ${result.facts ?? 0} facts + ${result.stakeholders ?? 0} stakeholders${args.includes("--no-push") ? " (push skipped)" : ""}`
    );
    return;
  }
  throw new Error(
    "usage: aios transcripts enable-sync | draft --transcripts <path,...> [--model <id>] | list | approve <stage-file> [--no-push]"
  );
}
