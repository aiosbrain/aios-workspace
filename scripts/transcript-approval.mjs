import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  factCandidateToMarkdownRow,
  stakeholderCandidateToMarkdownRow,
} from "./transcript-adapters.mjs";

export const TRANSCRIPT_STAGING_REL = ".aios/staging/transcript-decisions";

const FILES = {
  fact: {
    admin: "3-log/facts-private.md",
    team: "3-log/facts-team.md",
    external: "4-shared/facts.md",
  },
  stakeholder_mention: {
    admin: "3-log/stakeholder-mentions-private.md",
    team: "3-log/stakeholder-mentions-team.md",
    external: "4-shared/stakeholder-mentions.md",
  },
};

const HEADERS = {
  fact:
    "| Row Key | Fact | Occurred At | Type | Source Path | Source Quote |\n" +
    "|---|---|---|---|---|---|\n",
  stakeholder_mention:
    "| Row Key | Name | Role | Context | Source Path | Source Quote |\n" +
    "|---|---|---|---|---|---|\n",
};

function safeWorkspacePath(repo, value) {
  const resolved = path.resolve(repo, value);
  if (resolved !== repo && !resolved.startsWith(repo + path.sep)) {
    throw new Error(`path escapes workspace: ${value}`);
  }
  return resolved;
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function escapeCell(value) {
  return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ").trim() || "—";
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

function nextNumber(markdown, pattern) {
  return Math.max(0, ...[...markdown.matchAll(pattern)].map((match) => Number(match[1]))) + 1;
}

function ensureLog(repo, relativePath, initial) {
  const file = path.join(repo, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, initial);
  return file;
}

function evidenceInitial(kind, access) {
  return `---\nkind: ${kind}\naccess: ${access}\n---\n\n${HEADERS[kind]}`;
}

function existingEvidenceKeys(repo) {
  const keys = new Set();
  for (const paths of Object.values(FILES)) {
    for (const relativePath of Object.values(paths)) {
      const file = path.join(repo, relativePath);
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const match = line.match(/^\|\s*((?:fact|stakeholder)-[a-f0-9]{16})\s*\|/);
        if (match) keys.add(match[1]);
      }
    }
  }
  return keys;
}

function appendEvidence(repo, kind, access, row) {
  const relativePath = FILES[kind][access];
  const file = ensureLog(repo, relativePath, evidenceInitial(kind, access));
  const values =
    kind === "fact"
      ? [row.row_key, row.title, row.occurred_at, row.fact_type, row.source_path, row.source_quote]
      : [row.row_key, row.name, row.role, row.context, row.source_path, row.source_quote];
  writeFileSync(file, readFileSync(file, "utf8") + `| ${values.map(escapeCell).join(" | ")} |\n`);
}

function applyEvidence(stage, repo, kind, candidates, knownKeys) {
  let count = 0;
  for (const candidate of candidates ?? []) {
    const access = candidate.access;
    if (!["admin", "team", "external"].includes(access)) {
      throw new Error(`${kind} ${candidate.rowKey ?? ""} has invalid access: ${access}`);
    }
    const row =
      kind === "fact"
        ? factCandidateToMarkdownRow(candidate)
        : stakeholderCandidateToMarkdownRow(candidate);
    if (!row.row_key || knownKeys.has(row.row_key)) continue;
    appendEvidence(repo, kind, access, row);
    knownKeys.add(row.row_key);
    count++;
  }
  return count;
}

export function approveTranscriptStageFile({ repo, stageFile, approvedAt }) {
  const stagingRoot = path.join(repo, TRANSCRIPT_STAGING_REL);
  const file = safeWorkspacePath(repo, stageFile);
  if (file !== stagingRoot && !file.startsWith(stagingRoot + path.sep)) {
    throw new Error(`stage file must be inside ${TRANSCRIPT_STAGING_REL}`);
  }
  const stage = JSON.parse(readFileSync(file, "utf8"));
  const version = stage.version ?? 1;
  const empty = version === 1
    ? { decisions: 0, tasks: 0, alreadyApproved: true }
    : { decisions: 0, tasks: 0, facts: 0, stakeholders: 0, alreadyApproved: true };
  if (stage.status === "approved") return empty;
  if (stage.status !== "pending_review") {
    throw new Error(`stage is not pending_review: ${stage.status}`);
  }

  const decisionPath = ensureLog(
    repo,
    "3-log/decision-log.md",
    "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n|---|---|---|---|---|---|---|---|\n"
  );
  const taskPath = ensureLog(
    repo,
    "3-log/tasks-team.md",
    "| ID | Task | Assignee | Status | Sprint | Due | Linear |\n|---|---|---|---|---|---|---|\n"
  );
  let decisionsMarkdown = readFileSync(decisionPath, "utf8");
  let tasksMarkdown = readFileSync(taskPath, "utf8");
  const knownDecisions = existingDecisionTexts(decisionsMarkdown);
  const knownTasks = existingTaskTexts(tasksMarkdown);
  let decisionNo = nextNumber(decisionsMarkdown, /^\|\s*(\d+)\s*\|/gm);
  let taskNo = nextNumber(tasksMarkdown, /^\|\s*TT(\d+)\s*\|/gim);
  let decisions = 0;
  let tasks = 0;

  for (const item of stage.decisions ?? []) {
    const key = normalize(item.decision);
    if (!key || knownDecisions.has(key)) continue;
    decisionsMarkdown += `| ${decisionNo++} | ${[
      item.date, item.decision, item.rationale, item.decidedBy, item.impact, item.type, item.audience,
    ].map(escapeCell).join(" | ")} |\n`;
    knownDecisions.add(key);
    decisions++;
  }
  for (const item of stage.tasks ?? []) {
    const key = normalize(item.task);
    if (!key || knownTasks.has(key)) continue;
    tasksMarkdown += `| TT${taskNo++} | ${[
      item.task, item.assignee, item.status, item.sprint, item.due, "—",
    ].map(escapeCell).join(" | ")} |\n`;
    knownTasks.add(key);
    tasks++;
  }
  if (decisions) writeFileSync(decisionPath, decisionsMarkdown);
  if (tasks) writeFileSync(taskPath, tasksMarkdown);

  const knownKeys = existingEvidenceKeys(repo);
  const facts = version >= 2
    ? applyEvidence(stage, repo, "fact", stage.facts, knownKeys)
    : 0;
  const stakeholders = version >= 2
    ? applyEvidence(stage, repo, "stakeholder_mention", stage.stakeholders, knownKeys)
    : 0;
  stage.status = "approved";
  stage.approvedAt = approvedAt ?? new Date().toISOString();
  stage.applied = version === 1
    ? { decisions, tasks }
    : { decisions, tasks, facts, stakeholders };
  writeFileSync(file, JSON.stringify(stage, null, 2) + "\n", { mode: 0o600 });

  return version === 1
    ? { decisions, tasks, alreadyApproved: false }
    : { decisions, tasks, facts, stakeholders, alreadyApproved: false };
}
