#!/usr/bin/env node
// test/analyze.test.mjs — the `aios analyze` pipeline: Claude JSONL → normalized
// events → signals → AEM placement. Synthetic inline fixtures (no real session
// data, per CLAUDE.md §5). Covers: parser record-shaping, token/tool signals, and
// the rubric's core rule — Spine is capped at L3 when Verification ≤ 1.
//
// Zero network, zero deps. Run: node test/analyze.test.mjs

import { parseClaude, recordsToEvents } from "../scripts/analyze/parse-claude.mjs";
import { computeSignals, bucketByDay } from "../scripts/analyze/metrics.mjs";
import { scoreAxes, spineLevel, placement } from "../scripts/analyze/aem.mjs";
import { makeEvent, normalizeTokens, totalTokens } from "../scripts/analyze/normalize.mjs";

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
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// ── fixtures ────────────────────────────────────────────────────────────────
// A tiny session: one human prompt → assistant turn (usage) that calls Bash →
// a tool_result → a second assistant turn. Plus a subagent (isSidechain) turn.
const usage = (o) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...o,
});
const SESSION = [
  {
    type: "user",
    sessionId: "s1",
    uuid: "u1",
    parentUuid: null,
    timestamp: "2026-06-10T10:00:00Z",
    cwd: "/home/me/proj",
    message: { role: "user", content: "please run the tests" },
  },
  {
    type: "assistant",
    sessionId: "s1",
    uuid: "a1",
    parentUuid: "u1",
    timestamp: "2026-06-10T10:00:05Z",
    gitBranch: "main",
    cwd: "/home/me/proj",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      usage: usage({
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 200,
      }),
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", name: "Bash" },
      ],
    },
  },
  {
    type: "user",
    sessionId: "s1",
    uuid: "u2",
    parentUuid: "a1",
    timestamp: "2026-06-10T10:00:09Z",
    message: { role: "user", content: [{ type: "tool_result", is_error: false }] },
  },
  {
    type: "assistant",
    sessionId: "s1",
    uuid: "a2",
    parentUuid: "u2",
    timestamp: "2026-06-10T10:00:12Z",
    gitBranch: "main",
    cwd: "/home/me/proj",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      usage: usage({ input_tokens: 500, output_tokens: 300, cache_read_input_tokens: 9000 }),
      content: [{ type: "text", text: "tests pass" }],
    },
  },
  // a subagent turn (delegation signal)
  {
    type: "assistant",
    sessionId: "s1",
    uuid: "a3",
    parentUuid: "a2",
    isSidechain: true,
    timestamp: "2026-06-10T10:00:20Z",
    cwd: "/home/me/proj",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      usage: usage({ input_tokens: 200, output_tokens: 100 }),
      content: [{ type: "tool_use", name: "Grep" }],
    },
  },
  // noise that must be ignored
  { type: "ai-title", sessionId: "s1", title: "x" },
  { type: "permission-mode", sessionId: "s1", uuid: "p1", timestamp: "2026-06-10T10:00:01Z" },
];

console.log("normalize");
{
  check("normalizeTokens drops all-zero record", normalizeTokens(usage({})) === null);
  check(
    "normalizeTokens maps long keys → short",
    normalizeTokens(usage({ input_tokens: 5 })).in === 5
  );
  check(
    "totalTokens sums four buckets",
    totalTokens({ in: 1, out: 2, cache_read: 3, cache_create: 4 }) === 10
  );
  check(
    "makeEvent rejects bad tool",
    (() => {
      try {
        makeEvent({ tool: "nope" });
        return false;
      } catch {
        return true;
      }
    })()
  );
  check(
    "makeEvent defaults actor to assistant",
    makeEvent({ tool: "claude" }).actor === "assistant"
  );
}

