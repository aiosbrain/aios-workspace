// Colour presentation for `aios analyze`, `aios context-health` and `aios codebase-health`.
// Renderer units run at 112/80/60 columns, light/dark, truecolor/ANSI/monochrome and
// unicode/ASCII glyphs; PTY cases drive the real CLI. Machine and plain paths are proven
// unchanged: they never import Ink and print exactly the pre-existing plain text.
// Synthetic fixtures only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { buildAnalyzeView, compactTokens } from "../scripts/analyze/view.mjs";
import { placement } from "../scripts/analyze/aem.mjs";
import { codebaseHealthView } from "../scripts/codebase-health.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const ESC = "\u001b";
const build = spawnSync(process.execPath, ["scripts/build-terminal.mjs"], {
  cwd: root,
  encoding: "utf8",
  timeout: 60000,
});
assert.equal(build.status, 0, build.stderr);
// Ink's colour library reads its level once at import; the capability context (not the
// test runner's stdout) decides depth, so give the library full depth to render into.
process.env.FORCE_COLOR = "3";
const reports = await import("../dist/terminal/report.js");
const { wrap, hang } = await import("../dist/terminal/compose.js");

const LONG_PATH =
  "1-inbox/from-brain/github-aiosbrain-aios-team-brain__github__aiosbrain-aios-team-brain__docs__design__extraction-degradation-alarm.md";
const LONG_TOOL = "opencode-gpt-5.1-codex-max-2026-10-01-preview-extended-context";

function signals(o = {}) {
  return {
    sessions: 71,
    tasks: 2422,
    events: 9000,
    total_tokens: 9_027_980_123,
    focus_block_avg_min: 148.2,
    context_switch_rate: 6.46,
    interrupts_per_hour: 10.59,
    concurrent_sessions_peak: 9,
    verify_tool_rate: 0.78,
    cache_hit_rate: 0.96,
    delegation_ratio: 0.55,
    subagent_usage: 0.54,
    tool_diversity: 7.2,
    cost_per_task: 3,
    tokens_per_task: 144_000,
    ...o,
  };
}
const day = (date, o) => {
  const sig = signals(o);
  return { date, signals: sig, placement: placement(sig) };
};
const sig = signals();
const result = {
  window: { since: "2026-09-28", until: "2026-10-05" },
  tools: ["claude", "codex", LONG_TOOL],
  totals: { sessions: 71, tasks: 2422, events: 9000, total_tokens: sig.total_tokens },
  signals: sig,
  placement: placement(sig),
  days: Array.from({ length: 8 }, (_, i) => day(`2026-09-${20 + i}`)),
};
const contextHealth = {
  mode: "workspace",
  score: 0,
  hardFailures: 2,
  softMisses: 1,
  summary: "0/4 — 2 hard failure(s): resolver-fixtures, broken-links",
  checks: [
    {
      id: "placeholder-residue",
      label: "No unstamped residue",
      kind: "hard",
      ok: true,
      detail: "clean",
    },
    {
      id: "broken-links",
      label: "No broken internal links",
      kind: "hard",
      ok: false,
      detail: `27 broken: ${LONG_PATH} -> [[target]]`,
    },
    {
      id: "resolver-fixtures",
      label: "Resolver fixtures route correctly",
      kind: "hard",
      ok: false,
      detail: "1 fixture(s) unrouted",
    },
    {
      id: "toolkit-staleness",
      label: "Toolkit sync is current",
      kind: "soft",
      ok: false,
      detail: "41 commit(s) behind toolkit HEAD",
    },
  ],
};
const codebaseHealth = {
  mode: "cheap",
  status: "degraded",
  score_pct: 71,
  failed_invariant_ids: [],
  axes: {
    modularity: { band: 2, passed: 2, total: 4, evidence_status: "complete" },
    invariants: { band: null, passed: 0, total: 0, evidence_status: "missing" },
  },
  checks: [
    {
      title: "File-size gate (default-deny)",
      ok: true,
      value: 0,
      evidence_status: "complete",
      required: true,
      detail: "exit 0",
    },
    {
      title: "Grandfathered oversize files",
      ok: false,
      value: 48,
      evidence_status: "complete",
      required: false,
      detail: `48 grandfathered in ${LONG_PATH}`,
    },
    {
      title: "Mutation score",
      ok: true,
      value: null,
      evidence_status: "missing",
      required: false,
      detail: "no reports (skipped)",
    },
  ],
  summary: "degraded — 71% · evidence stale (7/7 axes scored, 1 check(s) skipped)",
  next_moves: [
    {
      axis: "modularity",
      metric: "size_grandfather_count",
      current: 48,
      neededValue: 40,
      currentBand: 2,
      neededBand: 3,
    },
  ],
};
const costData = {
  window: result.window,
  plan: { label: "Max 20×", monthly_usd: 200, source: "config", note: "plan from config" },
  cursor: { totals: { cost_usd: 54.78, events: 50 }, truncated: true },
  claude: { totals: { cost_usd: 6892.93, events: 43015 } },
  codex: { totals: { cost_usd: 367.63, events: 8539 } },
  anthropic_error: "no admin key",
};
const view = buildAnalyzeView({ result, contextHealth, codebaseHealth, costData, report: true });

