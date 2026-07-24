import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  TRANSCRIPT_REL,
  assertReviewShape,
  decisions,
  gradeReport,
  readStage,
  runTranscriptCli,
  stageFiles,
  tasks,
  verificationReport,
  workspace,
  writeExtraction,
} from "./helpers/transcript-pipeline.mjs";

test("CLI pins pending, failed_rubric, and grading_error exit codes", async (t) => {
  const cases = [
    { name: "pending_review", code: 0, grade: async () => gradeReport() },
    {
      name: "failed_rubric",
      code: 2,
      grade: async () => gradeReport({ verdict: "fail", failures: { TD6: [TRANSCRIPT_REL] } }),
    },
    {
      name: "grading_error",
      code: 1,
      grade: async () => {
        throw new Error("synthetic grading outage");
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const root = workspace();
      try {
        const extraction = writeExtraction(root);
        const result = await runTranscriptCli(
          root,
          [
            "draft",
            "--transcripts",
            TRANSCRIPT_REL,
            "--from-json",
            extraction,
            "--rubric-budget",
            "0",
            "--json",
          ],
          {
            runPhase: async ({ phase, input }) => {
              if (phase === "extract") return { decisions, tasks };
              if (phase === "deduplicate") {
                return { decisions: input.decisions, tasks: input.tasks };
              }
              if (phase === "verify") return verificationReport();
              return item.grade();
            },
          }
        );
        assert.equal(result.code, item.code);
        assert.equal(readStage(stageFiles(root)[0]).status, item.name);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("default approve reports local approval and push failure, then retries without reapply", async (t) => {
  for (const json of [false, true]) {
    await t.test(json ? "json" : "text", async () => {
      const root = workspace();
      try {
        const extraction = writeExtraction(root);
        const runPhase = async ({ phase, input }) => {
          if (phase === "extract") return { decisions, tasks };
          if (phase === "deduplicate") {
            return { decisions: input.decisions, tasks: input.tasks };
          }
          if (phase === "verify") return verificationReport();
          return gradeReport();
        };
        const drafted = await runTranscriptCli(
          root,
          ["draft", "--transcripts", TRANSCRIPT_REL, "--from-json", extraction, "--json"],
          { runPhase }
        );
        assert.equal(drafted.code, 0);
        const stagePath = stageFiles(root)[0];
        const reviewed = readStage(stagePath);
        assert.equal(reviewed.version, 2, "red guard: never invoke the legacy real push path");
        let pushes = 0;
        const approveArgs = ["approve", path.relative(root, stagePath)];
        if (json) approveArgs.push("--json");
        const failed = await runTranscriptCli(root, approveArgs, {
          push: async () => {
            pushes++;
            throw new Error("synthetic network failure");
          },
        });
        assert.equal(failed.code, 1);
        const failedOutput = json ? JSON.stringify(JSON.parse(failed.stdout)) : failed.stdout;
        assert.match(failedOutput, /approved/i);
        assert.match(failedOutput, /push/i);
        assert.match(failedOutput, /failed/i);
        assert.doesNotMatch(failed.stdout, /\bsuccess(?:ful|fully)?\b/i);
        const afterFailure = readStage(stagePath);
        assertReviewShape(afterFailure, "approved", { approvedFrom: reviewed });
        assert.equal(afterFailure.push.state, "failed");
        assert.equal(statSync(stagePath).mode & 0o777, 0o600);
        const appliedLogs = {
          decisions: readFileSync(path.join(root, "3-log", "decision-log.md"), "utf8"),
          tasks: readFileSync(path.join(root, "3-log", "tasks-team.md"), "utf8"),
        };
        const retried = await runTranscriptCli(root, approveArgs, {
          push: async () => {
            pushes++;
          },
        });
        assert.equal(retried.code, 0);
        const retriedOutput = json ? JSON.stringify(JSON.parse(retried.stdout)) : retried.stdout;
        assert.match(retriedOutput, /approved/i);
        assert.match(retriedOutput, /push/i);
        assert.match(retriedOutput, /succeeded|success/i);
        assert.equal(
          readFileSync(path.join(root, "3-log", "decision-log.md"), "utf8"),
          appliedLogs.decisions
        );
        assert.equal(
          readFileSync(path.join(root, "3-log", "tasks-team.md"), "utf8"),
          appliedLogs.tasks
        );
        const afterRetry = readStage(stagePath);
        assertReviewShape(afterRetry, "approved", { approvedFrom: reviewed });
        assert.equal(afterRetry.push.state, "succeeded");
        assert.equal(afterRetry.push.attempts.length, 2);
        assert.equal(statSync(stagePath).mode & 0o777, 0o600);
        assert.equal(pushes, 2);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("approve --no-push has text/JSON parity without proposal or push-success leakage", async (t) => {
  for (const json of [false, true]) {
    await t.test(json ? "json" : "text", async () => {
      const root = workspace();
      try {
        const extraction = writeExtraction(root);
        const runPhase = async ({ phase, input }) => {
          if (phase === "extract") return { decisions, tasks };
          if (phase === "deduplicate") {
            return { decisions: input.decisions, tasks: input.tasks };
          }
          if (phase === "verify") return verificationReport();
          return gradeReport();
        };
        const drafted = await runTranscriptCli(
          root,
          ["draft", "--transcripts", TRANSCRIPT_REL, "--from-json", extraction, "--json"],
          { runPhase }
        );
        assert.equal(drafted.code, 0);
        const stagePath = stageFiles(root)[0];
        let pushes = 0;
        const args = ["approve", path.relative(root, stagePath), "--no-push"];
        if (json) args.push("--json");
        const approved = await runTranscriptCli(root, args, { push: async () => pushes++ });
        assert.equal(approved.code, 0);
        const output = json ? JSON.stringify(JSON.parse(approved.stdout)) : approved.stdout;
        assert.match(output, /approved/i);
        assert.match(output, /skipped|no[_ -]?push/i);
        assert.doesNotMatch(output, /Limit the beta|accessibility audit brief|sourceQuote/i);
        assert.doesNotMatch(output, /push.{0,24}(?:succeeded|successful)/i);
        const stage = readStage(stagePath);
        assertReviewShape(stage, "approved");
        assert.equal(stage.push.state, "skipped");
        assert.equal(pushes, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("invalid/non-approvable inputs exit 2 and list is fail-soft for malformed stages", async () => {
  const root = workspace();
  try {
    const dir = path.join(root, ".aios", "staging", "transcript-decisions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bad-json.json"), "{");
    writeFileSync(
      path.join(dir, "unknown.json"),
      JSON.stringify({ version: 2, status: "unknown" })
    );
    for (const json of [false, true]) {
      const listed = await runTranscriptCli(root, json ? ["list", "--json"] : ["list"]);
      assert.equal(listed.code, 0);
      const output = json ? JSON.stringify(JSON.parse(listed.stdout)) : listed.stdout;
      assert.match(output, /diagnostics|invalid|malformed/i);
      assert.match(output, /bad-json\.json/);
      assert.match(output, /unknown\.json/);
      assert.doesNotMatch(output, /Limit the beta|accessibility audit brief|sourceQuote/i);
      assert.doesNotMatch(output, /approved|push.{0,24}(?:succeeded|successful)/i);
    }
    const invalid = await runTranscriptCli(root, [
      "approve",
      ".aios/staging/transcript-decisions/unknown.json",
      "--no-push",
      "--json",
    ]);
    assert.equal(invalid.code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
