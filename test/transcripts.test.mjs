import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { draftTranscriptReview } from "../dist/operator-loop/meetings/index.js";
import { enableTranscriptSync } from "../scripts/transcripts-config.mjs";
import { cmdTranscripts } from "../scripts/transcripts.mjs";

const TRANSCRIPT = "1-inbox/transcripts/meeting.md";
const NOW = "2026-07-13T12:00:00.000Z";

function workspace() {
  const repo = mkdtempSync(path.join(tmpdir(), "transcript-pipeline-"));
  mkdirSync(path.join(repo, "1-inbox", "transcripts"), { recursive: true });
  mkdirSync(path.join(repo, "3-log"), { recursive: true });
  writeFileSync(
    path.join(repo, "aios.yaml"),
    "sync_include:\n  - 0-context\nsync_exclude:\n  - 5-personal\n"
  );
  writeFileSync(
    path.join(repo, "3-log", "decision-log.md"),
    "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n|---|---|---|---|---|---|---|---|\n"
  );
  writeFileSync(
    path.join(repo, "3-log", "tasks-team.md"),
    "| ID | Task | Assignee | Status | Sprint | Due | Linear |\n|---|---|---|---|---|---|---|\n"
  );
  writeFileSync(
    path.join(repo, "1-inbox", "transcripts", "meeting.md"),
    "John: We decided to ship on Friday. Chetan: I will prepare the release notes. " +
      "Launch is August 4. Sam Rivera owns the rollout. This note must stay private."
  );
  return repo;
}

const extraction = {
  decisions: [
    {
      id: "decision-ship-friday",
      date: "2026-07-13",
      decision: "Ship on Friday",
      rationale: "Ready",
      decidedBy: "John",
      impact: "Release",
      type: 2,
      audience: "team",
      transcript: TRANSCRIPT,
      sourceQuote: "We decided to ship on Friday.",
    },
    {
      id: "decision-invented",
      date: "2026-07-13",
      decision: "Invented decision",
      rationale: "Invented rationale",
      decidedBy: "Nobody",
      impact: "None",
      type: 2,
      audience: "team",
      transcript: TRANSCRIPT,
      sourceQuote: "This quote is absent",
    },
  ],
  tasks: [
    {
      id: "task-release-notes",
      task: "Prepare the release notes",
      assignee: "Chetan",
      status: "Todo",
      sprint: "Release",
      due: "2026-07-17",
      linear: "—",
      transcript: TRANSCRIPT,
      sourceQuote: "I will prepare the release notes.",
    },
  ],
};

function criterion(id) {
  return {
    id,
    classification: id === "TD5" ? "advisory" : "must",
    outcome: "pass",
    findings: [],
    candidateIds: [],
    transcriptPaths: [TRANSCRIPT],
    evidence: ["deterministic test evidence"],
  };
}

function phaseRunner() {
  return async ({ phase, input }) => {
    if (phase === "extract") return extraction;
    if (phase === "deduplicate") {
      return { decisions: input.decisions, tasks: input.tasks };
    }
    if (phase === "verify") {
      return {
        verdict: "pass",
        criteria: ["TD1", "TD2", "TD3", "TD4", "TD5"].map(criterion),
      };
    }
    if (phase === "grade") {
      return {
        verdict: "pass",
        certifiedNoChanges: false,
        criteria: ["TD1", "TD2", "TD3", "TD4", "TD5", "TD6"].map(criterion),
      };
    }
    const rejected = new Set(
      input.report.criteria
        .filter(({ outcome }) => outcome === "fail")
        .flatMap(({ candidateIds }) => candidateIds)
    );
    return {
      decisions: input.decisions.filter(({ id }) => !rejected.has(id)),
      tasks: input.tasks.filter(({ id }) => !rejected.has(id)),
    };
  };
}

async function draft(repo) {
  const result = await draftTranscriptReview({
    root: repo,
    transcriptPaths: [TRANSCRIPT],
    rubricBudget: 1,
    runPhase: phaseRunner(),
    now: NOW,
  });
  assert.equal(result.outcome, "staged");
  return result;
}

async function approveWithoutPush(repo, stagePath) {
  return cmdTranscripts(
    repo,
    {},
    ["approve", path.relative(repo, stagePath), "--no-push", "--json"],
    { stdout: () => {}, stderr: () => {}, now: () => NOW }
  );
}

