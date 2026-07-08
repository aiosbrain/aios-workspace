/**
 * push-costs.mjs — gather provider spend + push to POST /api/v1/costs (W2.1).
 * Called from `aios analyze --push` after session-log metrics. Zero dependencies.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { fetchCursorUsage } from "./cursor-api.mjs";
import {
  buildClaudeCostFromEvents,
  buildOpencodeCostFromEvents,
  buildCostPushPayloads,
  renderAiSpendMarkdown,
} from "./cost-report.mjs";
import { loadCostsState, saveCostsState, pushKey, payloadHash } from "./costs-state.mjs";

const color = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[0;32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[1;33m${s}\x1b[0m`,
};

/**
 * Fetch Cursor billing + build Claude session-log estimates for the window.
 * Safe to call without brain credentials (display-only).
 */
export async function gatherCostData({ sinceMs, endMs, events, window }) {
  const out = {
    window,
    claude: buildClaudeCostFromEvents(events, sinceMs),
    opencode: buildOpencodeCostFromEvents(events, sinceMs),
  };
  try {
    out.cursor = await fetchCursorUsage(sinceMs, endMs);
  } catch (e) {
    out.cursor_error = e.message;
  }
  return out;
}

/** Write team-tier 3-log/ai-spend.md in the target workspace. */
export function writeAiSpendMarkdown(repo, costData) {
  const dir = path.join(repo, "3-log");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ai-spend.md");
  writeFileSync(file, renderAiSpendMarkdown(costData), "utf8");
  return file;
}

async function pushPayloadRows(repo, cfg, api, payloads, state) {
  let sent = 0,
    skipped = 0,
    failed = 0;
  let costs404 = false;

  for (const payload of payloads) {
    if (payload.date === "unknown") continue;
    const key = pushKey(payload);
    const hash = payloadHash(payload);
    if (state.pushed[key] === hash) {
      skipped++;
      continue;
    }
    try {
      await api(cfg, "POST", "/costs", payload);
      state.pushed[key] = hash;
      sent++;
    } catch (e) {
      failed++;
      if (String(e.message).includes("404")) {
        costs404 = true;
        break;
      }
      console.warn(
        color.yellow(`  ${payload.provider} cost push ${payload.date} failed: ${e.message}`)
      );
    }
  }
  if (costs404) {
    console.warn(
      color.dim("  POST /costs not on brain yet (W2.1) — maturity metrics still pushed")
    );
  }
  return { sent, skipped, failed };
}

/**
 * Push daily Cursor billing + Claude estimate rows to the brain.
 * @param {string} project — contribution tag (default aios)
 */
export async function pushProviderCosts(
  repo,
  cfg,
  helpers,
  costData,
  { member, project = "aios", writeMarkdown = false }
) {
  const { api } = helpers || {};
  if (!api || !cfg.brain_url || !cfg.api_key) {
    return {
      cursor: { sent: 0, skipped: 0, failed: 0 },
      claude: { sent: 0, skipped: 0, failed: 0 },
    };
  }

  if (costData.cursor?.truncated) {
    console.warn(
      color.yellow(
        `  cursor billing incomplete: ${costData.cursor.events_fetched}/${costData.cursor.events_total} events fetched — daily costs may be undercounted`
      )
    );
  }

  const state = loadCostsState(repo);
  if (!state.pushed) state.pushed = {};

  const rollup = {
    window: costData.window,
    cursor: costData.cursor ? { days: costData.cursor.days, totals: costData.cursor.totals } : null,
    claude: costData.claude,
    opencode: costData.opencode,
  };

  const cursorPayloads = buildCostPushPayloads({ cursor: rollup.cursor, claude: rollup.claude, opencode: rollup.opencode }, member, project);

  const cursorStats = await pushPayloadRows(repo, cfg, api, cursorPayloads, state);

  saveCostsState(repo, state);

  if (writeMarkdown) {
    try {
      const file = writeAiSpendMarkdown(repo, rollup);
      console.log(color.green(`  wrote ${path.relative(repo, file)}`));
    } catch (e) {
      console.warn(color.yellow(`  ai-spend.md write failed: ${e.message}`));
    }
  }

  logPushSummary("cursor", cursorStats);

  return { cursor: cursorStats };
}

function logPushSummary(provider, { sent, skipped, failed }) {
  if (!sent && !failed) return;
  console.log(
    color.green(
      `  ${provider} billing: pushed ${sent} day(s)` +
        (skipped ? `, ${skipped} unchanged` : "") +
        (failed ? `, ${failed} failed` : "")
    )
  );
}

/** @deprecated use pushProviderCosts */
export async function pushCursorCosts(repo, cfg, helpers, opts) {
  const costData = await gatherCostData({
    sinceMs: opts.sinceMs,
    endMs: opts.endMs,
    events: [],
    window: {
      since: new Date(opts.sinceMs).toISOString().slice(0, 10),
      until: new Date(opts.endMs).toISOString().slice(0, 10),
    },
  });
  return pushProviderCosts(repo, cfg, helpers, costData, {
    member: opts.member,
    project: opts.project,
  }).then((s) => s.cursor);
}
