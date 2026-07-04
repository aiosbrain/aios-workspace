#!/usr/bin/env node
// test/roadmap-epic-guard.test.mjs — the leaf-epic misconfiguration guard. `--epic <child>`
// once produced an empty 0/N digest with exit 0 (a real run targeted AIO-145 instead of its
// parent AIO-122). Zero sub-issues on an epic source must fail loudly with the parent
// suggestion, while a REAL childless epic (no parent) stays a legitimate zero-work run.
// Run: node test/roadmap-epic-guard.test.mjs

import { cmdRoadmapRun, explainEmptyEpic } from "../scripts/roadmap-run.mjs";

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

function withStderr(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  const restore = () => (console.error = orig);
  return fn(lines).finally(restore);
}

const baseDeps = (linear, extra = {}) => ({
  linear,
  spawnShip: () => {
    throw new Error("spawnShip must not be called");
  },
  gitExec: () => ({ ok: true }),
  writeDigest: () => "/tmp/digest.md",
  callDigestAgent: async () => {
    throw new Error("no model");
  },
  now: () => new Date("2026-07-04T00:00:00Z"),
  ...extra,
});

console.log("explainEmptyEpic");
{
  const leaf = {
    getIssue: async () => ({ identifier: "AIO-145", parent: { identifier: "AIO-122" } }),
  };
  const why = await explainEmptyEpic(leaf, "AIO-145");
  check("names the parent", /child of AIO-122/.test(why));
  check("suggests the corrected command", /--epic AIO-122/.test(why));

  const childlessEpic = { getIssue: async () => ({ identifier: "AIO-9", parent: null }) };
  check("real childless epic → null", (await explainEmptyEpic(childlessEpic, "AIO-9")) === null);

  check("client without getIssue → null", (await explainEmptyEpic({}, "AIO-1")) === null);

  const throwing = {
    getIssue: async () => {
      throw new Error("boom");
    },
  };
  check(
    "lookup failure → null, never throws",
    (await explainEmptyEpic(throwing, "AIO-1")) === null
  );
}

console.log("live run — leaf mistaken for epic fails loudly, ships nothing");
await withStderr(async (stderr) => {
  const linear = {
    listIssues: async () => [],
    getIssue: async () => ({ identifier: "AIO-145", parent: { identifier: "AIO-122" } }),
    addComment: async () => ({ ok: true }),
  };
  const code = await cmdRoadmapRun("/tmp/repo", ["--epic", "AIO-145"], baseDeps(linear));
  check("exit 1", code === 1);
  check(
    "stderr carries the parent suggestion",
    stderr.some((l) => /--epic AIO-122/.test(l))
  );
});

console.log("live run — REAL childless epic stays a legitimate zero-work run");
{
  const linear = {
    listIssues: async () => [],
    getIssue: async () => ({ identifier: "AIO-9", parent: null }),
    addComment: async () => ({ ok: true }),
  };
  const code = await cmdRoadmapRun(
    "/tmp/repo",
    ["--epic", "AIO-9"],
    baseDeps(linear, { spawnShip: () => 0 })
  );
  check("exit 0", code === 0);
}

console.log("dry-run — leaf mistaken for epic fails loudly");
await withStderr(async (stderr) => {
  const linear = {
    listIssues: async () => [],
    getIssue: async () => ({ identifier: "AIO-145", parent: { identifier: "AIO-122" } }),
  };
  const code = await cmdRoadmapRun("/tmp/repo", ["--epic", "AIO-145", "--dry-run"], { linear });
  check("exit 1", code === 1);
  check(
    "stderr carries the parent suggestion",
    stderr.some((l) => /--epic AIO-122/.test(l))
  );
});

console.log("label source with zero issues is untouched by the guard");
{
  const linear = {
    listIssues: async () => [],
    getIssue: async () => {
      throw new Error("must not be called for label sources");
    },
    addComment: async () => ({ ok: true }),
  };
  const code = await cmdRoadmapRun(
    "/tmp/repo",
    ["--label", "ship"],
    baseDeps(linear, { spawnShip: () => 0 })
  );
  check("exit 0", code === 0);
}

if (failed) {
  console.log(`${RED}${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`${GREEN}all checks passed${NC}`);
