#!/usr/bin/env node
// test/linear-merge-nudge.test.mjs — identifier extraction + reconciliation decision logic for
// the post-merge Linear nudge (scripts/linear-merge-nudge.mjs). Zero-network: a fake fetch
// replays fixtures. Run: node test/linear-merge-nudge.test.mjs

import {
  extractAioIds,
  getIssueState,
  isResolvedStateType,
  buildNudgeComment,
  computeNudges,
  LINEAR_API_URL,
} from "../scripts/linear-merge-nudge.mjs";

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

const FAKE_KEY = "test-linear-key-fake";

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}

console.log("extractAioIds");
{
  check(
    "extracts a single id from title",
    JSON.stringify(extractAioIds("fix(cli): thing (AIO-42)")) === JSON.stringify(["AIO-42"])
  );
  check(
    "extracts from both title and branch, de-duplicated",
    JSON.stringify(extractAioIds("AIO-9: feat", "feat/AIO-9-x")) === JSON.stringify(["AIO-9"])
  );
  check(
    "extracts multiple distinct ids across sources",
    JSON.stringify(extractAioIds("AIO-1 and AIO-2", "feat/AIO-3")) ===
      JSON.stringify(["AIO-1", "AIO-2", "AIO-3"])
  );
  check("no id → empty array", extractAioIds("chore: bump deps", "chore/bump-deps").length === 0);
  check(
    "does not match other team prefixes",
    JSON.stringify(extractAioIds("W2.5.8 something", "")) === JSON.stringify([])
  );
}

console.log("isResolvedStateType");
{
  check("completed is resolved", isResolvedStateType("completed") === true);
  check("canceled is resolved", isResolvedStateType("canceled") === true);
  check("started is not resolved", isResolvedStateType("started") === false);
  check("unstarted is not resolved", isResolvedStateType("unstarted") === false);
  check("backlog is not resolved", isResolvedStateType("backlog") === false);
}

console.log("buildNudgeComment");
{
  const body = buildNudgeComment("AIO-42", "In Progress");
  check("mentions the identifier", body.includes("AIO-42"));
  check("mentions the current state", body.includes("In Progress"));
  check("gives an actionable instruction", /update the Linear board/i.test(body));
}

console.log("getIssueState — request shape + normalization");
{
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      data: {
        issues: { nodes: [{ identifier: "AIO-42", state: { name: "Todo", type: "unstarted" } }] },
      },
    });
  };
  const state = await getIssueState("AIO-42", { apiKey: FAKE_KEY, fetchFn });
  const { url, init } = calls[0];
  check("POST to LINEAR_API_URL", url === LINEAR_API_URL && init.method === "POST");
  check("Authorization is the RAW key (no Bearer)", init.headers.Authorization === FAKE_KEY);
  const body = JSON.parse(init.body);
  check("AIO-42 → team AIO + number 42", body.variables.key === "AIO" && body.variables.num === 42);
  check("normalizes state", state.identifier === "AIO-42" && state.type === "unstarted");
}

console.log("getIssueState — not found");
{
  const fetchFn = async () => jsonResponse({ data: { issues: { nodes: [] } } });
  const state = await getIssueState("AIO-999", { apiKey: FAKE_KEY, fetchFn });
  check("returns null when Linear has no matching issue", state === null);
}

console.log("getIssueState — HTTP error surfaces, no retry");
{
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return jsonResponse({}, { ok: false, status: 500 });
  };
  let threw = false;
  try {
    await getIssueState("AIO-1", { apiKey: FAKE_KEY, fetchFn });
  } catch (e) {
    threw = /Linear HTTP 500/.test(e.message);
  }
  check("throws on HTTP 500", threw);
  check("does not retry (single call)", calls === 1);
}

console.log("getIssueState — invalid identifier throws before any request");
{
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return jsonResponse({});
  };
  let threw = false;
  try {
    await getIssueState("not-an-id", { apiKey: FAKE_KEY, fetchFn });
  } catch {
    threw = true;
  }
  check("throws for malformed identifier", threw);
  check("never calls fetch", calls === 0);
}

console.log("computeNudges — no ids referenced");
{
  const result = await computeNudges({
    title: "chore: bump deps",
    branch: "chore/bump-deps",
    apiKey: FAKE_KEY,
    fetchFn: async () => jsonResponse({ data: { issues: { nodes: [] } } }),
  });
  check("ids empty", result.ids.length === 0);
  check("stale empty", result.stale.length === 0);
}

console.log("computeNudges — referenced issue already Done → no nudge");
{
  const fetchFn = async () =>
    jsonResponse({
      data: {
        issues: { nodes: [{ identifier: "AIO-7", state: { name: "Done", type: "completed" } }] },
      },
    });
  const result = await computeNudges({
    title: "feat: ship AIO-7",
    branch: "feat/AIO-7-ship",
    apiKey: FAKE_KEY,
    fetchFn,
  });
  check("one id found", JSON.stringify(result.ids) === JSON.stringify(["AIO-7"]));
  check("no stale entries", result.stale.length === 0);
  check("no not-found entries", result.notFound.length === 0);
}

console.log("computeNudges — referenced issue still open → nudge");
{
  const fetchFn = async () =>
    jsonResponse({
      data: {
        issues: {
          nodes: [{ identifier: "AIO-7", state: { name: "In Progress", type: "started" } }],
        },
      },
    });
  const result = await computeNudges({
    title: "feat: ship AIO-7",
    branch: "feat/AIO-7-ship",
    apiKey: FAKE_KEY,
    fetchFn,
  });
  check("stale carries the identifier + state name", result.stale[0].identifier === "AIO-7");
  check("stale state name is In Progress", result.stale[0].stateName === "In Progress");
}

console.log("computeNudges — issue not found in Linear is reported separately, not stale");
{
  const fetchFn = async () => jsonResponse({ data: { issues: { nodes: [] } } });
  const result = await computeNudges({
    title: "feat: ship AIO-9999",
    branch: "feat/AIO-9999-ship",
    apiKey: FAKE_KEY,
    fetchFn,
  });
  check("not found, not stale", result.stale.length === 0 && result.notFound[0] === "AIO-9999");
}

console.log("computeNudges — multiple ids, mixed resolution");
{
  const states = {
    "AIO-1": { name: "Done", type: "completed" },
    "AIO-2": { name: "In Review", type: "started" },
  };
  const fetchFn = async (url, init) => {
    const { variables } = JSON.parse(init.body);
    const id = `${variables.key}-${variables.num}`;
    const s = states[id];
    return jsonResponse({ data: { issues: { nodes: s ? [{ identifier: id, state: s }] : [] } } });
  };
  const result = await computeNudges({
    title: "feat: AIO-1 and AIO-2",
    branch: "feat/multi",
    apiKey: FAKE_KEY,
    fetchFn,
  });
  check("both ids captured", result.ids.length === 2);
  check("only AIO-2 is stale", result.stale.length === 1 && result.stale[0].identifier === "AIO-2");
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll checks passed.");
}