test("draft persists only grounded decisions and tasks for one durable review", async () => {
  const repo = workspace();
  try {
    const { stagePath, stage } = await draft(repo);
    assert.equal(stage.status, "pending_review");
    assert.equal(stage.decisions.length, 1);
    assert.equal(stage.tasks.length, 1);
    assert.ok(
      realpathSync(stagePath).startsWith(path.join(realpathSync(repo), ".aios", "staging"))
    );
    assert.equal(JSON.parse(readFileSync(stagePath, "utf8")).access, "admin");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approve appends both logs once and is idempotent", async () => {
  const repo = workspace();
  try {
    const { stagePath } = await draft(repo);
    assert.equal(await approveWithoutPush(repo, stagePath), 0);
    const approved = JSON.parse(readFileSync(stagePath, "utf8"));
    assert.equal(approved.status, "approved");
    assert.equal(approved.apply.decisionsAdded, 1);
    assert.equal(approved.apply.tasksAdded, 1);
    assert.match(
      readFileSync(path.join(repo, "3-log", "decision-log.md"), "utf8"),
      /Ship on Friday/
    );
    assert.match(
      readFileSync(path.join(repo, "3-log", "tasks-team.md"), "utf8"),
      /TT1.*Prepare the release notes/
    );
    const logsAfterFirstApproval = {
      decisions: readFileSync(path.join(repo, "3-log", "decision-log.md"), "utf8"),
      tasks: readFileSync(path.join(repo, "3-log", "tasks-team.md"), "utf8"),
    };
    assert.equal(await approveWithoutPush(repo, stagePath), 0);
    assert.deepEqual(
      {
        decisions: readFileSync(path.join(repo, "3-log", "decision-log.md"), "utf8"),
        tasks: readFileSync(path.join(repo, "3-log", "tasks-team.md"), "utf8"),
      },
      logsAfterFirstApproval
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 1.12 evidence kinds (facts + stakeholder mentions) through the unified engine ──

const evidenceExtraction = {
  facts: [
    {
      title: "Launch is August 4",
      factType: "event",
      transcript: TRANSCRIPT,
      sourceQuote: "Launch is August 4.",
    },
    {
      title: "Ungrounded fact",
      factType: "fact",
      transcript: TRANSCRIPT,
      sourceQuote: "this quote does not appear anywhere",
    },
  ],
  stakeholders: [
    {
      name: "Sam Rivera",
      role: "Rollout owner",
      transcript: TRANSCRIPT,
      sourceQuote: "Sam Rivera owns the rollout.",
    },
  ],
};

async function draftWithEvidence(repo) {
  const out = [];
  const code = await cmdTranscripts(
    repo,
    {},
    ["draft", "--transcripts", TRANSCRIPT, "--json"],
    {
      runPhase: phaseRunner(),
      evidenceExtraction,
      now: () => NOW,
      stdout: (value) => out.push(String(value)),
      stderr: () => {},
    }
  );
  assert.equal(code, 0);
  const payload = JSON.parse(out.join("\n"));
  return { payload, stagePath: path.join(repo, payload.stage) };
}

test("draft grounds facts and stakeholder mentions into the same stage (ungrounded dropped)", async () => {
  const repo = workspace();
  try {
    const { payload, stagePath } = await draftWithEvidence(repo);
    assert.equal(payload.decisions, 1);
    assert.equal(payload.tasks, 1);
    assert.equal(payload.facts, 1); // only the grounded "Launch is August 4" survives
    assert.equal(payload.stakeholders, 1);
    const stage = JSON.parse(readFileSync(stagePath, "utf8"));
    assert.equal(stage.facts.length, 1);
    assert.equal(stage.facts[0].title, "Launch is August 4");
    assert.equal(stage.facts[0].access, "admin"); // facts default to admin; reviewer promotes
    assert.match(stage.facts[0].rowKey, /^fact-[a-f0-9]{16}$/);
    assert.equal(stage.stakeholderMentions.length, 1);
    assert.equal(stage.stakeholderMentions[0].name, "Sam Rivera");
    assert.equal(stage.stakeholderMentions[0].access, "admin");
    // Evidence is excluded from the reviewDigest, which stays pinned to the decision/task payload.
    assert.match(stage.reviewDigest, /^[a-f\d]{64}$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approve routes evidence to tier files, records counts, and is idempotent for v2", async () => {
  const repo = workspace();
  try {
    const { stagePath } = await draftWithEvidence(repo);
    assert.equal(await approveWithoutPush(repo, stagePath), 0);
    const approved = JSON.parse(readFileSync(stagePath, "utf8"));
    assert.equal(approved.status, "approved");
    assert.equal(approved.apply.factsAdded, 1);
    assert.equal(approved.apply.stakeholdersAdded, 1);
    // Admin-default evidence lands in the private files (never synced by push).
    const facts = readFileSync(path.join(repo, "3-log", "facts-private.md"), "utf8");
    assert.match(facts, /kind: fact/);
    assert.match(facts, /access: admin/);
    assert.match(facts, /Launch is August 4/);
    const mentions = readFileSync(
      path.join(repo, "3-log", "stakeholder-mentions-private.md"),
      "utf8"
    );
    assert.match(mentions, /kind: stakeholder_mention/);
    assert.match(mentions, /Sam Rivera/);
    const after = {
      facts,
      mentions,
    };
    // Idempotent re-approval: no duplicate evidence rows.
    assert.equal(await approveWithoutPush(repo, stagePath), 0);
    assert.deepEqual(
      {
        facts: readFileSync(path.join(repo, "3-log", "facts-private.md"), "utf8"),
        mentions: readFileSync(
          path.join(repo, "3-log", "stakeholder-mentions-private.md"),
          "utf8"
        ),
      },
      after
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("enable-sync adds the transcript path once", () => {
  const repo = workspace();
  try {
    assert.equal(enableTranscriptSync(repo), true);
    assert.equal(enableTranscriptSync(repo), false);
    const yaml = readFileSync(path.join(repo, "aios.yaml"), "utf8");
    assert.equal((yaml.match(/1-inbox\/transcripts/g) ?? []).length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
