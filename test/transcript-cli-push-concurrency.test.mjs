import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  NOW,
  TRANSCRIPT_REL,
  loadMeetings,
  passingPhaseRunner,
  readStage,
  runTranscriptCli,
  sha256,
  stageFiles,
  workspace,
  workspaceLogs,
  writeExtraction,
} from "./helpers/transcript-pipeline.mjs";

async function approvedFailedStage(root) {
  const extraction = writeExtraction(root);
  const drafted = await runTranscriptCli(
    root,
    ["draft", "--transcripts", TRANSCRIPT_REL, "--from-json", extraction, "--json"],
    { runPhase: passingPhaseRunner() }
  );
  assert.equal(drafted.code, 0);
  const stagePath = stageFiles(root)[0];
  const failed = await runTranscriptCli(root, ["approve", path.relative(root, stagePath)], {
    push: async () => {
      throw new Error("synthetic initial push failure");
    },
  });
  assert.equal(failed.code, 1);
  assert.equal(readStage(stagePath).push.state, "failed");
  return stagePath;
}

function childApproval(root, stagePath, readyPath, pushLogPath) {
  const cliUrl = pathToFileURL(path.join(process.cwd(), "scripts", "transcripts.mjs")).href;
  const source = `
    import { appendFileSync, readFileSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { cmdTranscripts } from ${JSON.stringify(cliUrl)};
    const root = ${JSON.stringify(root)};
    const readyPath = ${JSON.stringify(readyPath)};
    appendFileSync(readyPath, process.pid + "\\n");
    const deadline = Date.now() + 5000;
    while (readFileSync(readyPath, "utf8").trim().split("\\n").length < 2) {
      if (Date.now() >= deadline) throw new Error("concurrency barrier timeout");
      await delay(5);
    }
    const output = [];
    const code = await cmdTranscripts(
      root,
      {},
      ["approve", ${JSON.stringify(path.relative(root, stagePath))}, "--json"],
      {
        now: () => ${JSON.stringify(NOW)},
        stdout: (value) => output.push(String(value)),
        stderr: (value) => output.push(String(value)),
        push: async () => {
          appendFileSync(${JSON.stringify(pushLogPath)}, process.pid + "\\n");
          await delay(500);
        },
      }
    );
    process.stdout.write(JSON.stringify({ code, output: output.join("\\n") }));
    process.exitCode = code;
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child approval timeout"));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function pushLocks(root) {
  const directory = path.join(root, ".aios", "locks");
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => name.startsWith("transcript-push-"))
    : [];
}

function stageLockPath(root, stagePath) {
  return path.join(root, ".aios", "locks", `transcript-push-${path.basename(stagePath)}.lock`);
}

function pushLogLines(pushLogPath) {
  return existsSync(pushLogPath)
    ? readFileSync(pushLogPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

async function waitFor(predicate, { timeout = 8000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timeout");
    await delay(interval);
  }
}

// A real child that reaches the external push boundary while holding the per-stage
// lock, records its pid to the external-push log, then blocks forever so the parent
// can SIGKILL it mid-push (an uncatchable interruption whose `finally` never runs).
function blockingChildApproval(root, stagePath, pushLogPath) {
  const cliUrl = pathToFileURL(path.join(process.cwd(), "scripts", "transcripts.mjs")).href;
  // The push handler blocks on a real long timer (a live handle keeps the child's
  // event loop alive) so the child genuinely sits inside the external push holding
  // the lock until the parent SIGKILLs it — a pending promise alone would let Node
  // drain and exit early, defeating the interruption we want to simulate.
  const source = `
    import { appendFileSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { cmdTranscripts } from ${JSON.stringify(cliUrl)};
    const code = await cmdTranscripts(
      ${JSON.stringify(root)},
      {},
      ["approve", ${JSON.stringify(path.relative(root, stagePath))}, "--json"],
      {
        now: () => ${JSON.stringify(NOW)},
        stdout: () => {},
        stderr: () => {},
        push: async () => {
          appendFileSync(${JSON.stringify(pushLogPath)}, process.pid + "\\n");
          await delay(600000);
        },
      }
    );
    process.exitCode = code;
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "ignore"],
  });
}

