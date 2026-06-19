#!/usr/bin/env node
// test/analyze-multitool.test.mjs — Phase 2 parsers: Codex rollout records and
// Cursor bubble rows → NormalizedEvent. Synthetic inline fixtures (no real data).
// Key checks: Codex user_message→task, token_count→usage with the cached-token
// subtraction (in = fresh), function_call→tool_use; Cursor type 1/2 mapping,
// tool extraction, text-length prompt gating, composerId→session_id.
//
// Zero network, zero deps. Run: node test/analyze-multitool.test.mjs

import { recordsToEvents as codexEvents } from "../scripts/analyze/parse-codex.mjs";
import { rowsToEvents as cursorEvents } from "../scripts/analyze/parse-cursor.mjs";
import { computeSignals } from "../scripts/analyze/metrics.mjs";

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
// ── Codex ───────────────────────────────────────────────────────────────────
console.log("parse-codex");
const CODEX = [
  {
    type: "session_meta",
    timestamp: "2026-06-10T10:00:00Z",
    payload: { id: "cdx1", cwd: "/home/me/proj", git: { branch: "master" } },
  },
  {
    type: "turn_context",
    timestamp: "2026-06-10T10:00:01Z",
    payload: { model: "gpt-5.2-codex", cwd: "/home/me/proj" },
  },
  {
    type: "event_msg",
    timestamp: "2026-06-10T10:00:02Z",
    payload: { type: "user_message", message: "do the thing" },
  },
  {
    type: "response_item",
    timestamp: "2026-06-10T10:00:03Z",
    payload: { type: "function_call", name: "exec_command", arguments: "{}" },
  },
  {
    type: "response_item",
    timestamp: "2026-06-10T10:00:04Z",
    payload: { type: "function_call_output", call_id: "c1", output: "ok" },
  },
  {
    type: "event_msg",
    timestamp: "2026-06-10T10:00:05Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 20000,
          cached_input_tokens: 12000,
          output_tokens: 400,
          reasoning_output_tokens: 100,
        },
      },
    },
  },
];
const cev = codexEvents(CODEX, "cdx1");
{
  const tokenEv = cev.find((e) => e.tokens);
  check(
    "session_meta sets session_id + branch + project",
    cev.every((e) => e.session_id === "cdx1") &&
      cev.some((e) => e.git_branch === "master" && e.project === "proj")
  );
  check(
    "turn_context sets model",
    cev.some((e) => e.model === "gpt-5.2-codex")
  );
  check(
    "user_message → one task root",
    cev.filter((e) => e.actor === "user" && e.block_type === "text").length === 1
  );
  check(
    "function_call → tool_use (exec_command)",
    cev.some((e) => e.block_type === "tool_use" && e.tool_name === "exec_command")
  );
  check(
    "function_call_output → tool_result",
    cev.some((e) => e.block_type === "tool_result")
  );
  check(
    "token_count → usage with cached subtracted (in = 20000-12000 = 8000)",
    tokenEv && tokenEv.tokens.in === 8000
  );
  check("cached → cache_read (12000)", tokenEv && tokenEv.tokens.cache_read === 12000);
  check("reasoning folded into output (400+100 = 500)", tokenEv && tokenEv.tokens.out === 500);
  const sig = computeSignals(cev);
  check(
    "Codex has no subagents (delegation 0)",
    sig.delegation_ratio === 0 && sig.subagent_usage === 0
  );
  check("exec_command counts as a verify tool", sig.verify_tool_rate === 1);
}

// ── Cursor ──────────────────────────────────────────────────────────────────
console.log("parse-cursor");
const CURSOR_ROWS = [
  {
    key: "bubbleId:comp-A:b1",
    type: 1,
    created: "2026-06-10T10:00:00Z",
    in_tok: 0,
    out_tok: 0,
    tool: null,
    text_len: 120,
  },
  {
    key: "bubbleId:comp-A:b2",
    type: 2,
    created: "2026-06-10T10:00:01Z",
    in_tok: 0,
    out_tok: 0,
    tool: "run_terminal_cmd",
    text_len: 0,
  },
  {
    key: "bubbleId:comp-A:b3",
    type: 2,
    created: "2026-06-10T10:00:02Z",
    in_tok: 300,
    out_tok: 150,
    tool: null,
    text_len: 200,
  },
  {
    key: "bubbleId:comp-A:b4",
    type: 1,
    created: "2026-06-10T10:00:03Z",
    in_tok: 0,
    out_tok: 0,
    tool: null,
    text_len: 0,
  }, // empty → not a task
  {
    key: "bubbleId:comp-B:b5",
    type: 2,
    created: "2026-06-10T10:00:04Z",
    in_tok: 0,
    out_tok: 0,
    tool: "read_file",
    text_len: 0,
  },
];
const cur = cursorEvents(CURSOR_ROWS);
{
  check(
    "type 1 with text → task root",
    cur.filter((e) => e.actor === "user" && e.block_type === "text").length === 1
  );
  check(
    "empty user bubble (text_len 0) is NOT a task",
    cur.filter((e) => e.actor === "user").length === 1
  );
  check(
    "type 2 + tool → tool_use with name",
    cur.some((e) => e.block_type === "tool_use" && e.tool_name === "run_terminal_cmd")
  );
  check(
    "type 2 with tokens → usage event (in 300)",
    cur.some((e) => e.tokens && e.tokens.in === 300)
  );
  check("composerId → session_id (two sessions)", new Set(cur.map((e) => e.session_id)).size === 2);
  check(
    "all events tagged tool 'cursor'",
    cur.every((e) => e.tool === "cursor")
  );
  const sig = computeSignals(cur);
  check(
    "tool diversity spans run_terminal_cmd + read_file across sessions",
    sig.tool_diversity > 0
  );
  check(
    "Cursor null model degrades gracefully (cost computed, no crash)",
    Number.isFinite(sig.cost_per_task)
  );
}

console.log("================================================");
if (failed === 0) {
  console.log(`${GREEN}analyze-multitool tests PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}analyze-multitool tests FAILED — ${failed} assertion(s)${NC}`);
process.exit(1);
