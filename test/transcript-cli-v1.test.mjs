import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertReviewShape,
  gradeReport,
  readStage,
  runTranscriptCli,
  sha256,
  stageFiles,
  tasks,
  verificationReport,
  workspace,
  workspaceLogs,
  writeV1Stage,
} from "./helpers/transcript-pipeline.mjs";

function v1Runner(seen, grade = async () => gradeReport()) {
  return async ({ phase, input }) => {
    seen.push({ phase, input });
    if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
    if (phase === "verify") return verificationReport();
    assert.equal(phase, "grade");
    return grade();
  };
}

test("approve v1 has text/JSON parity and creates one provenance-bound 0600 v2", async (t) => {
  for (const json of [false, true]) {
    await t.test(json ? "json" : "text", async () => {
      const root = workspace();
      try {
        const v1Path = writeV1Stage(root);
        const before = readFileSync(v1Path);
        const seen = [];
        const args = ["approve", path.relative(root, v1Path), "--no-push"];
        if (json) args.push("--json");
        const approved = await runTranscriptCli(root, args, { runPhase: v1Runner(seen) });
        assert.equal(approved.code, 0);
        const output = json ? JSON.stringify(JSON.parse(approved.stdout)) : approved.stdout;
        assert.match(output, /v1|source/i);
        assert.match(output, /v2|stage/i);
        assert.match(output, /approved/i);
        assert.deepEqual(readFileSync(v1Path), before);
        assert.equal(stageFiles(root).length, 2);
        const v2Path = stageFiles(root).find((file) => file !== v1Path);
        const upgraded = readStage(v2Path);
        assert.notEqual(v2Path, v1Path);
        assertReviewShape(upgraded, "approved");
        assert.equal(upgraded.migration.sourcePath, path.relative(root, v1Path));
        assert.equal(upgraded.migration.sourceDigest, sha256(before));
        assert.equal(upgraded.migration.sourceVersion, 1);
        assert.equal(statSync(v2Path).mode & 0o777, 0o600);
        assert.equal(upgraded.push.state, "skipped");
        assert.match(workspaceLogs(root).decisions, /Limit the beta to existing customers/);
        assert.match(workspaceLogs(root).tasks, /Send the accessibility audit brief to Mina/);
        assert.deepEqual(
          seen.map(({ phase }) => phase),
          ["deduplicate", "verify", "grade"]
        );
        assert.ok(
          seen.every(({ input }) => input.decisions.length === 2 && input.tasks.length === 1)
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("approve v1 failure/error stage evidence but never writes logs or pushes", async (t) => {
  for (const item of [
    {
      name: "failed_rubric",
      code: 2,
      grade: async () => gradeReport({ verdict: "fail", failures: { TD2: [tasks[0].id] } }),
    },
    {
      name: "grading_error",
      code: 1,
      grade: async () => {
        throw new Error("synthetic provider interruption");
      },
    },
  ]) {
    await t.test(item.name, async () => {
      const root = workspace();
      try {
        const v1Path = writeV1Stage(root);
        const beforeV1 = readFileSync(v1Path);
        const beforeLogs = workspaceLogs(root);
        let pushes = 0;
        const result = await runTranscriptCli(
          root,
          ["approve", path.relative(root, v1Path), "--no-push", "--json"],
          {
            runPhase: v1Runner([], item.grade),
            push: async () => {
              pushes++;
            },
          }
        );
        assert.equal(result.code, item.code);
        assert.deepEqual(readFileSync(v1Path), beforeV1);
        assert.deepEqual(workspaceLogs(root), beforeLogs);
        assert.equal(pushes, 0);
        const v2 = stageFiles(root).find((file) => file !== v1Path);
        assertReviewShape(readStage(v2), item.name);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("approve v1 refuses a concurrent-edit digest race with exit 2", async () => {
  const root = workspace();
  try {
    const v1Path = writeV1Stage(root);
    const beforeLogs = workspaceLogs(root);
    let pushes = 0;
    const runPhase = v1Runner([], async () => {
      writeFileSync(v1Path, `${readFileSync(v1Path, "utf8")} `);
      return gradeReport();
    });
    const result = await runTranscriptCli(
      root,
      ["approve", path.relative(root, v1Path), "--no-push", "--json"],
      {
        runPhase,
        push: async () => {
          pushes++;
        },
      }
    );
    assert.equal(result.code, 2);
    assert.match(`${result.stdout}\n${result.stderr}`, /digest|changed|edit|integrity/i);
    assert.equal(stageFiles(root).length, 1);
    assert.deepEqual(workspaceLogs(root), beforeLogs);
    assert.equal(pushes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approve v1 malformed or escaping input exits 2 before any phase", async () => {
  const root = workspace();
  try {
    const badPath = writeV1Stage(root);
    writeFileSync(badPath, "{");
    let calls = 0;
    const malformed = await runTranscriptCli(
      root,
      ["approve", path.relative(root, badPath), "--no-push", "--json"],
      { runPhase: async () => calls++ }
    );
    const escaped = await runTranscriptCli(
      root,
      ["approve", "../outside.json", "--no-push", "--json"],
      { runPhase: async () => calls++ }
    );
    assert.equal(malformed.code, 2);
    assert.equal(escaped.code, 2);
    assert.equal(calls, 0);
    assert.equal(stageFiles(root).length, 1);
    assert.match(`${malformed.stdout}\n${malformed.stderr}`, /JSON|malformed|parse/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
