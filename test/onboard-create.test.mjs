import test from "node:test";
import assert from "node:assert/strict";

import {
  RAILWAY_PLANS_URL,
  TEAM_BRAIN_DEPLOY_URL,
  openExternalUrl,
  runCreateFlow,
} from "../scripts/onboard-create.mjs";

function fakeClack() {
  const lines = [];
  const record = (level) => (message) => lines.push({ level, message });
  return {
    lines,
    clack: { log: { info: record("info"), warn: record("warn"), success: record("success") } },
  };
}

test("declining the external deploy leaves Create paused before browser launch", async () => {
  const { clack, lines } = fakeClack();
  let opened = false;
  const result = await runCreateFlow({
    clack,
    confirm: async () => false,
    openExternal: () => {
      opened = true;
      return true;
    },
  });
  assert.deepEqual(result, { resumeJoin: false, status: "declined" });
  assert.equal(opened, false);
  const output = lines.map((line) => line.message).join("\n");
  assert.match(output, /active plan/i);
  assert.match(output, new RegExp(RAILWAY_PLANS_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /not changed/i);
});

test("browser failure prints the exact fallback and a delayed deployment resumes later", async () => {
  const { clack, lines } = fakeClack();
  const answers = [true, false];
  const result = await runCreateFlow({
    clack,
    confirm: async () => answers.shift(),
    openExternal: () => false,
  });
  assert.deepEqual(result, { resumeJoin: false, status: "awaiting-deployment" });
  const output = lines.map((line) => line.message).join("\n");
  assert.match(output, new RegExp(TEAM_BRAIN_DEPLOY_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /choose Join/i);
});

test("a completed deployment resumes the existing Join path", async () => {
  const { clack } = fakeClack();
  const result = await runCreateFlow({
    clack,
    confirm: async () => true,
    openExternal: () => true,
  });
  assert.deepEqual(result, { resumeJoin: true, status: "ready" });
});

test("openExternalUrl maps macOS to the system opener", () => {
  const calls = [];
  const ok = openExternalUrl(TEAM_BRAIN_DEPLOY_URL, {
    platform: "darwin",
    exec: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls[0].slice(0, 2), ["open", [TEAM_BRAIN_DEPLOY_URL]]);
});
