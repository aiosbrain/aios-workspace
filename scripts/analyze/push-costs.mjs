/**
 * push-costs.mjs — push Cursor dashboard billing to POST /api/v1/costs (W2.1).
 * Called from `aios analyze --push` after session-log metrics. Zero dependencies.
 */

import { fetchCursorUsage } from "./cursor-api.mjs";
import { buildCostPushPayloads } from "./cost-report.mjs";
import { loadCostsState, saveCostsState, pushKey, payloadHash } from "./costs-state.mjs";

const color = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[0;32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[1;33m${s}\x1b[0m`,
};

/**
 * Push daily Cursor billing rows (authoritative USD) to the brain.
 * @param {string} project — contribution tag (default aios)
 */
export async function pushCursorCosts(
  repo,
  cfg,
  helpers,
  { sinceMs, endMs, member, project = "aios" }
) {
  const { api } = helpers || {};
  if (!api || !cfg.brain_url || !cfg.api_key) return { sent: 0, skipped: 0, failed: 0 };

  let cursor;
  try {
    cursor = await fetchCursorUsage(sinceMs, endMs);
  } catch (e) {
    console.warn(color.yellow(`  cursor billing skipped: ${e.message}`));
    return { sent: 0, skipped: 0, failed: 0 };
  }

  const state = loadCostsState(repo);
  if (!state.pushed) state.pushed = {};

  let sent = 0,
    skipped = 0,
    failed = 0;

  for (const day of cursor.days || []) {
    if (day.date === "unknown") continue;
    const [payload] = buildCostPushPayloads({ cursor: { days: [day] } }, member, project);
    if (!payload) continue;
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
        console.warn(
          color.dim("  POST /costs not on brain yet (W2.1) — maturity metrics still pushed")
        );
        break;
      }
      console.warn(color.yellow(`  cursor cost push ${day.date} failed: ${e.message}`));
    }
  }

  saveCostsState(repo, state);
  if (sent || failed) {
    console.log(
      color.green(
        `  cursor billing: pushed ${sent} day(s)` +
          (skipped ? `, ${skipped} unchanged` : "") +
          (failed ? `, ${failed} failed` : "")
      )
    );
  }
  return { sent, skipped, failed };
}
