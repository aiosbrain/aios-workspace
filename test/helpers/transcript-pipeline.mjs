import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(TEST_ROOT);
const FIXTURE = path.join(TEST_ROOT, "fixtures", "transcripts", "granola-aio370.md");
export const TRANSCRIPT_REL = "1-inbox/transcripts/granola-aio370.md";
export const NOW = "2026-07-22T03:04:05.000Z";

export const decisionHeader =
  "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n" +
  "|---|---|---|---|---|---|---|---|\n";
export const taskHeader =
  "| ID | Task | Assignee | Status | Sprint | Due | Linear |\n" + "|---|---|---|---|---|---|---|\n";

export const decisions = [
  {
    id: "decision-beta-cohort",
    date: "2026-07-21",
    decision: "Limit the beta to existing customers",
    rationale: "Keep the cohort controlled",
    decidedBy: "Mina Okafor",
    impact: "Beta rollout",
    type: 2,
    audience: "team",
    transcript: TRANSCRIPT_REL,
    sourceQuote: "“We decided to keep the beta limited to existing customers.”",
  },
  {
    id: "decision-august-price",
    date: "2026-07-21",
    decision: "Keep the €49 price through the August launch",
    rationale: "No launch-week discount",
    decidedBy: "Priya Shah",
    impact: "Launch pricing",
    type: 2,
    audience: "team",
    transcript: TRANSCRIPT_REL,
    sourceQuote:
      "“We decided to keep the current €49 price through the August launch — no launch-week\ndiscount.”",
  },
  {
    id: "decision-paused-ui",
    date: "2026-07-21",
    decision: "Pause the animated dashboard UI pending the accessibility audit",
    rationale: "Accessibility review first",
    decidedBy: "Mina Okafor",
    impact: "Dashboard launch",
    type: 1,
    audience: "team",
    transcript: TRANSCRIPT_REL,
    sourceQuote:
      "“We decided to pause the animated dashboard\nUI until the accessibility audit is complete.”",
  },
];

export const duplicateDecision = {
  ...decisions[0],
  id: "decision-beta-cohort-restated",
  decision: "Use only the existing-customer cohort for the beta",
  decidedBy: "Leo Martins",
  sourceQuote:
    "To state the same decision another way, the existing-customer cohort is\nthe only cohort in the beta.",
};

export const tasks = [
  {
    id: "task-audit-brief",
    task: "Send the accessibility audit brief to Mina",
    assignee: "Priya Shah",
    status: "Todo",
    sprint: "Launch",
    due: "2026-07-24",
    linear: "—",
    transcript: TRANSCRIPT_REL,
    sourceQuote: "“I will send the accessibility audit brief to Mina by Friday.”",
  },
];

export const hallucinatedTask = {
  ...tasks[0],
  id: "task-hallucinated-database",
  task: "Migrate the analytics database",
  assignee: "Leo Martins",
  sourceQuote: "Leo committed to migrate the analytics database.",
};

export function criterion(id, outcome = "pass", candidateIds = []) {
  return {
    id,
    classification: id === "TD5" ? "advisory" : "must",
    outcome,
    findings: outcome === "pass" ? [] : [`${id} synthetic finding`],
    candidateIds,
    transcriptPaths: [TRANSCRIPT_REL],
    evidence: outcome === "pass" ? ["synthetic evidence"] : [],
  };
}

export function gradeReport({ verdict = "pass", failures = {}, certifiedNoChanges = false } = {}) {
  return {
    verdict,
    certifiedNoChanges,
    criteria: ["TD1", "TD2", "TD3", "TD4", "TD5", "TD6"].map((id) =>
      criterion(id, failures[id] ? "fail" : "pass", failures[id] ?? [])
    ),
  };
}

export function verificationReport({ verdict = "pass", failures = {} } = {}) {
  return {
    verdict,
    criteria: ["TD1", "TD2", "TD3", "TD4", "TD5"].map((id) =>
      criterion(id, failures[id] ? "fail" : "pass", failures[id] ?? [])
    ),
  };
}

export function passingPhaseRunner({ seen = [], includeDuplicate = false } = {}) {
  return async (request) => {
    seen.push(request);
    if (request.phase === "extract") {
      return { decisions: includeDuplicate ? [...decisions, duplicateDecision] : decisions, tasks };
    }
    if (request.phase === "deduplicate") return { decisions, tasks };
    if (request.phase === "verify") return verificationReport();
    if (request.phase === "grade") return gradeReport();
    assert.fail(`unexpected phase: ${request.phase}`);
  };
}

