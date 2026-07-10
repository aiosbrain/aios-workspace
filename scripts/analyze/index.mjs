/**
 * index.mjs — `aios analyze` orchestrator.
 *
 * Pipeline: discover local session logs → parse to NormalizedEvent[] → filter to
 * the window → compute signals → AEM placement → render (text/JSON) → optional
 * --push of daily aggregates.
 *
 * Phase 1 scope: Claude Code source, local report only (no push). Codex/Cursor
 * parsers register in Phase 2; --push wires in Phase 4.
 *
 * Incremental strategy: (a) skip session files whose mtime predates the window
 * (inactive sessions are never re-read); (b) a per-file parse cache (AIO-189,
 * cache.mjs) — unchanged files reuse their cached NormalizedEvent[], grown
 * append-only logs are tail-parsed from the stored byte offset. `--no-cache`
 * forces the old full-parse behavior. Cursor's SQLite DB is exempt (see
 * cache.mjs).
 *
 * Zero dependencies (Node >= 18).
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DISCOVERERS, fileStat } from "./sources.mjs";
import { cachedParseFile, defaultCacheDir } from "./cache.mjs";
import { parseClaude } from "./parse-claude.mjs";
import { parseCodex } from "./parse-codex.mjs";
import { parseCursor, sqlite3Available } from "./parse-cursor.mjs";
import { parseOpencode } from "./parse-opencode.mjs";
import { computeSignals, bucketByDay } from "./metrics.mjs";
import { placement } from "./aem.mjs";
import { renderText, renderReport, toJson, buildPushPayload, buildLastSummary } from "./report.mjs";
import { scoreCognitiveErgonomics, ergonomicsBaseline } from "./ergonomics.mjs";
import { saveAnalyzeState, loadAnalyzeState } from "./state.mjs";
import { gatherCostData, pushProviderCosts } from "./push-costs.mjs";
import { renderCostSummary } from "./cost-report.mjs";
import { cursorBillingStart } from "./cursor-api.mjs";
import { calibrate, renderVerdict, writeVerdictArtifact } from "./ergonomics-calibrate.mjs";

// Text/JSONL parsers (read file bytes). Cursor is SQLite — handled separately.
const PARSERS = { claude: parseClaude, codex: parseCodex, opencode: parseOpencode };
const ALL_TOOLS = ["claude", "codex", "cursor", "opencode"];

const color = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[0;32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[1;33m${s}\x1b[0m`,
};

export function parseArgs(rest) {
  const opts = {
    since: "7d",
    tools: [],
    json: false,
    push: false,
    full: false,
    report: false,
    calibrate: false,
    noCache: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--report") opts.report = true;
    else if (a === "--since") opts.since = rest[++i];
    else if (a === "--tool") opts.tools.push(rest[++i]);
    else if (a === "--json") opts.json = true;
    else if (a === "--push") opts.push = true;
    else if (a === "--full") opts.full = true;
    else if (a === "--calibrate") opts.calibrate = true;
    else if (a === "--no-cache") opts.noCache = true;
  }
  return opts;
}

/** Resolve --since ("7d" | "billing" | ISO date) to a Date. */
async function resolveSince(spec, warn = console.warn) {
  if (spec === "billing") {
    try {
      return await cursorBillingStart();
    } catch (e) {
      warn(
        `  --since billing: Cursor session unavailable (${e.message}) — falling back to 30d window`
      );
      return new Date(Date.now() - 30 * 86_400_000);
    }
  }
  const m = String(spec).match(/^(\d+)d$/);
  if (m) return new Date(Date.now() - Number(m[1]) * 86_400_000);
  const d = new Date(spec);
  if (!Number.isNaN(d.getTime())) return d;
  return new Date(Date.now() - 7 * 86_400_000);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Discover + parse session logs for `tools` into one NormalizedEvent[].
 * With `cache` on (default), claude/codex JSONL files go through the per-file
 * parse cache (cache.mjs) — the event stream is byte-for-byte the same as a
 * cold parse, only cheaper. Exported for the cold-vs-warm identity test.
 *
 * @returns {{events: object[], cacheStats: {hits:number, appends:number, misses:number}}}
 */
export function collectEvents({
  tools,
  home,
  repo,
  sinceMs,
  full = false,
  cache = true,
  cacheDir = defaultCacheDir(home),
  warn = () => {},
}) {
  const events = [];
  const cacheStats = { hits: 0, appends: 0, misses: 0 };
  for (const tool of tools) {
    // Opencode: workspace-relative store, pass repo not home.
    const files = DISCOVERERS[tool]
      ? tool === "opencode"
        ? DISCOVERERS[tool](repo)
        : DISCOVERERS[tool](home)
      : [];

    // Cursor: SQLite, not line-delimited text. One big DB spanning all history,
    // so we can't mtime-skip it — the per-event timestamp window-filter handles
    // recency. Capability-gated on the sqlite3 CLI. Exempt from the parse cache
    // (WAL sidecar makes mtime/size keying unsafe — see cache.mjs).
    if (tool === "cursor") {
      if (!sqlite3Available()) {
        warn("  cursor: sqlite3 CLI not found on PATH — skipping (install sqlite3 to enable)");
        continue;
      }
      for (const db of files) {
        for (const ev of parseCursor(db)) events.push(ev);
      }
      continue;
    }

    const parse = PARSERS[tool];
    if (!parse) {
      warn(`  ${tool}: parser not yet available — skipping`);
      continue;
    }
    for (const f of files) {
      const st = fileStat(f);
      if (!full && st && st.mtime_ms < sinceMs) continue; // inactive session
      const fallbackId = path.basename(f).replace(/\.jsonl$/, "");
      if (cache && st) {
        try {
          for (const ev of cachedParseFile({
            dir: cacheDir,
            tool,
            file: f,
            st,
            fallbackId,
            stats: cacheStats,
          }))
            events.push(ev);
        } catch {
          /* unreadable file — skip, same as the cold path */
        }
        continue;
      }
      let text;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const ev of parse(text, fallbackId)) events.push(ev);
    }
  }
  return { events, cacheStats };
}

