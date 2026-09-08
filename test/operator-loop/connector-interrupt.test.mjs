import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pullDailyConnectors } from "../../dist/operator-loop/connectors.js";
import { collectSlackUnread } from "../../scripts/connectors/slack/activity.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const mode of ["SIGINT", "SIGTERM", "exit"]) {
  test(
    `daily ${mode} stops the real shim and resistant delegates`,
    { skip: process.platform === "win32", timeout: 15000 },
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "connector-interrupt-"));
      const workspace = path.join(root, "workspace"),
        toolkit = path.join(root, "toolkit");
      let parent;
      try {
        for (const dir of [workspace, toolkit])
          mkdirSync(path.join(dir, "scripts"), { recursive: true });
        copyFileSync(
          path.join(ROOT, "scaffold/scripts/aios.mjs"),
          path.join(workspace, "scripts/aios.mjs")
        );
        writeFileSync(
          path.join(toolkit, "scripts/aios.mjs"),
          `
import { writeFileSync } from "node:fs";
process.on("SIGINT", () => {}); process.on("SIGTERM", () => {});
const name = process.argv[2];
writeFileSync(${JSON.stringify(root)} + "/started-" + name, JSON.stringify({ pid: process.pid, shim: process.ppid }));
setInterval(() => writeFileSync(${JSON.stringify(root)} + "/activity-" + name, String(Date.now())), 50);
`
        );
        const runner = path.join(root, "runner.mjs");
        writeFileSync(
          runner,
          `
import { pullDailyConnectors } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "dist/operator-loop/connectors.js")).href)};
process.stdin.once("data", () => process.exit(17));
await pullDailyConnectors({ root: ${JSON.stringify(workspace)}, timeouts: { slack: 30000, linear: 30000 } });
`
        );
        parent = spawn(process.execPath, [runner], {
          stdio: ["pipe", "ignore", "ignore"],
          env: { HOME: root, PATH: process.env.PATH, AIOS_TOOLKIT_DIR: toolkit },
        });
        const ended = new Promise((resolve) =>
          parent.once("close", (code, signal) => resolve({ code, signal }))
        );
        const deadline = Date.now() + 5000;
        while (
          !["slack", "linear"].every((name) => existsSync(path.join(root, "activity-" + name)))
        ) {
          assert.ok(
            Date.now() < deadline,
            "both delegates must positively start before interruption"
          );
          await pause(25);
        }
        if (mode === "exit") parent.stdin.end("stop");
        else parent.kill(mode);
        const result = await ended;
        assert.deepEqual(
          result,
          mode === "exit" ? { code: 17, signal: null } : { code: null, signal: mode }
        );
        await pause(150);
        const bytes = ["slack", "linear"].map((name) =>
          readFileSync(path.join(root, "activity-" + name), "utf8")
        );
        await pause(300);
        for (const [index, name] of ["slack", "linear"].entries()) {
          assert.equal(
            readFileSync(path.join(root, "activity-" + name), "utf8"),
            bytes[index],
            "no post-interrupt activity writes"
          );
          const { pid, shim } = JSON.parse(
            readFileSync(path.join(root, "started-" + name), "utf8")
          );
          for (const ownedPid of [pid, shim])
            assert.throws(() => process.kill(ownedPid, 0), { code: "ESRCH" });
        }
      } finally {
        parent?.kill("SIGKILL");
        for (const name of ["slack", "linear"]) {
          const file = path.join(root, "started-" + name);
          if (!existsSync(file)) continue;
          const { shim } = JSON.parse(readFileSync(file, "utf8"));
          try {
            process.kill(-shim, "SIGKILL");
          } catch {
            /* already cleaned */
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
}

test("connector lifecycle hooks are removed after ordinary completion", async () => {
  const events = ["SIGINT", "SIGTERM", "exit"];
  const before = events.map((event) => process.listeners(event));
  const root = mkdtempSync(path.join(tmpdir(), "connector-hooks-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "scripts/aios.mjs"), "process.exit(0);");
    await pullDailyConnectors({ root, env: { HOME: root, PATH: process.env.PATH } });
    assert.deepEqual(
      events.map((event) => process.listeners(event)),
      before
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Slack unread pagination accepts valid empty pages and rejects cycles or endless unique pages", async () => {
  for (const cursors of [["a", "a"], ["a", "b", "a"], null]) {
    let calls = 0;
    await assert.rejects(
      collectSlackUnread({
        call: async (method) => {
          if (method === "auth.test") return { user_id: "ME" };
          assert.equal(method, "conversations.list");
          assert.ok(calls < 1001, "pagination must stop itself");
          const cursor = cursors ? cursors[Math.min(calls, cursors.length - 1)] : String(calls);
          calls++;
          return { channels: [], response_metadata: { next_cursor: cursor } };
        },
      }),
      (error) => error.code === "AIOS_E_PROVIDER" && /pagination/.test(error.message)
    );
    assert.equal(calls, cursors ? cursors.length : 1000);
  }
  let calls = 0;
  const result = await collectSlackUnread({
    call: async (method) => {
      if (method === "auth.test") return { user_id: "ME" };
      calls++;
      return calls === 1
        ? { channels: [], response_metadata: { next_cursor: "next" } }
        : { channels: [{ id: "C1" }] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.conversations, 1);
});
