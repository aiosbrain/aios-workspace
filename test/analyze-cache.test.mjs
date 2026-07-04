#!/usr/bin/env node
// test/analyze-cache.test.mjs — AIO-189: the per-file parse cache for
// `aios analyze`. Drives the REAL discovery+parse pipeline (collectEvents →
// buildResult) over a synthetic $HOME of claude/codex JSONL fixtures and
// byte-diffs the result JSON between the cold path (--no-cache) and the warm
// cache path. Covers: cold vs warm identity, unchanged-file reuse, offset
// tail-parse on append (incl. codex carry-forward ctx across the boundary and
// an unterminated last line completed later), mtime/size invalidation,
// version-mismatch + corrupt-entry fail-open, and the --no-cache flag.
//
// Synthetic inline fixtures only (no real session data, per CLAUDE.md §5).
// Zero network, zero deps. Run: node test/analyze-cache.test.mjs

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectEvents, buildResult, parseArgs } from "../scripts/analyze/index.mjs";
import { CACHE_VERSION, entryPath, loadEntry } from "../scripts/analyze/cache.mjs";
import { fileStat } from "../scripts/analyze/sources.mjs";

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

// ── synthetic $HOME with claude + codex transcripts ─────────────────────────
const tmp = mkdtempSync(path.join(os.tmpdir(), "aios-analyze-cache-"));
const home = path.join(tmp, "home");
const cacheDir = path.join(tmp, "cache");
const claudeDir = path.join(home, ".claude", "projects", "-home-me-proj");
const codexDir = path.join(home, ".codex", "sessions", "2026", "06", "10");
mkdirSync(claudeDir, { recursive: true });
mkdirSync(codexDir, { recursive: true });

const claudeFile = path.join(claudeDir, "s1.jsonl");
const codexFile = path.join(codexDir, "rollout-2026-06-10-cdx1.jsonl");

const usage = (o) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...o,
});
const claudeRecords = [
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
      usage: usage({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 8000 }),
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
];
const codexRecords = [
  {
    type: "session_meta",
    timestamp: "2026-06-10T11:00:00Z",
    payload: { id: "cdx1", cwd: "/home/me/proj", git: { branch: "master" } },
  },
  {
    type: "turn_context",
    timestamp: "2026-06-10T11:00:01Z",
    payload: { model: "gpt-5.2-codex", cwd: "/home/me/proj" },
  },
  {
    type: "event_msg",
    timestamp: "2026-06-10T11:00:02Z",
    payload: { type: "user_message", message: "do the thing" },
  },
];
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(claudeFile, jsonl(claudeRecords));
writeFileSync(codexFile, jsonl(codexRecords));

const TOOLS = ["claude", "codex"];
const since = new Date(0); // everything in-window; no mtime skip
const until = new Date("2026-06-11T00:00:00Z"); // frozen so result JSON is comparable

/** One full pipeline run → { json (bytes to diff), stats }. */
function run(cache) {
  const { events, cacheStats } = collectEvents({
    tools: TOOLS,
    home,
    sinceMs: since.getTime(),
    cache,
    cacheDir,
    warn: () => {},
  });
  const { result } = buildResult({ events, tools: TOOLS, since, until });
  return { json: JSON.stringify(result, null, 2), stats: cacheStats };
}

console.log("cold vs warm — byte-identical output");
{
  const cold = run(false);
  const warm1 = run(true); // populates the cache (misses)
  const warm2 = run(true); // pure cache hits
  check(
    "cold run parses without cache (stats untouched)",
    cold.stats.misses === 0 && cold.stats.hits === 0
  );
  check(
    "warm run 1 populates: one miss per file",
    warm1.stats.misses === 2 && warm1.stats.hits === 0
  );
  check(
    "warm run 2 is all hits (zero re-parse)",
    warm2.stats.hits === 2 && warm2.stats.misses === 0 && warm2.stats.appends === 0
  );
  check("cold vs warm-populate JSON byte-identical", cold.json === warm1.json);
  check("cold vs warm-hit JSON byte-identical", cold.json === warm2.json);
  check("result actually has content (tasks counted)", JSON.parse(cold.json).totals.tasks === 2);
}