const base = { mode: "human", motion: false, tier: "rich", glyphs: "unicode" };
const visibleWidth = (line) =>
  [...stripVTControlCharacters(line)].reduce(
    (n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1),
    0
  );
const flat = (out) => stripVTControlCharacters(out).replace(/\s+/g, " ");
const dense = (out) => stripVTControlCharacters(out).replace(/\s+/g, "");

/** Every phrase intact (word-wrapped only at spaces) and every long token present. */
function assertComplete(out, phrases, tokens, label) {
  const f = flat(out);
  for (const p of phrases) assert.ok(f.includes(p), `${label}: missing intact phrase "${p}"`);
  const d = dense(out);
  for (const t of tokens)
    assert.ok(d.includes(t.replace(/\s+/g, "")), `${label}: missing token ${t}`);
}

const analyzePhrases = [
  ...view.axes.map((a) => a.gloss),
  view.axes.find((a) => a.note).note,
  view.spine.gloss,
  view.attention.reading,
  view.opportunity.step,
  view.ergonomicsTip,
  "Run aios analyze --report for a step-by-step plan on this.",
  "Raw sessions stay on your machine — aios analyze --push shares only these scores.",
  "Anthropic API = billed (admin key) · Cursor = billing API",
  "billing fetch incomplete — daily totals may be undercounted",
  ...view.deepDive.steps,
  view.deepDive.meaning,
  "No broken internal links",
  "Toolkit sync is current",
];
const analyzeTokens = [
  "Spine L5",
  "9.03B",
  "2,422",
  "3.40/4",
  "~$6,892.93",
  "43,015 turns",
  "$54.78",
  "$200/mo",
  "(no admin key)",
  "148.2m",
  "10.59",
  "degraded",
  LONG_TOOL,
];

