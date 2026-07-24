import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPendingTranscriptStage,
  draftTranscriptReview,
} from "../../dist/operator-loop/meetings/index.js";
import {
  NOW,
  TRANSCRIPT_REL,
  decisionHeader,
  decisions,
  gradeReport,
  passingPhaseRunner,
  taskHeader,
  tasks,
  verificationReport,
  workspace,
} from "../helpers/transcript-pipeline.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

function run(root, args) {
  try {
    const stdout = execFileSync("node", [CLI, "loop", "daily", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function phaseRunner(finalGrade) {
  return async ({ phase, input }) => {
    if (phase === "extract") return { decisions, tasks };
    if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
    if (phase === "verify") return verificationReport();
    if (phase === "grade") return finalGrade();
    assert.fail(`unexpected phase: ${phase}`);
  };
}

async function seedReviewQueue(root) {
  const draft = (runPhase, rubricBudget = 0) =>
    draftTranscriptReview({
      root,
      transcriptPaths: [TRANSCRIPT_REL],
      rubricBudget,
      runPhase,
      now: () => NOW,
    });
  const pending = await draft(passingPhaseRunner());
  await draft(
    phaseRunner(() => gradeReport({ verdict: "fail", failures: { TD6: [TRANSCRIPT_REL] } }))
  );
  await draft(
    phaseRunner(() => {
      throw new Error("synthetic grader outage");
    })
  );
  const approved = await draft(passingPhaseRunner());
  applyPendingTranscriptStage({ root, stagePath: approved.stagePath, now: () => NOW });
  writeFileSync(path.join(root, "3-log", "decision-log.md"), decisionHeader);
  writeFileSync(path.join(root, "3-log", "tasks-team.md"), taskHeader);

  const staging = path.dirname(pending.stagePath);
  writeFileSync(path.join(staging, "malformed-private-stage.json"), "{not-json");
  symlinkSync("malformed-private-stage.json", path.join(staging, "symlink-private-stage.json"));
  return path.basename(pending.stagePath);
}

function emptyManifest(root) {
  const pathname = path.join(root, "daily-manifest.json");
  writeFileSync(
    pathname,
    JSON.stringify({
      member: "alex",
      project: "acme",
      generatedAt: NOW,
      window: {
        cadence: "daily",
        from: "2026-07-21T03:04:05.000Z",
        to: NOW,
      },
      windowed: false,
      signals: [],
      excluded: [],
    })
  );
  return pathname;
}

test("live daily exposes aggregate review work only to owner; manifest replay stays deterministic", async () => {
  // Given a real local queue with pending, failed, errored, approved, malformed, and symlink stages.
  const root = workspace();
  try {
    writeFileSync(path.join(root, "aios.yaml"), "member: alex\n");
    const privateStageName = await seedReviewQueue(root);
    const proposal = decisions[0].decision;

    // When owner, shareable, and supplied-manifest forms run through the real CLI.
    const ownerJson = run(root, ["--json", "--no-record"]);
    const ownerText = run(root, ["--no-record"]);
    const teamJson = run(root, ["--as", "team", "--json"]);
    const externalJson = run(root, ["--as", "external", "--json"]);
    const manifestPath = emptyManifest(root);
    const manifestFirst = run(root, ["--manifest", manifestPath, "--json"]);
    const manifestSecond = run(root, ["--manifest", manifestPath, "--json"]);

    // Then owner text/JSON agree on counts and commands without stage or proposal content.
    for (const result of [ownerJson, ownerText, teamJson, externalJson, manifestFirst]) {
      assert.equal(result.code, 0, result.stderr);
    }
    const owner = JSON.parse(ownerJson.stdout);
    assert.deepEqual(owner.transcriptReview, {
      pendingStages: 1,
      decisions: decisions.length,
      tasks: tasks.length,
      failedRubric: 1,
      gradingErrors: 1,
      unreadableStages: 2,
    });
    assert.match(
      ownerText.stdout,
      new RegExp(
        `${decisions.length} decisions \\+ ${tasks.length} task pending review — aios transcripts list; approve with aios transcripts approve <file>`
      )
    );
    assert.match(
      ownerText.stdout,
      /1 rubric failure \+ 1 grading error \+ 2 unreadable stages — inspect with aios transcripts list/
    );
    assert.doesNotMatch(`${ownerJson.stdout}\n${ownerText.stdout}`, new RegExp(proposal));
    assert.doesNotMatch(`${ownerJson.stdout}\n${ownerText.stdout}`, new RegExp(privateStageName));
    assert.doesNotMatch(ownerText.stdout, /You're clear|No classifiable daily items/);

    // Then team/external omit the property, and supplied manifest replay omits live queue state.
    for (const result of [teamJson, externalJson]) {
      const orientation = JSON.parse(result.stdout);
      assert.equal(Object.hasOwn(orientation, "transcriptReview"), false);
      assert.doesNotMatch(result.stdout, /transcripts (?:list|approve)|pendingStages/);
    }
    assert.equal(manifestSecond.code, 0, manifestSecond.stderr);
    assert.equal(manifestSecond.stdout, manifestFirst.stdout);
    assert.equal(Object.hasOwn(JSON.parse(manifestFirst.stdout), "transcriptReview"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