test("concurrent failed-stage approvals invoke one external push and leave coherent durable state", async () => {
  const root = workspace();
  try {
    const stagePath = await approvedFailedStage(root);
    const failedAttemptId = readStage(stagePath).push.attempts[0].id;
    const beforeLogs = workspaceLogs(root);
    const beforeHashes = {
      decisions: sha256(beforeLogs.decisions),
      tasks: sha256(beforeLogs.tasks),
    };
    const readyPath = path.join(root, "push-ready.log");
    const pushLogPath = path.join(root, "external-push.log");

    const results = await Promise.all([
      childApproval(root, stagePath, readyPath, pushLogPath),
      childApproval(root, stagePath, readyPath, pushLogPath),
    ]);

    assert.equal(readFileSync(pushLogPath, "utf8").trim().split("\n").length, 1);
    assert.deepEqual(results.map(({ code }) => code).sort(), [0, 1]);
    assert.match(results.find(({ code }) => code === 1)?.stdout ?? "", /busy|in.?flight/i);
    assert.doesNotMatch(results.find(({ code }) => code === 1)?.stdout ?? "", /"code":0/);
    const stage = readStage(stagePath);
    assert.equal(stage.push.state, "succeeded");
    assert.equal(stage.push.attempts.length, 2);
    assert.equal(stage.push.attempts[0].id, failedAttemptId);
    assert.equal(stage.push.attempts[0].state, "failed");
    assert.notEqual(stage.push.attempts[1].id, failedAttemptId);
    assert.equal(stage.push.attempts[1].state, "succeeded");
    assert.deepEqual(
      {
        decisions: sha256(workspaceLogs(root).decisions),
        tasks: sha256(workspaceLogs(root).tasks),
      },
      beforeHashes
    );
    assert.deepEqual(pushLocks(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous pending attempt after final bookkeeping failure fails closed on immediate retry", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const extraction = writeExtraction(root);
    const drafted = await runTranscriptCli(
      root,
      ["draft", "--transcripts", TRANSCRIPT_REL, "--from-json", extraction, "--json"],
      { runPhase: passingPhaseRunner() }
    );
    assert.equal(drafted.code, 0);
    const stagePath = stageFiles(root)[0];
    let recordCalls = 0;
    let pushes = 0;
    const engine = {
      ...meetings,
      recordTranscriptPushAttempt(options) {
        recordCalls += 1;
        if (recordCalls === 2) throw new Error("synthetic final bookkeeping write failure");
        return meetings.recordTranscriptPushAttempt(options);
      },
    };
    const first = await runTranscriptCli(
      root,
      ["approve", path.relative(root, stagePath), "--json"],
      {
        engine,
        push: async () => {
          pushes += 1;
        },
      }
    );
    assert.equal(first.code, 1);
    assert.match(first.stdout, /bookkeeping_failed/);
    const pending = readStage(stagePath);
    assert.equal(pending.push.state, "pending");
    assert.equal(pending.push.attempts.length, 1);
    assert.equal(pending.push.attempts[0].state, "pending");
    const pendingAttemptId = pending.push.attempts[0].id;
    const pendingBytes = readFileSync(stagePath, "utf8");
    const pendingLogs = workspaceLogs(root);

    const retry = await runTranscriptCli(
      root,
      ["approve", path.relative(root, stagePath), "--json"],
      {
        push: async () => {
          pushes += 1;
        },
      }
    );

    assert.equal(retry.code, 1);
    assert.match(retry.stdout, /pending|ambiguous|in.?flight/i);
    assert.doesNotMatch(retry.stdout, /"code":0|succeeded|successful/i);
    assert.equal(pushes, 1);
    assert.equal(readFileSync(stagePath, "utf8"), pendingBytes);
    assert.equal(readStage(stagePath).push.attempts[0].id, pendingAttemptId);
    assert.deepEqual(workspaceLogs(root), pendingLogs);
    assert.deepEqual(pushLocks(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL mid-push leaves a reclaimable lock and the retry refuses a duplicate push", async () => {
  const root = workspace();
  let child = null;
  try {
    const extraction = writeExtraction(root);
    const drafted = await runTranscriptCli(
      root,
      ["draft", "--transcripts", TRANSCRIPT_REL, "--from-json", extraction, "--json"],
      { runPhase: passingPhaseRunner() }
    );
    assert.equal(drafted.code, 0);
    const stagePath = stageFiles(root)[0];
    const pushLogPath = path.join(root, "external-push.log");
    const lockPath = stageLockPath(root, stagePath);

    child = blockingChildApproval(root, stagePath, pushLogPath);

    // Wait until the child has persisted the pending attempt and entered the external
    // push while still holding the stage lock.
    await waitFor(() => existsSync(lockPath) && pushLogLines(pushLogPath).length === 1);
    assert.equal(readFileSync(lockPath, "utf8").trim(), String(child.pid));
    assert.equal(readStage(stagePath).push.state, "pending");

    // Uncatchable interruption: the lock is abandoned because no `finally` runs.
    // Subscribe to `exit` before signalling so a fast death cannot be missed.
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    child = null;
    assert.ok(existsSync(lockPath), "abandoned stage lock must survive SIGKILL");
    assert.equal(pushLogLines(pushLogPath).length, 1);

    // A later approval must reclaim the dead owner's lock (never deadlock on busy)
    // and then fail closed on the durable pending attempt with no second push.
    let retryPushes = 0;
    const retry = await runTranscriptCli(
      root,
      ["approve", path.relative(root, stagePath), "--json"],
      {
        push: async () => {
          retryPushes += 1;
        },
      }
    );

    assert.equal(retry.code, 1);
    assert.match(retry.stdout, /refusing duplicate push/i);
    assert.doesNotMatch(retry.stdout, /busy/i);
    assert.equal(retryPushes, 0);
    assert.equal(pushLogLines(pushLogPath).length, 1);
    assert.equal(readStage(stagePath).push.state, "pending");
    assert.deepEqual(pushLocks(root), []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably failed push retries exactly once and succeeds with a new attempt id", async () => {
  const root = workspace();
  try {
    const stagePath = await approvedFailedStage(root);
    const failed = readStage(stagePath);
    const beforeLogs = workspaceLogs(root);
    let pushes = 0;
    const retried = await runTranscriptCli(root, ["approve", path.relative(root, stagePath)], {
      push: async () => {
        pushes += 1;
      },
    });
    assert.equal(retried.code, 0);
    assert.match(retried.stdout, /push: succeeded/i);
    assert.equal(pushes, 1);
    const succeeded = readStage(stagePath);
    assert.equal(succeeded.push.state, "succeeded");
    assert.equal(succeeded.push.attempts.length, 2);
    assert.equal(succeeded.push.attempts[0].id, failed.push.attempts[0].id);
    assert.notEqual(succeeded.push.attempts[1].id, failed.push.attempts[0].id);
    assert.equal(succeeded.push.attempts[1].state, "succeeded");
    assert.deepEqual(workspaceLogs(root), beforeLogs);
    assert.deepEqual(pushLocks(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