console.log("parse-claude");
const events = recordsToEvents(SESSION, "s1");
{
  const userText = events.filter((e) => e.actor === "user" && e.block_type === "text");
  const toolUses = events.filter((e) => e.block_type === "tool_use");
  const toolResults = events.filter((e) => e.block_type === "tool_result");
  const subagent = events.filter((e) => e.actor === "subagent");
  const tokenEvents = events.filter((e) => e.tokens);
  check("one human prompt event (task root)", userText.length === 1);
  check(
    "tool_use events captured with names",
    toolUses.length === 2 && toolUses.some((t) => t.tool_name === "Bash")
  );
  check("tool_result event captured (not a task root)", toolResults.length === 1);
  check(
    "isSidechain → subagent actor (turn + its tool_use)",
    subagent.length === 2 && subagent.some((e) => e.tool_name === "Grep")
  );
  check(
    "permission-mode → permission event",
    events.some((e) => e.block_type === "permission")
  );
  check(
    "ai-title noise ignored",
    !events.some((e) => e.block_type === "meta" && e.tool_name === "x")
  );
  check("usage attached once per assistant turn (3 token events)", tokenEvents.length === 3);
  check(
    "git branch + project threaded through",
    events.some((e) => e.git_branch === "main" && e.project === "proj")
  );
  check(
    "parseClaude(text) parity with records path",
    parseClaude(SESSION.map((r) => JSON.stringify(r)).join("\n"), "s1").length === events.length
  );
}

console.log("metrics");
const sig = computeSignals(events);
{
  check("tasks = human prompts", sig.tasks === 1);
  check("sessions counted", sig.sessions === 1);
  check("delegation ratio > 0 (subagent tokens present)", sig.delegation_ratio > 0);
  check("subagent usage = 1 (session has a subagent)", approx(sig.subagent_usage, 1));
  check("correction-loop avg = tool_results/tasks = 1", approx(sig.correction_loop_avg, 1));
  check("verify-tool rate = Bash / all tool_use = 0.5", approx(sig.verify_tool_rate, 0.5));
  // work tokens = sum(in+out+cache_create) = (1000+500+200)+(500+300+0)+(200+100+0) = 2800
  check("tokens_per_task uses fresh tokens (=2800)", approx(sig.tokens_per_task, 2800));
  // cache-hit = cache_read / (cache_read + in + cache_create) = 17000 / (17000+1700+200)
  check(
    "cache-hit excludes accumulated reads from denom",
    approx(sig.cache_hit_rate, 17000 / (17000 + 1700 + 200))
  );
  check("bucketByDay groups by UTC day", bucketByDay(events).has("2026-06-10"));
}

console.log("aem — scoring + the verification gate");
{
  // A strong-everything signal set, but Verification at floor → must cap at L3.
  const strong = {
    verify_tool_rate: 0,
    cache_hit_rate: 0.8,
    delegation_ratio: 0.3,
    subagent_usage: 0.5,
    tool_diversity: 8,
    tokens_per_task: 10_000,
    permission_events: 5,
    correction_loop_avg: 1,
    error_rate: 0,
  };
  const axesWeakVerify = scoreAxes(strong);
  check("verification scores 0 when no verify tools", axesWeakVerify.verification === 0);
  check(
    "GATE: Spine capped at L3 when verification ≤ 1",
    spineLevel(axesWeakVerify, strong) === "L3"
  );

  // Same but with strong verification → may climb past L3.
  const strongVerify = { ...strong, verify_tool_rate: 0.3 };
  const axes2 = scoreAxes(strongVerify);
  check("verification scores 4 at high verify-tool rate", axes2.verification === 4);
  const lvl = spineLevel(axes2, strongVerify);
  check("climbs to L4 or L5 once verification present", lvl === "L4" || lvl === "L5");

  const p = placement(strongVerify);
  check(
    "placement returns axes + spine + overall + weakest",
    !!p.axes && !!p.spine && typeof p.overall === "number" && !!p.weakest
  );
  check(
    "learning axis capped at 3 (proxy limitation)",
    scoreAxes({ ...strong, tool_diversity: 50 }).learning === 3
  );
}

console.log("================================================");
if (failed === 0) {
  console.log(`${GREEN}analyze tests PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}analyze tests FAILED — ${failed} assertion(s)${NC}`);
process.exit(1);