/**
 * Window-filter + reduce a NormalizedEvent[] into the analyze result object.
 * Pure given its inputs; exported for the cold-vs-warm identity test.
 */
export function buildResult({ events, tools, since, until }) {
  const sinceMs = since.getTime();

  // Window filter by event timestamp (undated events are kept).
  const inWindow = events.filter((ev) => {
    if (!ev.ts) return true;
    const t = new Date(ev.ts).getTime();
    return Number.isFinite(t) ? t >= sinceMs : true;
  });

  const overall = computeSignals(inWindow);
  const days = [...bucketByDay(inWindow).entries()]
    .filter(([d]) => d !== "undated")
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, evs]) => {
      const sig = computeSignals(evs);
      return { date, signals: sig, placement: placement(sig) };
    });

  const result = {
    window: { since: isoDate(since), until: isoDate(until) },
    tools,
    totals: {
      sessions: overall.sessions,
      tasks: overall.tasks,
      events: overall.events,
      total_tokens: overall.total_tokens,
    },
    signals: overall,
    placement: placement(overall),
    days,
  };
  return { result, inWindow };
}

export async function cmdAnalyze(repo, cfg, rest, helpers = {}) {
  const opts = parseArgs(rest);
  const since = await resolveSince(opts.since, (msg) => console.warn(color.yellow(msg)));
  const until = new Date();
  const sinceMs = since.getTime();
  const home = os.homedir();

  const tools = (opts.tools.length ? opts.tools : ALL_TOOLS).filter((t) => ALL_TOOLS.includes(t));

  const { events } = collectEvents({
    tools,
    home,
    repo,
    sinceMs,
    full: opts.full,
    cache: !opts.noCache,
    warn: (msg) => console.warn(color.yellow(msg)),
  });

  const { result, inWindow } = buildResult({ events, tools, since, until });

  // Phase B calibration (AIO-216) is analysis-only and READ-ONLY: it emits a CE
  // shadow-band verdict + a gitignored artifact, then returns BEFORE any side
  // effect (no gatherCostData network, no JSON/text/push render, no
  // saveAnalyzeState). --json/--push/--report are ignored with one warning so
  // stdout carries only the verdict text (never a toJson body).
  if (opts.calibrate) {
    if (opts.json || opts.push || opts.report) {
      console.warn(
        color.yellow("  --calibrate is analysis-only: ignoring --json / --push / --report")
      );
    }
    const cal = calibrate(result);
    console.log(renderVerdict(cal));
    const p = writeVerdictArtifact(repo, cal, isoDate);
    console.log(color.dim(`  verdict written to ${p}`));
    return result;
  }

  const costData = await gatherCostData({
    sinceMs,
    endMs: until.getTime(),
    events: inWindow,
    window: result.window,
    repo,
  });

  if (opts.json) {
    console.log(JSON.stringify(toJson(result, costData), null, 2));
  } else {
    console.log(renderText(result, color));
    const costBlock = renderCostSummary(costData, color);
    if (costBlock) console.log(costBlock);
    if (opts.report) console.log(renderReport(result, color));
  }

  const state = loadAnalyzeState(repo);
  if (opts.push) {
    await pushDays(repo, cfg, result, helpers, state);
    const { resolveMember, loadDotEnv } = helpers || {};
    const member = resolveMember
      ? resolveMember(repo, cfg, loadDotEnv ? loadDotEnv(repo) : {})
      : "";
    await pushProviderCosts(repo, cfg, helpers, costData, {
      member,
      project: process.env.AIOS_COST_PROJECT || "aios",
      writeMarkdown: true,
    });
  }

  // Record the run (push dedup + future tail-parse offsets build on this).
  state.last_run = until.toISOString();
  state.last_summary = buildLastSummary(result);
  saveAnalyzeState(repo, state);

  return result;
}