export function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "aio370-contract-"));
  mkdirSync(path.join(root, "1-inbox", "transcripts"), { recursive: true });
  mkdirSync(path.join(root, "3-log"), { recursive: true });
  copyFileSync(FIXTURE, path.join(root, TRANSCRIPT_REL));
  writeFileSync(path.join(root, "3-log", "decision-log.md"), decisionHeader);
  writeFileSync(path.join(root, "3-log", "tasks-team.md"), taskHeader);
  return root;
}

export function stageFiles(root) {
  const dir = path.join(root, ".aios", "staging", "transcript-decisions");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(dir, name))
        .sort()
    : [];
}

export function readStage(stagePath) {
  return JSON.parse(readFileSync(stagePath, "utf8"));
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function writeV1Stage(root) {
  const dir = path.join(root, ".aios", "staging", "transcript-decisions");
  mkdirSync(dir, { recursive: true });
  const stagePath = path.join(dir, "legacy-v1.json");
  writeFileSync(
    stagePath,
    JSON.stringify({
      version: 1,
      access: "admin",
      status: "pending_review",
      createdAt: NOW,
      transcripts: [TRANSCRIPT_REL],
      decisions: decisions.slice(0, 2),
      tasks,
    }) + "\n"
  );
  return stagePath;
}

export function writeExtraction(root) {
  const rel = "extraction-aio370.json";
  writeFileSync(path.join(root, rel), JSON.stringify({ decisions, tasks }));
  return rel;
}

export function workspaceLogs(root) {
  return {
    decisions: readFileSync(path.join(root, "3-log", "decision-log.md"), "utf8"),
    tasks: readFileSync(path.join(root, "3-log", "tasks-team.md"), "utf8"),
  };
}

export async function runTranscriptCli(root, args, deps = {}) {
  const { cmdTranscripts } = await import(
    pathToFileURL(path.join(REPO_ROOT, "scripts", "transcripts.mjs")).href
  );
  const stdout = [];
  const stderr = [];
  const priorLog = console.log;
  console.log = (...values) => stdout.push(values.join(" "));
  try {
    const code = await cmdTranscripts(root, {}, args, {
      now: () => NOW,
      stdout: (value) => stdout.push(String(value)),
      stderr: (value) => stderr.push(String(value)),
      ...deps,
    });
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), error: null };
  } catch (error) {
    return { code: undefined, stdout: stdout.join("\n"), stderr: stderr.join("\n"), error };
  } finally {
    console.log = priorLog;
  }
}

export async function loadMeetings() {
  const dist = path.join(REPO_ROOT, "dist", "operator-loop", "meetings", "index.js");
  if (existsSync(dist)) return import(pathToFileURL(dist).href);
  const legacy = await import(
    pathToFileURL(path.join(REPO_ROOT, "scripts", "transcripts.mjs")).href
  );
  return {
    ...legacy,
    draftTranscriptReview: async (options) => {
      const result = await legacy.draftTranscriptReview({
        repo: options.root,
        transcriptPaths: options.transcriptPaths,
        extraction: { decisions, tasks },
        now: typeof options.now === "function" ? options.now() : options.now,
      });
      return { ...result, outcome: "legacy", stagePath: result.file };
    },
  };
}

function assertStringArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(
    value.every((item) => typeof item === "string"),
    `${label} must contain strings`
  );
}

export function assertGradeReportShape(report, expectedVerdict) {
  assert.ok(report && typeof report === "object");
  assert.ok(["pass", "fail", "error"].includes(report.verdict));
  if (expectedVerdict) assert.equal(report.verdict, expectedVerdict);
  assert.deepEqual(
    report.criteria.map(({ id }) => id),
    ["TD1", "TD2", "TD3", "TD4", "TD5", "TD6"]
  );
  for (const criterionReport of report.criteria) {
    assert.equal(
      criterionReport.classification,
      criterionReport.id === "TD5" ? "advisory" : "must"
    );
    assert.ok(["pass", "fail", "error"].includes(criterionReport.outcome));
    assertStringArray(criterionReport.findings, `${criterionReport.id}.findings`);
    assertStringArray(criterionReport.candidateIds, `${criterionReport.id}.candidateIds`);
    assertStringArray(criterionReport.transcriptPaths, `${criterionReport.id}.transcriptPaths`);
    assertStringArray(criterionReport.evidence, `${criterionReport.id}.evidence`);
  }
}

