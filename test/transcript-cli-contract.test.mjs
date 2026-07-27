import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
  workspaceLogs,
  writeExtraction,
} from "./helpers/transcript-pipeline.mjs";

function runner(grade, candidates = { decisions, tasks }) {
  return async ({ phase, input }) => {
    if (phase === "extract") return candidates;
    if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
    if (phase === "verify") return verificationReport();
    return grade();
  };
}

function assertObservableStatus(result, json, status, code) {
  assert.equal(result.code, code);
  if (json) {
    const payload = JSON.parse(result.stdout);
    assert.match(JSON.stringify(payload), new RegExp(status));
  } else {
    assert.match(result.stdout, new RegExp(status.replaceAll("_", "[ _]"), "i"));
  }
}

test("operational draft failure exits 1 without a phase, stage, or success output", async () => {
  const root = workspace();
  try {
    let calls = 0;
    const result = await runTranscriptCli(
      root,
      ["draft", "--transcripts", "1-inbox/transcripts/missing.md"],
      { runPhase: async () => calls++ }
    );
    assert.equal(result.code, 1);
    assert.equal(calls, 0);
    assert.deepEqual(stageFiles(root), []);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\b(success|approved|pending)\b/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("certified no_changes has text/JSON exit parity and writes no stage", async () => {
  const results = [];
  for (const json of [false, true]) {
    const root = workspace();
    try {
      const extraction = "empty-extraction.json";
      writeFileSync(path.join(root, extraction), JSON.stringify({ decisions: [], tasks: [] }));
      const args = ["draft", "--transcripts", TRANSCRIPT_REL, "--from-json", extraction];
      if (json) args.push("--json");
      const result = await runTranscriptCli(root, args, {
        runPhase: runner(async () => gradeReport({ certifiedNoChanges: true }), {
          decisions: [],
          tasks: [],
        }),
      });
      results.push(result);
      assert.equal(result.code, 0);
      assert.deepEqual(stageFiles(root), []);
      assert.match(result.stdout, json ? /"(?:outcome|status)":"no_changes"/ : /no[_ ]changes/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(
    results.map(({ code }) => code),
    [0, 0]
  );
});

test("failed_rubric has text/JSON exit and durable-state parity", async () => {
  const statuses = [];
  for (const json of [false, true]) {
    const root = workspace();
    try {
      const extraction = writeExtraction(root);
      const args = [
        "draft",
        "--transcripts",
        TRANSCRIPT_REL,
        "--from-json",
        extraction,
        "--rubric-budget",
        "0",
      ];
      if (json) args.push("--json");
      const result = await runTranscriptCli(root, args, {
        runPhase: runner(async () =>
          gradeReport({ verdict: "fail", failures: { TD6: [TRANSCRIPT_REL] } })
        ),
      });
      assert.equal(result.code, 2);
      statuses.push(readStage(stageFiles(root)[0]).status);
      assert.match(result.stdout, /failed_rubric/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(statuses, ["failed_rubric", "failed_rubric"]);
});

test("pending_review and grading_error have observable text/JSON parity", async (t) => {
  for (const item of [
    { status: "pending_review", code: 0, grade: async () => gradeReport() },
    {
      status: "grading_error",
      code: 1,
      grade: async () => {
        throw new Error("synthetic grading parity outage");
      },
    },
  ]) {
    await t.test(item.status, async () => {
      for (const json of [false, true]) {
        const root = workspace();
        try {
          const extraction = writeExtraction(root);
          const args = ["draft", "--transcripts", TRANSCRIPT_REL, "--from-json", extraction];
          if (json) args.push("--json");
          const result = await runTranscriptCli(root, args, { runPhase: runner(item.grade) });
          assertObservableStatus(result, json, item.status, item.code);
          assertReviewShape(readStage(stageFiles(root)[0]), item.status);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    });
  }
});

test("non-certified empty extraction is failure or error, never no_changes or approval", async (t) => {
  for (const item of [
    {
      status: "failed_rubric",
      code: 2,
      grade: async () => gradeReport({ verdict: "fail", failures: { TD6: [TRANSCRIPT_REL] } }),
    },
    {
      status: "grading_error",
      code: 1,
      grade: async () => {
        throw new Error("synthetic empty grading outage");
      },
    },
  ]) {
    await t.test(item.status, async () => {
      const root = workspace();
      try {
        const extraction = "empty-uncertified.json";
        writeFileSync(path.join(root, extraction), JSON.stringify({ decisions: [], tasks: [] }));
        const beforeLogs = workspaceLogs(root);
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
          { runPhase: runner(item.grade, { decisions: [], tasks: [] }) }
        );
        assertObservableStatus(result, true, item.status, item.code);
        assert.doesNotMatch(result.stdout, /no_changes|approved/i);
        assertReviewShape(readStage(stageFiles(root)[0]), item.status);
        assert.deepEqual(workspaceLogs(root), beforeLogs);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("approve refuses reviewDigest tampering with exit 2 and no premature success", async () => {
  const root = workspace();
  try {
    const extraction = writeExtraction(root);
    const drafted = await runTranscriptCli(
      root,
      ["draft", "--transcripts", TRANSCRIPT_REL, "--from-json", extraction, "--json"],
      { runPhase: runner(async () => gradeReport()) }
    );
    assert.equal(drafted.code, 0);
    const stagePath = stageFiles(root)[0];
    const tampered = readStage(stagePath);
    tampered.tasks[0].task = "Tampered ungraded task";
    writeFileSync(stagePath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    const beforeLogs = workspaceLogs(root);
    const refused = await runTranscriptCli(root, ["approve", path.relative(root, stagePath)]);
    assert.equal(refused.code, 2);
    assert.deepEqual(workspaceLogs(root), beforeLogs);
    assert.equal(readStage(stagePath).status, "pending_review");
    assert.match(`${refused.stdout}\n${refused.stderr}`, /digest|integrity|review/i);
    assert.doesNotMatch(refused.stdout, /\b(success|approved)\b/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approve refuses a non-approvable stage with exit 2 and never pushes", async () => {
  const root = workspace();
  try {
    const extraction = writeExtraction(root);
    const drafted = await runTranscriptCli(
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
        runPhase: runner(async () =>
          gradeReport({ verdict: "fail", failures: { TD6: [TRANSCRIPT_REL] } })
        ),
      }
    );
    assert.equal(drafted.code, 2);
    const stagePath = stageFiles(root)[0];
    const beforeLogs = workspaceLogs(root);
    const beforeStage = readFileSync(stagePath, "utf8");
    let pushes = 0;
    const refused = await runTranscriptCli(
      root,
      ["approve", path.relative(root, stagePath), "--json"],
      { push: async () => pushes++ }
    );
    assert.equal(refused.code, 2);
    assert.deepEqual(workspaceLogs(root), beforeLogs);
    assert.equal(pushes, 0);
    assert.equal(readFileSync(stagePath, "utf8"), beforeStage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
