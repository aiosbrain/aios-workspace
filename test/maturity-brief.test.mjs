// Maturity brief hook (AIO-228 / AM2) — spawns hooks/maturity-brief.mjs with realistic
// SessionStart payloads over a directly-written maturity store (no transcript parsing needed on
// the read side), and asserts the emitted 3-line AEM brief. Covers the three reviewer Majors:
//   #1 tool_diversity/ratios are FOLDED from counts, never averaged (Test "counts-fold …");
//   #2 the store is filtered to THIS project's slug (Test "project filter …");
//   #3 the hook only fires on SessionStart (implicit in every payload; wrong events never write).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STORE_REL } from "../scripts/analyze/maturity-store.mjs";
import { placement, AXIS_LABELS } from "../scripts/analyze/aem.mjs";
import { AXIS_GUIDE } from "../scripts/analyze/guidance.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "hooks", "maturity-brief.mjs");
const DAY = 24 * 60 * 60 * 1000;
const PROJECT = "aios-workspace"; // slug of the default payload cwd basename

function ws() {
  return mkdtempSync(path.join(tmpdir(), "maturity-brief-"));
}

// Default SessionStart payload — cwd basename slugifies to PROJECT; decoupled from `dir`
// (the store root = CLAUDE_PROJECT_DIR), mirroring reality where root and project can diverge.
function defaultPayload(overrides = {}) {
  return {
    hook_event_name: "SessionStart",
    session_id: "s-start",
    cwd: "/x/aios-workspace",
    transcript_path: "/x/aios-workspace/transcript.jsonl",
    source: "startup",
    ...overrides,
  };
}

function runHook(dir, payload, { rawInput, env } = {}) {
  const input = rawInput !== undefined ? rawInput : JSON.stringify(payload);
  try {
    const out = execFileSync("node", [HOOK], {
      input,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout: out.toString() };
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout || "").toString() };
  }
}

// One v1 store record with sensible defaults; caller overrides counts/signals/age.
function mkSession(overrides = {}) {
  const { ageDays = 1, project = PROJECT, counts = {}, signals = {}, ...rest } = overrides;
  const ended = new Date(Date.now() - ageDays * DAY).toISOString();
  return {
    session_id: `sess-${Math.round((Date.now() % 1e9) + Math.floor(ageDays * 1000))}-${rest.session_id || ""}`,
    tool: "claude",
    project,
    ended_at: ended,
    event_count: 10,
    tier: "admin",
    captured_at: ended,
    counts: {
      in_tok: 100,
      out_tok: 50,
      cache_read_tok: 200,
      cache_create_tok: 30,
      subagent_tok: 0,
      tool_use_total: 10,
      verify_tool_uses: 1,
      tool_results: 4,
      tool_result_errors: 1,
      tasks: 2,
      permission_events: 0,
      distinct_tools: ["Bash", "Read"],
      ...counts,
    },
    signals: {
      subagent_usage: 0,
      tool_diversity: 2,
      ...signals,
    },
    ...rest,
  };
}

const putLine = (session) => JSON.stringify({ v: 1, op: "put", session });

// Write a store of sessions (each must have a unique session_id to survive the fold).
function writeStore(dir, sessions) {
  const abs = path.join(dir, STORE_REL);
  mkdirSync(path.dirname(abs), { recursive: true });
  const lines = sessions.map((s, i) => putLine({ ...s, session_id: `${s.session_id}-${i}` }));
  writeFileSync(abs, lines.join("\n") + "\n");
  return abs;
}

// Parse a successful emit → its additionalContext lines.
function parseBrief(stdout) {
  const obj = JSON.parse(stdout);
  assert.equal(obj.hookSpecificOutput.hookEventName, "SessionStart");
  return obj.hookSpecificOutput.additionalContext.split("\n");
}

const LABEL_TO_AXIS = Object.fromEntries(Object.entries(AXIS_LABELS).map(([k, v]) => [v, k]));

test("hook file: executable bit set + node shebang", () => {
  assert.ok(statSync(HOOK).mode & 0o111, "hooks/maturity-brief.mjs is executable");
  assert.equal(readFileSync(HOOK, "utf8").split("\n")[0], "#!/usr/bin/env node");
});