console.log("append → tail-parse from the stored byte offset");
{
  const before = loadEntry(cacheDir, claudeFile);
  const beforeCodex = loadEntry(cacheDir, codexFile);
  // Grow both files. The codex append deliberately carries NO session_meta /
  // turn_context — its events are correct ONLY if the cached ctx (session id,
  // model, project set before the offset) was restored for the tail parse.
  appendFileSync(
    claudeFile,
    jsonl([
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
          usage: usage({ input_tokens: 500, output_tokens: 300 }),
          content: [{ type: "text", text: "tests pass" }],
        },
      },
    ])
  );
  appendFileSync(
    codexFile,
    jsonl([
      {
        type: "event_msg",
        timestamp: "2026-06-10T11:00:05Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 900, cached_input_tokens: 400, output_tokens: 50 },
          },
        },
      },
    ])
  );

  const warm = run(true);
  const cold = run(false);
  check(
    "append handled as tail-parse, not full re-parse",
    warm.stats.appends === 2 && warm.stats.misses === 0
  );
  check("cold vs warm JSON byte-identical after append", cold.json === warm.json);

  const after = loadEntry(cacheDir, claudeFile);
  check(
    "claude entry: offset advanced + events extended",
    after && before && after.offset > before.offset && after.events.length > before.events.length
  );
  const afterCodex = loadEntry(cacheDir, codexFile);
  const lastCodexEv = afterCodex && afterCodex.events[afterCodex.events.length - 1];
  check(
    "codex tail event inherited cached ctx (session id + model across the offset)",
    beforeCodex &&
      lastCodexEv &&
      lastCodexEv.session_id === "cdx1" &&
      lastCodexEv.model === "gpt-5.2-codex" &&
      lastCodexEv.tokens &&
      lastCodexEv.tokens.in === 500 // 900 − 400 cached, proving the real parser ran on the tail
  );
}

console.log("unterminated last line — deferred, then completed by a later append");
{
  const half = JSON.stringify(claudeRecords[0]);
  const cut = Math.floor(half.length / 2);
  appendFileSync(claudeFile, half.slice(0, cut)); // partial JSON, no newline
  const warmPartial = run(true);
  const coldPartial = run(false);
  check("partial trailing line: cold vs warm identical", coldPartial.json === warmPartial.json);
  const entry = loadEntry(cacheDir, claudeFile);
  check(
    "offset stops at the last newline (partial line not committed)",
    entry && entry.offset < fileStat(claudeFile).size
  );
  appendFileSync(claudeFile, half.slice(cut) + "\n"); // complete the line
  const warmDone = run(true);
  const coldDone = run(false);
  check(
    "completed line parsed exactly once (cold vs warm identical)",
    coldDone.json === warmDone.json
  );
  check(
    "completed line surfaced a third task",
    JSON.parse(warmDone.json).totals.tasks === 3 && warmDone.stats.appends >= 1
  );
}

console.log("invalidation — mtime change, shrink/rotate");
{
  // Same size, different mtime → content may have changed in place → full re-parse.
  utimesSync(claudeFile, new Date(), new Date(Date.now() + 5000));
  const warm = run(true);
  check("mtime change (same size) forces a full re-parse", warm.stats.misses >= 1);
  check("…and output still matches cold", warm.json === run(false).json);

  // Shrink (rotation): rewrite the file smaller.
  writeFileSync(codexFile, jsonl(codexRecords.slice(0, 2)));
  const warm2 = run(true);
  check("shrunk file forces a full re-parse", warm2.stats.misses >= 1);
  check("…and output still matches cold", warm2.json === run(false).json);
}

console.log("fail-open — corrupt entry, version mismatch");
{
  run(true); // settle the cache
  writeFileSync(entryPath(cacheDir, claudeFile), "{ not json !!!");
  const corrupt = run(true);
  check("corrupt cache entry → silent full re-parse", corrupt.stats.misses === 1);
  check("…byte-identical to cold", corrupt.json === run(false).json);

  const entry = loadEntry(cacheDir, codexFile);
  writeFileSync(
    entryPath(cacheDir, codexFile),
    JSON.stringify({ ...entry, version: CACHE_VERSION + 999, path: codexFile })
  );
  check("loadEntry rejects the mismatched version", loadEntry(cacheDir, codexFile) === null);
  const stale = run(true);
  check("version mismatch → full re-parse", stale.stats.misses === 1);
  check("…byte-identical to cold", stale.json === run(false).json);
}

console.log("--no-cache — bypasses the cache entirely");
{
  check("parseArgs maps --no-cache → noCache", parseArgs(["--no-cache"]).noCache === true);
  check("…and defaults to cached", parseArgs([]).noCache === false);
  const freshDir = path.join(tmp, "cache-untouched");
  const { cacheStats } = collectEvents({
    tools: TOOLS,
    home,
    sinceMs: 0,
    cache: false,
    cacheDir: freshDir,
    warn: () => {},
  });
  let entries = [];
  try {
    entries = readdirSync(freshDir);
  } catch {
    /* dir never created — also a pass */
  }
  check(
    "cache:false neither reads nor writes the cache",
    entries.length === 0 && cacheStats.hits === 0 && cacheStats.misses === 0
  );
}

rmSync(tmp, { recursive: true, force: true });

console.log("================================================");
if (failed === 0) {
  console.log(`${GREEN}analyze-cache tests PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}analyze-cache tests FAILED — ${failed} assertion(s)${NC}`);
process.exit(1);
