import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approveTranscriptStage,
  draftTranscriptReview,
  enableTranscriptSync,
} from "../scripts/transcripts.mjs";

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
    "John: We decided to ship on Friday. Chetan: I will prepare the release notes."
  );
  return repo;
}

const extraction = {
  decisions: [
    {
      date: "2026-07-13",
      decision: "Ship on Friday",
      rationale: "Ready",
      decidedBy: "John",
      impact: "Release",
      type: 2,
      audience: "team",
      transcript: "1-inbox/transcripts/meeting.md",
      sourceQuote: "We decided to ship on Friday.",
    },
    {
      decision: "Invented decision",
      transcript: "1-inbox/transcripts/meeting.md",
      sourceQuote: "This quote is absent",
    },
  ],
  tasks: [
    {
      task: "Prepare the release notes",
      assignee: "Chetan",
      transcript: "1-inbox/transcripts/meeting.md",
      sourceQuote: "I will prepare the release notes.",
    },
  ],
};

test("draft persists only grounded decisions and tasks for one durable review", async () => {
  const repo = workspace();
  try {
    const { file, stage } = await draftTranscriptReview({
      repo,
      transcriptPaths: ["1-inbox/transcripts/meeting.md"],
      extraction,
      now: "2026-07-13T12:00:00.000Z",
    });
    assert.equal(stage.status, "pending_review");
    assert.equal(stage.decisions.length, 1);
    assert.equal(stage.tasks.length, 1);
    assert.ok(file.startsWith(path.join(repo, ".aios", "staging")));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).access, "admin");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approve appends both logs once and is idempotent", async () => {
  const repo = workspace();
  try {
    const { file } = await draftTranscriptReview({
      repo,
      transcriptPaths: ["1-inbox/transcripts/meeting.md"],
      extraction,
      now: "2026-07-13T12:00:00.000Z",
    });
    assert.deepEqual(approveTranscriptStage({ repo, stageFile: file }), {
      decisions: 1,
      tasks: 1,
      facts: 0,
      stakeholders: 0,
      alreadyApproved: false,
    });
    assert.match(
      readFileSync(path.join(repo, "3-log", "decision-log.md"), "utf8"),
      /Ship on Friday/
    );
    assert.match(
      readFileSync(path.join(repo, "3-log", "tasks-team.md"), "utf8"),
      /TT1.*Prepare the release notes/
    );
    assert.equal(approveTranscriptStage({ repo, stageFile: file }).alreadyApproved, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("version 2 approval routes evidence by reviewed access and creates canonical logs", async () => {
  const repo = workspace();
  try {
    const transcriptPath = path.join(repo, "1-inbox", "transcripts", "meeting.md");
    writeFileSync(
      transcriptPath,
      "Alex: Launch is August 4. Sam Rivera owns the rollout. This sentence must stay private."
    );
    const { file, stage } = await draftTranscriptReview({
      repo,
      transcriptPaths: ["1-inbox/transcripts/meeting.md"],
      extraction: {
        decisions: [],
        tasks: [],
        facts: [
          {
            title: "Launch is August 4",
            factType: "event",
            transcript: "1-inbox/transcripts/meeting.md",
            sourceQuote: "Launch is August 4.",
          },
          {
            title: "Private planning note",
            factType: "fact",
            transcript: "1-inbox/transcripts/meeting.md",
            sourceQuote: "This sentence must stay private.",
          },
        ],
        stakeholders: [
          {
            name: "Sam Rivera",
            role: "Rollout owner",
            transcript: "1-inbox/transcripts/meeting.md",
            sourceQuote: "Sam Rivera owns the rollout.",
          },
        ],
      },
      now: "2026-07-24T12:00:00.000Z",
    });
    assert.equal(stage.facts.every((item) => item.access === "admin"), true);
    assert.equal(stage.stakeholders[0].access, "admin");

    stage.facts[0].access = "team";
    stage.stakeholders[0].access = "external";
    writeFileSync(file, JSON.stringify(stage, null, 2) + "\n");

    assert.deepEqual(approveTranscriptStage({ repo, stageFile: file }), {
      decisions: 0,
      tasks: 0,
      facts: 2,
      stakeholders: 1,
      alreadyApproved: false,
    });
    const teamFacts = readFileSync(path.join(repo, "3-log", "facts-team.md"), "utf8");
    const privateFacts = readFileSync(path.join(repo, "3-log", "facts-private.md"), "utf8");
    const sharedStakeholders = readFileSync(
      path.join(repo, "4-shared", "stakeholder-mentions.md"),
      "utf8"
    );
    assert.match(teamFacts, /kind: fact\naccess: team/);
    assert.match(teamFacts, /Launch is August 4/);
    assert.doesNotMatch(teamFacts, /This sentence must stay private/);
    assert.match(privateFacts, /kind: fact\naccess: admin/);
    assert.match(privateFacts, /Private planning note/);
    assert.match(sharedStakeholders, /kind: stakeholder_mention\naccess: external/);
    assert.match(sharedStakeholders, /Sam Rivera/);
    assert.equal(approveTranscriptStage({ repo, stageFile: file }).alreadyApproved, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pending version 1 decision/task stages remain approvable", () => {
  const repo = workspace();
  try {
    rmSync(path.join(repo, "3-log", "decision-log.md"));
    rmSync(path.join(repo, "3-log", "tasks-team.md"));
    const dir = path.join(repo, ".aios", "staging", "transcript-decisions");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "legacy.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        status: "pending_review",
        access: "admin",
        decisions: [{ decision: "Keep legacy approval", date: "2026-07-24" }],
        tasks: [{ task: "Keep legacy task" }],
      })
    );
    assert.deepEqual(approveTranscriptStage({ repo, stageFile: file }), {
      decisions: 1,
      tasks: 1,
      alreadyApproved: false,
    });
    assert.equal(existsSync(path.join(repo, "3-log", "decision-log.md")), true);
    assert.equal(existsSync(path.join(repo, "3-log", "tasks-team.md")), true);
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
