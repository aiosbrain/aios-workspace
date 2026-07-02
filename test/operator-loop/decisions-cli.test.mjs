// Decisions CLI (AIO-170 / EE4) — drives the real `aios decisions` command as a child process.
// Seeds records via the compiled store, then proves list / show / outcome / export round-trip,
// OFFLINE routing from a repo with NO aios.yaml (like `aios asks`/`aios time`), the `--repo` flag,
// JSON output contracts, id-prefix resolution, and error exit codes.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendDecision } from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

function ws() {
  // A bare temp dir with NO aios.yaml — exercises the offline config path.
  return mkdtempSync(path.join(tmpdir(), "decisions-cli-"));
}
function run(dir, args) {
  try {
    const stdout = execFileSync("node", [CLI, "decisions", ...args, "--repo", dir], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
function seed(dir) {
  const a = appendDecision(dir, {
    kind: "ask-user-question",
    question: "Which database?",
    header: "Database",
    options: [
      { label: "Postgres", description: "relational" },
      { label: "Mongo", description: "document" },
    ],
    choice: ["Postgres"],
    notes: "cheaper",
    context: { sessionId: "s1", project: "proj", transcriptPath: null, cwd: "/proj" },
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  const b = appendDecision(dir, {
    kind: "plan-approval",
    question: "Plan approval: Ship billing",
    choice: ["rejected"],
    notes: "not yet",
    createdAt: "2026-07-02T00:00:00.000Z",
  });
  return { a, b };
}

test("list --json: newest first, JSON contract with decisions[] + warnings[]", () => {
  const dir = ws();
  try {
    const { a, b } = seed(dir);
    const res = run(dir, ["list", "--json"]);
    assert.equal(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assert.ok(
      Array.isArray(parsed.decisions) && Array.isArray(parsed.warnings),
      "list JSON contract"
    );
    assert.equal(parsed.decisions.length, 2);
    assert.equal(parsed.decisions[0].id, b.id, "newest (plan-approval) first");
    assert.equal(parsed.decisions[1].id, a.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list --kind filters; --since filters by createdAt", () => {
  const dir = ws();
  try {
    seed(dir);
    const byKind = JSON.parse(run(dir, ["list", "--kind", "plan-approval", "--json"]).stdout);
    assert.equal(byKind.decisions.length, 1);
    assert.equal(byKind.decisions[0].kind, "plan-approval");

    const since = JSON.parse(
      run(dir, ["list", "--since", "2026-07-02T00:00:00.000Z", "--json"]).stdout
    );
    assert.equal(since.decisions.length, 1, "only the plan-approval is >= the since date");
    assert.equal(since.decisions[0].kind, "plan-approval");

    assert.notEqual(
      run(dir, ["list", "--since", "not-a-date"]).code,
      0,
      "invalid --since rejected"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("show resolves an id prefix and returns the full record incl options + choice", () => {
  const dir = ws();
  try {
    const { a } = seed(dir);
    const shown = run(dir, ["show", a.id.slice(0, 8), "--json"]);
    assert.equal(shown.code, 0);
    const d = JSON.parse(shown.stdout);
    assert.equal(d.id, a.id);
    assert.equal(d.options.length, 2);
    assert.deepEqual(d.choice, ["Postgres"]);
    assert.equal(d.outcome, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outcome annotates a decision (append) and show/export reflect it", () => {
  const dir = ws();
  try {
    const { a } = seed(dir);
    const out = run(dir, [
      "outcome",
      a.id.slice(0, 8),
      "chose",
      "Postgres,",
      "worked",
      "well",
      "--json",
    ]);
    assert.equal(out.code, 0);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.id, a.id);
    assert.equal(parsed.outcome, "chose Postgres, worked well");

    const shown = JSON.parse(run(dir, ["show", a.id, "--json"]).stdout);
    assert.equal(shown.outcome, "chose Postgres, worked well");
    assert.ok(shown.outcomeAt, "outcomeAt stamped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("export emits a JSON array (oldest first) — the training-corpus read path, --json or not", () => {
  const dir = ws();
  try {
    const { a, b } = seed(dir);
    for (const args of [["export"], ["export", "--json"]]) {
      const res = run(dir, args);
      assert.equal(res.code, 0);
      const arr = JSON.parse(res.stdout);
      assert.ok(Array.isArray(arr), "export is a bare JSON array");
      assert.equal(arr.length, 2);
      assert.equal(arr[0].id, a.id, "oldest first");
      assert.equal(arr[1].id, b.id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("error codes: no subcommand, unknown id, outcome missing text", () => {
  const dir = ws();
  try {
    seed(dir);
    assert.notEqual(run(dir, []).code, 0, "no subcommand → usage die");
    assert.notEqual(run(dir, ["show", "does-not-exist"]).code, 0, "unknown id → exit 1");
    assert.notEqual(run(dir, ["outcome", "does-not-exist", "x"]).code, 0, "unknown id → exit 1");
    const { a } = seed(dir);
    void a;
    assert.notEqual(run(dir, ["outcome", "abc"]).code, 0, "outcome without text → usage die");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list on an empty store → 0 decisions, exit 0 (offline, no aios.yaml)", () => {
  const dir = ws();
  try {
    const res = run(dir, ["list", "--json"]);
    assert.equal(res.code, 0);
    assert.equal(JSON.parse(res.stdout).decisions.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