for (const width of [112, 80, 60, 40, 30]) {
  for (const background of ["dark", "light"]) {
    for (const colorDepth of [24, 4, 0]) {
      test(`analyze renders complete, aligned output at ${width} cols, ${background}, depth ${colorDepth}`, () => {
        const ctx = { ...base, width, background, colorDepth };
        const out = reports.renderAnalyze(ctx, view);
        for (const line of out.split("\n"))
          assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${line}`);
        assertComplete(out, analyzePhrases, analyzeTokens, `analyze ${width}`);
        // The product label is never coloured.
        assert.ok(stripVTControlCharacters(out).startsWith("AIOS · analyze"));
        const first = out.split("\n")[0];
        assert.ok(first.startsWith("AIOS") || first.startsWith(`${ESC}[1mAIOS`), first);
        if (colorDepth === 24) assert.ok(out.includes(`${ESC}[38;2;`));
        if (colorDepth === 4) {
          assert.ok(!out.includes(`${ESC}[38;2;`));
          assert.ok(["31", "32", "33", "35", "36"].some((code) => out.includes(`${ESC}[${code}m`)));
        }
        if (colorDepth === 0) assert.equal(stripVTControlCharacters(out), out);
        const lines = stripVTControlCharacters(out).split("\n");
        if (width >= 80) {
          assert.ok(
            lines.some((l) => /^Attention {2,}orchestration-heavy/.test(l)),
            "keyed column at wide widths"
          );
          assert.ok(
            lines.some((l) => /^Verification {2,}█+/.test(l)),
            "axis bar beside its label"
          );
        } else {
          assert.ok(lines.includes("Attention"), "keys stack below 80 columns");
          if (width >= 60)
            assert.ok(lines.includes("  orchestration-heavy — protect focus blocks"));
        }
        assert.ok(
          !lines.some((l) => /^ {30,}\S/.test(l) && width < 80),
          "no wide indent when narrow"
        );
      });
    }
  }
}

test("truecolor ink differs between the light and dark reference canvases", () => {
  const dark = reports.renderAnalyze(
    { ...base, width: 112, background: "dark", colorDepth: 24 },
    view
  );
  const light = reports.renderAnalyze(
    { ...base, width: 112, background: "light", colorDepth: 24 },
    view
  );
  assert.notEqual(dark, light);
  assert.equal(stripVTControlCharacters(dark), stripVTControlCharacters(light));
});

test("score colour carries meaning: strong, developing and weak bands use distinct semantics", () => {
  const ctx = { ...base, width: 112, background: "dark", colorDepth: 4 };
  const out = reports.renderAnalyze(ctx, view);
  // success (green) for 4.0 axes, red for the 0/4 context-health score, yellow for "degraded".
  assert.ok(out.includes(`${ESC}[32m4.0`));
  assert.ok(out.includes(`${ESC}[31m0/4`));
  assert.ok(out.includes(`${ESC}[33mdegraded`));
  // Lime next commands render as accent.
  assert.ok(out.includes(`${ESC}[32maios analyze --report`));
});

test("ASCII glyph mode emits only ASCII for ASCII report data", () => {
  const asciiView = buildAnalyzeView({
    result: { ...result, tools: ["claude"] },
    contextHealth,
    codebaseHealth,
    costData: { ...costData, plan: { ...costData.plan, label: "Max 20x" } },
    report: true,
  });
  for (const width of [112, 60]) {
    const out = reports.renderAnalyze(
      { ...base, width, background: "dark", colorDepth: 0, glyphs: "ascii" },
      asciiView
    );
    const bad = [...out].filter((c) => c.codePointAt(0) > 127);
    assert.deepEqual(bad, [], `non-ASCII in ascii mode: ${[...new Set(bad)].join("")}`);
    assert.match(out, /Verification\s+#+/);
  }
});

test("long paths break after separators, never inside a word or a '__' run", () => {
  const lines = wrap([{ text: `27 broken: ${LONG_PATH} -> [[target]]` }], 40);
  const joined = lines.map((l) => l.map((s) => s.text).join(""));
  for (const l of joined) assert.ok(l.length <= 40, l);
  assert.equal(joined.join("").replace(/\s/g, ""), `27broken:${LONG_PATH}->[[target]]`);
  for (let i = 1; i < joined.length; i++) {
    const [a, b] = [joined[i - 1], joined[i]];
    assert.ok(!(a.endsWith("_") && b.startsWith("_")), `split inside "__": ${a} | ${b}`);
    assert.ok(!(/[a-z0-9]$/i.test(a) && /^[a-z0-9]/i.test(b)), `mid-word split: ${a} | ${b}`);
  }
});

const chView = (() => {
  const { score, mode, checks } = contextHealth;
  return {
    target: `/Users/example/Projects/${"deeply-nested-".repeat(6)}workspace`,
    mode,
    score,
    summary: contextHealth.summary.slice("0/4 — ".length),
    checks,
  };
})();
for (const width of [112, 80, 60, 40, 30]) {
  for (const colorDepth of [24, 4, 0]) {
    test(`context-health and codebase-health render complete at ${width} cols, depth ${colorDepth}`, () => {
      const ctx = { ...base, width, background: "dark", colorDepth };
      const ch = reports.renderContextHealth(ctx, chView);
      const cb = reports.renderCodebaseHealth(
        ctx,
        codebaseHealthView(codebaseHealth, "/tmp/target")
      );
      for (const out of [ch, cb])
        for (const line of out.split("\n"))
          assert.ok(visibleWidth(line) <= width, `overflow: ${line}`);
      assertComplete(
        ch,
        [
          "2 hard failure(s): resolver-fixtures, broken-links",
          "41 commit(s) behind toolkit HEAD",
          "Fix hints",
        ],
        [chView.target, LONG_PATH, "0/4"],
        "context-health"
      );
      assertComplete(
        cb,
        [
          "2/4 checks ok",
          "no inputs",
          "71% · evidence stale (7/7 axes scored, 1 check(s) skipped)",
          "lifts band 2",
        ],
        [LONG_PATH, "size_grandfather_count48→40", "degraded", "required"],
        "codebase-health"
      );
      if (colorDepth === 0) assert.equal(stripVTControlCharacters(cb), cb);
    });
  }
}

const plainAt = (width, render) =>
  stripVTControlCharacters(render({ ...base, width, background: "dark", colorDepth: 0 })).split(
    "\n"
  );

test("bars are proportional to the real score; an unscored band is a dotted track with –", () => {
  const lines = plainAt(112, (ctx) => reports.renderAnalyze(ctx, view));
  // Columns at 112: label 0–23, bar 24–43 (20 cells), two spaces, score from 46.
  const meter = (filled) => `${"█".repeat(filled)}${"░".repeat(20 - filled)}  `;
  for (const axis of view.axes) {
    const row = lines.find((l) => l.startsWith(axis.label));
    const filled = Math.round((axis.score / 4) * 20);
    assert.equal(row.slice(24, 46), meter(filled), `${axis.label} bar`);
    assert.ok(row.slice(46).startsWith(axis.scoreText), `${axis.label} score`);
  }
  const ce = lines.find((l) => l.startsWith("Cognitive ergonomics"));
  if (view.ergonomics.band == null) assert.match(ce, /^Cognitive ergonomics {2,}·{20} {2}–/);
  else assert.equal(ce.slice(24, 46), meter(Math.round((view.ergonomics.band / 4) * 20)));
  const unscored = buildAnalyzeView({
    result: {
      ...result,
      placement: { ...result.placement, axes: { ...result.placement.axes, learning: null } },
    },
    contextHealth,
    codebaseHealth,
    costData,
  });
  assert.equal(unscored.axes.find((a) => a.label.startsWith("Learning")).scoreText, "–");
  const row = plainAt(112, (ctx) => reports.renderAnalyze(ctx, unscored)).find((l) =>
    l.startsWith("Learning")
  );
  assert.match(row, /^Learning \/ compounding {2}·{20} {2}– /);
  const cb = plainAt(112, (ctx) =>
    reports.renderCodebaseHealth(ctx, codebaseHealthView(codebaseHealth, "/tmp/target"))
  );
  assert.ok(
    cb.some((l) => /^modularity +█{10}░{10} {2}2\/4/.test(l)),
    "band 2 fills half"
  );
  assert.ok(
    cb.some((l) => /^invariants +·{20} {2}–/.test(l)),
    "null band is dotted with –"
  );
});

test("below ~40 columns the axis label stands alone and a shrunken bar shares the next line", () => {
  const lines = plainAt(30, (ctx) => reports.renderAnalyze(ctx, view));
  const i = lines.indexOf("Verification");
  assert.ok(i >= 0, "label on its own line");
  assert.match(lines[i + 1], /^ {2}█{4,8}░* {2}4\.0/);
  // codebase labels are shorter, so their stacked branch starts nearer 25 columns.
  const cb = plainAt(22, (ctx) =>
    reports.renderCodebaseHealth(ctx, codebaseHealthView(codebaseHealth, "/tmp/target"))
  );
  const j = cb.indexOf("modularity");
  assert.ok(j >= 0);
  assert.match(cb[j + 1], /^ {2}█+░+ {2}2\/4/);
});

test("hang never exceeds its width, even when the prefix leaves almost no room", () => {
  const lines = hang([{ text: "x".repeat(30) }], 30, [{ text: "alpha beta gamma delta" }], 35);
  for (const l of lines)
    assert.ok(l.map((seg) => seg.text).join("").length <= 35, JSON.stringify(l));
});

test("a check label exactly as wide as the capped label column keeps a gutter at 80 columns", () => {
  const label = "CLAUDE.md lists all supported contexts";
  assert.equal(label.length, 38);
  const out = plainAt(80, (ctx) =>
    reports.renderContextHealth(ctx, {
      ...chView,
      checks: [
        {
          id: "contexts-list",
          label,
          kind: "hard",
          ok: true,
          detail: "CLAUDE.md names all 3 supported context(s)",
        },
        { id: "x", label: "x".repeat(60), kind: "soft", ok: true, detail: "long label" },
      ],
    })
  );
  assert.ok(!out.some((l) => /contextsCLAUDE/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /contexts$/.test(l)) || out.some((l) => /contexts {2,}CLAUDE/.test(l)));
});

test("a wrapped check label continues under itself below 80 columns", () => {
  const label = "Tier vocabulary in sync between the hub copy and the scaffold copy";
  const out = plainAt(40, (ctx) =>
    reports.renderContextHealth(ctx, {
      ...chView,
      checks: [{ id: "tier", label, kind: "hard", ok: true, detail: "in sync" }],
    })
  );
  const i = out.findIndex((l) => l.startsWith("✓ Tier vocabulary"));
  assert.ok(i >= 0);
  assert.match(out[i + 1], /^ {2}\S/, "continuation is indented under the label");
});

test("compactTokens has a T tier and never prints 1000 of a unit", () => {
  assert.equal(compactTokens(1.2e13), "12.00T");
  assert.equal(compactTokens(9_027_980_123), "9.03B");
  assert.equal(compactTokens(999_950), "1.0M");
  assert.equal(compactTokens(999_996_000), "1.00B");
  assert.equal(compactTokens(12_345), "12k");
  assert.equal(compactTokens(999), "999");
});
