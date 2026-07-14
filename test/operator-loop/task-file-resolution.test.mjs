import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { jsonWriteback, resolveLoopTasksPath } from "../../scripts/loop.mjs";

function workspace() {
  const repo = mkdtempSync(path.join(tmpdir(), "loop-task-file-"));
  const log = path.join(repo, "3-log");
  mkdirSync(log, { recursive: true });
  return { repo, log };
}

test("C6 prefers the modern team-tier task file", () => {
  const { repo, log } = workspace();
  writeFileSync(path.join(log, "tasks.md"), "legacy");
  writeFileSync(path.join(log, "tasks-team.md"), "team");
  assert.equal(resolveLoopTasksPath(repo, log), path.join(log, "tasks-team.md"));
});

test("C6 falls back to legacy task homes", () => {
  const modern = workspace();
  writeFileSync(path.join(modern.log, "tasks.md"), "legacy");
  assert.equal(resolveLoopTasksPath(modern.repo, modern.log), path.join(modern.log, "tasks.md"));

  const old = workspace();
  const legacyDir = path.join(old.repo, "03-status");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(path.join(legacyDir, "tasks.md"), "legacy");
  assert.equal(resolveLoopTasksPath(old.repo, old.log), path.join(legacyDir, "tasks.md"));
});

test("C6 JSON omits team-tier task titles", () => {
  const plan = {
    stamp: "run-1",
    fileWrites: [],
    taskWrite: { rows: [{ row_key: "nw-123", title: "Carry over: private team wording" }] },
    skips: [],
    tierSafetyWithheld: false,
  };
  const loop = {
    aboveAudienceStrings: () => ["Carry over: private team wording"],
    sweepForLeaks: (text, corpus) => corpus.filter((value) => text.includes(value)),
  };
  const payload = JSON.parse(jsonWriteback(plan, ["pm"], { signals: [] }, loop));
  assert.deepEqual(payload.taskRows, [{ row_key: "nw-123" }]);
  assert.ok(!JSON.stringify(payload).includes("private team wording"));
});