test("happy path (≥5 recent, matching project) → one 3-line SessionStart brief", () => {
  const dir = ws();
  try {
    writeStore(
      dir,
      Array.from({ length: 5 }, (_, i) => mkSession({ session_id: `h${i}`, ageDays: i + 1 }))
    );
    const { code, stdout } = runHook(dir, defaultPayload());
    assert.equal(code, 0);
    const lines = parseBrief(stdout);
    assert.equal(lines.length, 3, "brief is exactly three lines");
    assert.match(lines[0], /^AEM placement: L[1-5] \(weakest axis: .+ [0-4]\/4\)\.$/);
    assert.match(lines[1], /^Tip: .+/);
    assert.equal(lines[2], "Full report: `npm run aios -- analyze --report`");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project filter excludes other repos' sessions (Major #2)", () => {
  const dir = ws();
  try {
    // 5 recent sessions for another repo + only 3 for THIS project → below the gate.
    writeStore(dir, [
      ...Array.from({ length: 5 }, (_, i) =>
        mkSession({ session_id: `o${i}`, project: "other-repo", ageDays: i + 1 })
      ),
      ...Array.from({ length: 3 }, (_, i) => mkSession({ session_id: `m${i}`, ageDays: i + 1 })),
    ]);
    const { code, stdout } = runHook(dir, defaultPayload());
    assert.equal(code, 0);
    assert.equal(stdout, "", "5 non-matching sessions do not count toward the ≥5 gate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("counts-fold correctness: folded ratios ≠ mean-of-ratios flips the spine (Major #1)", () => {
  const dir = ws();
  try {
    // 4 small sessions: per-session delegation_ratio = 3/100 = 0.03; 1 huge: 0/100000 = 0.
    // Mean-of-ratios = (0.03·4 + 0)/5 = 0.024 ≥ 0.02 → naive Autonomy 2 → L4.
    // Folded = Σsubagent_tok 12 / Σtotal_tok → «0.02 → Autonomy floor 1 → L3.
    const common = {
      tool_use_total: 10,
      verify_tool_uses: 1, // folded verify 5/50 = 0.1 → Verification 2 (holds both paths)
      cache_create_tok: 0,
      out_tok: 0,
      tool_results: 0,
      tool_result_errors: 0,
      tasks: 1,
    };
    const small = Array.from({ length: 4 }, (_, i) =>
      mkSession({
        session_id: `d${i}`,
        ageDays: i + 1,
        counts: {
          ...common,
          in_tok: 100,
          cache_read_tok: 200, // pushes folded cache_hit_rate ≥ 0.3 → Context hygiene 2
          subagent_tok: 3,
          permission_events: 1, // ensures the Autonomy floor is 1 (not 0)
        },
        signals: { subagent_usage: 1, tool_diversity: 2, delegation_ratio: 0.03 },
      })
    );
    const big = mkSession({
      session_id: "big",
      ageDays: 5,
      counts: {
        ...common,
        in_tok: 100000,
        cache_read_tok: 60000,
        subagent_tok: 0,
        permission_events: 0,
      },
      signals: { subagent_usage: 0, tool_diversity: 2, delegation_ratio: 0 },
    });
    writeStore(dir, [...small, big]);

    const { code, stdout } = runHook(dir, defaultPayload());
    assert.equal(code, 0);
    const lines = parseBrief(stdout);
    assert.match(lines[0], /^AEM placement: L3 /, "hook folds counts → L3");

    // Independently prove the mean-of-ratios path genuinely lands on L4 (would be the bug).
    const averaged = {
      delegation_ratio: 0.024, // mean of per-session ratios
      verify_tool_rate: 0.1,
      cache_hit_rate: 0.377,
      tokens_per_task: 20080,
      permission_events: 4,
      subagent_usage: 0.8,
      tool_diversity: 2,
    };
    assert.equal(placement(averaged).spine, "L4", "mean-of-ratios would over-rank to L4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty / missing store → no output, exit 0", () => {
  const dir = ws();
  try {
    // No store file at all.
    let r = runHook(dir, defaultPayload());
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");

    // Empty store file.
    const abs = path.join(dir, STORE_REL);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "");
    r = runHook(dir, defaultPayload());
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("<5 sessions inside the window → no output", () => {
  const dir = ws();
  try {
    writeStore(dir, [
      ...Array.from({ length: 3 }, (_, i) => mkSession({ session_id: `r${i}`, ageDays: i + 1 })),
      ...Array.from({ length: 2 }, (_, i) => mkSession({ session_id: `old${i}`, ageDays: 20 })),
    ]);
    const { code, stdout } = runHook(dir, defaultPayload());
    assert.equal(code, 0);
    assert.equal(stdout, "", "2 sessions back-dated 20 days don't count; 3 recent < 5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tip rotation advances across runs + brief-state.json increments", () => {
  const dir = ws();
  try {
    writeStore(
      dir,
      Array.from({ length: 5 }, (_, i) => mkSession({ session_id: `t${i}`, ageDays: i + 1 }))
    );
    const statePath = path.join(dir, path.dirname(STORE_REL), "brief-state.json");

    let axisSteps = null;
    for (let run = 0; run < 3; run++) {
      const { code, stdout } = runHook(dir, defaultPayload());
      assert.equal(code, 0);
      const lines = parseBrief(stdout);
      const m = lines[0].match(/weakest axis: (.+) \d\/4\)\.$/);
      assert.ok(m, "line 1 carries the weakest-axis label");
      const axis = LABEL_TO_AXIS[m[1]];
      const steps = AXIS_GUIDE[axis].steps;
      if (axisSteps === null) axisSteps = steps;
      else assert.deepEqual(steps, axisSteps, "weakest axis is stable across runs");

      assert.equal(lines[1], `Tip: ${steps[run % steps.length]}`, `run ${run} shows step ${run}`);

      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(state.stepIndex, run + 1, "stepIndex increments after each emit");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative stepIndex in brief-state.json is clamped (no 'Tip: undefined')", () => {
  const dir = ws();
  try {
    writeStore(
      dir,
      Array.from({ length: 5 }, (_, i) => mkSession({ session_id: `n${i}`, ageDays: i + 1 }))
    );
    const statePath = path.join(dir, path.dirname(STORE_REL), "brief-state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    // A corrupt/negative persisted index must not select steps[-1] === undefined.
    writeFileSync(statePath, JSON.stringify({ stepIndex: -3 }));

    const { code, stdout } = runHook(dir, defaultPayload());
    assert.equal(code, 0);
    const lines = parseBrief(stdout);
    const m = lines[0].match(/weakest axis: (.+) \d\/4\)\.$/);
    const steps = AXIS_GUIDE[LABEL_TO_AXIS[m[1]]].steps;
    assert.doesNotMatch(lines[1], /undefined/, "tip must never be undefined");
    assert.equal(lines[1], `Tip: ${steps[0]}`, "clamped to step 0");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.stepIndex, 1, "persists the clamped index + 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kill switch (AIOS_MATURITY_BRIEF=0) → no output on a populated store", () => {
  const dir = ws();
  try {
    writeStore(
      dir,
      Array.from({ length: 5 }, (_, i) => mkSession({ session_id: `k${i}`, ageDays: i + 1 }))
    );
    const { code, stdout } = runHook(dir, defaultPayload(), { env: { AIOS_MATURITY_BRIEF: "0" } });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("perf: 500-session store folds well under the hook timeout", () => {
  const dir = ws();
  try {
    writeStore(
      dir,
      Array.from({ length: 500 }, (_, i) =>
        mkSession({ session_id: `p${i}`, ageDays: (i % 13) + 1 })
      )
    );
    // Warm once (prime FS + module cache), then measure a single run.
    runHook(dir, defaultPayload());
    const t0 = process.hrtime.bigint();
    const { code, stdout } = runHook(dir, defaultPayload());
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(code, 0);
    assert.notEqual(stdout, "", "500 recent same-project sessions emit a brief");
    // <200ms is the *compute* budget (single pass, pure fs+arithmetic, zero spawn); the
    // wall-clock here includes Node startup, so guard at <1000ms to catch real regressions
    // (an accidental spawn or O(n²) blowup) without CI flake.
    assert.ok(ms < 1000, `hook ran in ${ms.toFixed(1)}ms (< 1000ms budget)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed store: invalid + wrong-version lines skipped, valid still fold", () => {
  const dir = ws();
  try {
    const abs = path.join(dir, STORE_REL);
    mkdirSync(path.dirname(abs), { recursive: true });
    const good = Array.from({ length: 5 }, (_, i) =>
      putLine({ ...mkSession({ session_id: `g${i}`, ageDays: i + 1 }), session_id: `g${i}` })
    );
    const bad = [
      "not json at all {{{",
      JSON.stringify({ v: 2, op: "put", session: { session_id: "wrongver" } }),
      JSON.stringify({ v: 1, op: "delete", session: { session_id: "wrongop" } }),
    ];
    writeFileSync(abs, [...bad.slice(0, 1), ...good, ...bad.slice(1)].join("\n") + "\n");
    const { code, stdout } = runHook(dir, defaultPayload());
    assert.equal(code, 0);
    const lines = parseBrief(stdout);
    assert.equal(lines.length, 3, "5 valid records fold; malformed lines skipped, no crash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oversized store (>10 MB) → no output, exit 0", () => {
  const dir = ws();
  try {
    const abs = path.join(dir, STORE_REL);
    mkdirSync(path.dirname(abs), { recursive: true });
    const line = putLine(mkSession({ session_id: "z" })) + "\n";
    // Repeat the same line enough to exceed 10 MB.
    const reps = Math.ceil((10 * 1024 * 1024 + 1024) / line.length);
    writeFileSync(abs, line.repeat(reps));
    assert.ok(statSync(abs).size > 10 * 1024 * 1024, "fixture store exceeds the 10 MB cap");
    const { code, stdout } = runHook(dir, defaultPayload());
    assert.equal(code, 0);
    assert.equal(stdout, "", "oversized store is skipped (fail-open)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-SessionStart event → no output", () => {
  const dir = ws();
  try {
    writeStore(
      dir,
      Array.from({ length: 5 }, (_, i) => mkSession({ session_id: `n${i}`, ageDays: i + 1 }))
    );
    for (const ev of ["SessionEnd", "Stop", "Notification"]) {
      const { code, stdout } = runHook(dir, defaultPayload({ hook_event_name: ev }));
      assert.equal(code, 0);
      assert.equal(stdout, "", `${ev} produces no brief`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("garbage stdin → exits 0, no output", () => {
  const dir = ws();
  try {
    const { code, stdout } = runHook(dir, null, { rawInput: "not json at all {{{" });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