/**
 * Push each day's aggregate to the brain (POST /api/v1/metrics), team-tier. Only
 * days whose content sha changed since the last push are sent (idempotent + cheap).
 * Uses helpers injected from the CLI (api, resolveMember, loadDotEnv) to avoid a
 * circular import back into aios.mjs.
 */
async function pushDays(repo, cfg, result, helpers, state) {
  const { api, resolveMember, loadDotEnv } = helpers || {};
  if (!api || !resolveMember) {
    console.warn(color.yellow("  --push unavailable: CLI helpers not wired"));
    return;
  }
  const missing = [];
  if (!cfg.brain_url?.trim()) missing.push("AIOS_BRAIN_URL");
  if (!cfg.api_key?.trim()) missing.push("AIOS_API_KEY");
  if (missing.length) {
    console.warn(
      color.yellow(`  --push skipped: brain not configured (missing ${missing.join(" + ")}).`)
    );
    if (missing.includes("AIOS_BRAIN_URL") && "AIOS_BRAIN_URL" in process.env) {
      console.warn(
        color.yellow(
          "    AIOS_BRAIN_URL is present but empty — dotenvx decrypted an empty value. Re-set it:"
        )
      );
      console.warn(
        color.dim("      dotenvx set AIOS_BRAIN_URL=https://your-brain.example.com -f .env")
      );
      console.warn(color.dim("      dotenvx encrypt -f .env"));
    } else {
      console.warn(color.dim("    Set them in your shell or a .env file, e.g.:"));
      console.warn(color.dim("      export AIOS_BRAIN_URL=https://your-brain.example.com"));
      console.warn(
        color.dim(
          "      export AIOS_API_KEY=aios_<key_id>_<secret>   # team-tier key from the brain admin UI"
        )
      );
      console.warn(
        color.dim("    (or run from a stamped workspace whose aios.yaml + .env provide them).")
      );
    }
    return;
  }
  const member = resolveMember(repo, cfg, loadDotEnv ? loadDotEnv(repo) : {});
  if (!state.pushed) state.pushed = {}; // date → last-pushed sha

  let sent = 0,
    skipped = 0,
    failed = 0;
  for (let i = 0; i < result.days.length; i++) {
    const day = result.days[i];
    const ceBand = scoreCognitiveErgonomics(
      day.signals,
      ergonomicsBaseline(result.days.slice(0, i))
    );
    const payload = buildPushPayload(day, member, ceBand);
    const sha = simpleHash(JSON.stringify(payload));
    if (state.pushed[day.date] === sha) {
      skipped++;
      continue;
    }
    try {
      await api(cfg, "POST", "/metrics", payload);
      state.pushed[day.date] = sha;
      sent++;
    } catch (e) {
      failed++;
      console.warn(color.yellow(`  push ${day.date} failed: ${e.message}`));
    }
  }
  console.log(
    color.green(
      `\n  pushed ${sent} day(s) to brain` +
        (skipped ? `, ${skipped} unchanged` : "") +
        (failed ? `, ${failed} failed` : "")
    )
  );
}

/** Tiny non-crypto hash for change-detection of a day's already-pushed payload. */
function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