function immutableReviewPayload(stage) {
  return {
    id: stage.id,
    createdAt: stage.createdAt,
    access: stage.access,
    decisions: stage.decisions,
    tasks: stage.tasks,
    transcripts: stage.transcripts,
    rubricBudget: stage.rubricBudget,
    loopsUsed: stage.loopsUsed,
    loops: stage.loops,
    gradeReport: stage.gradeReport,
    diagnostics: stage.diagnostics,
    reviewDigest: stage.reviewDigest,
  };
}

export function assertReviewShape(stage, status, { approvedFrom } = {}) {
  assert.equal(stage.version, 2);
  assert.equal(stage.access, "admin");
  assert.equal(stage.status, status);
  assert.equal(typeof stage.id, "string");
  assert.match(stage.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(stage.reviewDigest, /^[a-f\d]{64}$/);
  assert.ok(Array.isArray(stage.decisions));
  assert.ok(Array.isArray(stage.tasks));
  for (const decision of stage.decisions) {
    for (const field of [
      "id",
      "date",
      "decision",
      "rationale",
      "decidedBy",
      "impact",
      "audience",
      "transcript",
      "sourceQuote",
    ]) {
      assert.equal(typeof decision[field], "string", `decision.${field}`);
    }
    assert.equal(typeof decision.type, "number");
  }
  for (const task of stage.tasks) {
    for (const field of [
      "id",
      "task",
      "assignee",
      "status",
      "sprint",
      "due",
      "linear",
      "transcript",
      "sourceQuote",
    ]) {
      assert.equal(typeof task[field], "string", `task.${field}`);
    }
  }
  assert.ok(Array.isArray(stage.transcripts) && stage.transcripts.length > 0);
  assert.deepEqual(
    stage.transcripts.map(({ path: transcriptPath }) => transcriptPath),
    [TRANSCRIPT_REL]
  );
  const fixtureBytes = readFileSync(FIXTURE);
  for (const transcript of stage.transcripts) {
    assert.equal(typeof transcript.path, "string");
    assert.equal(transcript.sha256, sha256(fixtureBytes));
    assert.equal(transcript.bytes, fixtureBytes.byteLength);
    assert.equal(transcript.chars, fixtureBytes.toString("utf8").length);
  }
  assert.ok(Number.isInteger(stage.rubricBudget) && stage.rubricBudget >= 0);
  assert.ok(Array.isArray(stage.loops));
  assert.ok(Number.isInteger(stage.loopsUsed));
  assert.ok(stage.loopsUsed >= 0 && stage.loopsUsed <= stage.rubricBudget);
  for (const [index, loop] of stage.loops.entries()) {
    assert.ok(loop && typeof loop === "object", `loops[${index}]`);
    const counts = loop.candidateCounts ?? loop.counts;
    assert.ok(counts && typeof counts === "object", `loops[${index}].candidateCounts`);
    assert.ok(Number.isInteger(counts.decisions) && counts.decisions >= 0);
    assert.ok(Number.isInteger(counts.tasks) && counts.tasks >= 0);
    assertGradeReportShape(loop.gradeReport ?? loop.report);
  }
  assertGradeReportShape(stage.gradeReport);
  assert.ok(Array.isArray(stage.diagnostics));
  for (const diagnostic of stage.diagnostics) {
    assert.ok(diagnostic && typeof diagnostic === "object");
    assert.equal(typeof diagnostic.message, "string");
    assert.doesNotMatch(JSON.stringify(diagnostic), /ignore every earlier decision/i);
  }
  assert.ok(stage.push && typeof stage.push === "object");
  assert.ok(
    ["not_requested", "skipped", "pending", "failed", "succeeded"].includes(stage.push.state)
  );
  assert.ok(Array.isArray(stage.push.attempts));
  for (const attempt of stage.push.attempts) {
    assert.ok(attempt && typeof attempt === "object");
    assert.ok(["pending", "failed", "succeeded"].includes(attempt.state));
    assert.match(attempt.at ?? attempt.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    const attemptDiagnostics =
      attempt.diagnostics ?? (attempt.diagnostic === undefined ? [] : [attempt.diagnostic]);
    assert.ok(Array.isArray(attemptDiagnostics));
    assert.doesNotMatch(JSON.stringify(attemptDiagnostics), /ignore every earlier decision/i);
  }
  if (status === "approved") {
    assert.ok(stage.apply && typeof stage.apply === "object");
    assert.ok(Object.keys(stage.apply).length > 0);
    if (approvedFrom) {
      assert.deepEqual(immutableReviewPayload(stage), immutableReviewPayload(approvedFrom));
    }
  }
}
