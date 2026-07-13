import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AIO-364 — the three-home task split (3-log/tasks-team.md, 3-log/tasks-private.md,
 * 5-personal/tasks.md) and the two safety nets that go with it:
 *
 *  1. Task-key resolution (`aios work done <key>`) must search ALL known homes, not just
 *     one hardcoded 3-log/tasks.md path — otherwise `work done` silently fails to find a
 *     key that lives in tasks-private.md or 5-personal/tasks.md.
 *  2. `aios work done <key> --push` must refuse loudly (non-zero exit, no PM/brain event)
 *     when the file it just edited couldn't actually reach the brain (tier-blocked) —
 *     never fire a "done" event for content that never left the machine.
 *  3. `aios status`/`aios push` must print a headline warning when a sync_include-
 *     whitelisted, loop-critical file (tasks-team.md/tasks.md/decision-log.md) is ALSO
 *     tier-blocked — that's the exact silent-drift shape the real dogfood bug took.
 */

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const TEST_KEY = "aios_tasktier_secret-value";
const TEST_TEAM = "test-team";

function fm(fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function taskTable(rows, cols = ["ID", "Task", "Status", "Sprint", "Due", "Notes"]) {
  const header = `| ${cols.join(" | ")} |`;
  const sep = `|${cols.map(() => "----").join("|")}|`;
  const body = rows.map((r) => `| ${cols.map((c) => r[c] ?? "").join(" | ")} |`).join("\n");
  return `${header}\n${sep}\n${body}\n`;
}

function startStubBrain() {
  const requestsLog = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      requestsLog.push({ method: req.method, path: url.pathname });
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const auth = req.headers["authorization"] || "";
      const team = req.headers["x-aios-team"] || "";
      if (auth !== `Bearer ${TEST_KEY}` || team !== TEST_TEAM) {
        send(401, { error: { code: "unauthorized", message: "bad auth", request_id: "r-401" } });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/items") {
        const item = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        send(201, { status: "created", id: "item-1", access: item.access });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/work-events") {
        send(200, { applied: ["ok"], unresolved: [] });
        return;
      }
      send(404, { error: { code: "not_found", message: "no such route", request_id: "r-404" } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requestsLog,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function runAios(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AIOS, ...args], {
      cwd,
      env: { ...process.env, AIOS_API_KEY: TEST_KEY, AIOS_MEMBER: "smoke-bot" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function baseYaml(brainUrl, syncInclude) {
  return (
    [
      "version: 1",
      `brain_url: "${brainUrl}"`,
      `team_id: "${TEST_TEAM}"`,
      "member: smoke-bot",
      "sync_tiers:",
      "  - team",
      "sync_include:",
      ...syncInclude.map((s) => `  - ${s}`),
    ].join("\n") + "\n"
  );
}

test("multi-home task lookup: a key living only in 3-log/tasks-private.md is found by `aios work done`", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-tasktier-"));
  try {
    mkdirSync(path.join(dir, "3-log"), { recursive: true });
    writeFileSync(
      path.join(dir, "aios.yaml"),
      baseYaml("", ["3-log/tasks-team.md"]) // tasks-private.md deliberately NOT whitelisted
    );
    // A team-tier file also present, to prove lookup doesn't just fall back to it.
    writeFileSync(
      path.join(dir, "3-log", "tasks-team.md"),
      fm({ access: "team", type: "Task List" }) +
        taskTable(
          [{ ID: "TT1", Task: "team thing", Status: "Todo" }],
          ["ID", "Task", "Assignee", "Status", "Sprint", "Due", "Linear"]
        )
    );
    writeFileSync(
      path.join(dir, "3-log", "tasks-private.md"),
      fm({ access: "private", type: "Task List" }) +
        taskTable([{ ID: "TP1", Task: "private thing", Status: "Todo" }])
    );

    const r = await runAios(["work", "done", "TP1"], dir);
    // no --push: offline-safe, must succeed and edit tasks-private.md in place.
    assert.equal(r.code, 0, `expected success, got:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /3-log\/tasks-private\.md/);

    const content = readFileSync(path.join(dir, "3-log", "tasks-private.md"), "utf8");
    assert.match(content, /\|\s*TP1\s*\|\s*private thing\s*\|\s*done\s*\|/);

    // tasks-team.md must be untouched.
    const teamContent = readFileSync(path.join(dir, "3-log", "tasks-team.md"), "utf8");
    assert.match(teamContent, /\|\s*TT1\s*\|.*\|\s*Todo\s*\|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`aios work done <key> --push` refuses loudly and does NOT fire a work event when the file is tier-blocked", async () => {
  const stub = await startStubBrain();
  const dir = mkdtempSync(path.join(tmpdir(), "aios-tasktier-blocked-"));
  try {
    mkdirSync(path.join(dir, "3-log"), { recursive: true });
    // Misconfigured exactly like the real dogfood bug: whitelisted in sync_include, but
    // the file's own frontmatter is access: private (tier-blocked).
    writeFileSync(path.join(dir, "aios.yaml"), baseYaml(stub.url, ["3-log/tasks-team.md"]));
    writeFileSync(
      path.join(dir, "3-log", "tasks-team.md"),
      fm({ access: "private", type: "Task List" }) +
        taskTable(
          [{ ID: "TT1", Task: "blocked thing", Status: "Todo" }],
          ["ID", "Task", "Assignee", "Status", "Sprint", "Due", "Linear"]
        )
    );

    const r = await runAios(["work", "done", "TT1", "--push"], dir);
    assert.notEqual(r.code, 0, `expected non-zero exit, got 0:\n${r.stdout}`);
    assert.match(r.stderr, /did not reach the Team Brain/);
    assert.match(r.stderr, /refusing to fire a work\/PM event/);

    // The local edit itself still happened (status is set to done locally)...
    const content = readFileSync(path.join(dir, "3-log", "tasks-team.md"), "utf8");
    assert.match(content, /\|\s*TT1\s*\|.*\|\s*done\s*\|/);

    // ...but nothing about it ever reached the brain: no /items POST, no /work-events POST.
    assert.ok(
      !stub.requestsLog.some((l) => l.method === "POST" && l.path === "/api/v1/items"),
      `unexpected /items POST: ${JSON.stringify(stub.requestsLog)}`
    );
    assert.ok(
      !stub.requestsLog.some((l) => l.method === "POST" && l.path === "/api/v1/work-events"),
      `unexpected /work-events POST: ${JSON.stringify(stub.requestsLog)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test("headline tier-block warning: a sync_include-whitelisted loop-critical file triggers it; an ordinary blocked file does not", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-tasktier-warn-"));
  try {
    mkdirSync(path.join(dir, "3-log"), { recursive: true });
    mkdirSync(path.join(dir, "2-work"), { recursive: true });
    writeFileSync(path.join(dir, "aios.yaml"), baseYaml("", ["3-log/tasks-team.md", "2-work"]));
    // loop-critical + whitelisted + tier-blocked → headline.
    writeFileSync(
      path.join(dir, "3-log", "tasks-team.md"),
      fm({ access: "private", type: "Task List" }) +
        taskTable(
          [{ ID: "TT1", Task: "x", Status: "Todo" }],
          ["ID", "Task", "Assignee", "Status", "Sprint", "Due", "Linear"]
        )
    );
    // ordinary blocked file (whitelisted dir, but not loop-critical filename) → no headline.
    writeFileSync(
      path.join(dir, "2-work", "notes.md"),
      fm({ access: "private" }) + "# scratch notes, also tier-blocked\n"
    );

    const out = execFileSync("node", [AIOS, "status", "--repo", dir], {
      cwd: REPO,
      encoding: "utf8",
    });
    assert.match(
      out,
      /⚠ 3-log\/tasks-team\.md is whitelisted for sync but tier-blocked \(access: private\) — PM projection is disabled/
    );
    // The ordinary blocked file must still show up in the normal blocked list...
    assert.match(out, /2-work\/notes\.md/);
    // ...but must not itself get a headline warning line.
    assert.doesNotMatch(out, /⚠ 2-work\/notes\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
