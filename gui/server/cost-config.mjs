/**
 * cost-config.mjs — owner-local actual-spend config for the Costs panel (AIO-457).
 *
 * Reads/validates/writes `<repo>/.aios/cost-config.json` — admin-tier, per-machine,
 * gitignored, never synced, no secrets. The file is shared with the analyze CLI:
 * `scripts/analyze/claude-plan.mjs` reads the legacy `claude.monthly_usd` /
 * `claude.plan` keys, so this module extends the shape BACKWARD-COMPATIBLY:
 *
 *   {
 *     "claude":        { "plan": "max_20x", "monthly_usd": 200 },   // legacy, still canonical for claude
 *     "subscriptions": { "cursor": { "monthly_usd": 20 }, "codex": { "monthly_usd": 0 } },
 *     "metered":       { "anthropic": { "2026-07": 42.13 } }        // exact owner-entered USD by month
 *   }
 *
 * Claude subscription edits are written to BOTH `claude.monthly_usd` (so the CLI
 * keeps working) and `subscriptions.claude` (the uniform new shape). CLEARING the
 * Claude entry removes `claude.monthly_usd` AND `claude.plan` — a bare plan key
 * also resolves to a "config" price in claude-plan.mjs, so leaving it behind
 * would resurrect an owner-entered figure the GUI could never clear. After a
 * clear, the value falls back to auto-detection (honest "detected" provenance).
 * Unknown keys are always preserved — a pre-existing config keeps working with
 * no migration.
 *
 * `coerceUsd` is THE shared coercion for config-sourced dollar values: the
 * ledger read path (costs.mjs) and the Settings hydration both use it, so any
 * value the ledger accepts (including a hand-edited numeric string) the form
 * displays and preserves.
 *
 * Pure helpers (validate/apply) are exported for unit tests; only read/update
 * touch the filesystem. No npm dependencies.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PLAN_PRICES } from "../../scripts/analyze/claude-plan.mjs";

export const SUBSCRIPTION_PROVIDERS = ["claude", "cursor", "codex", "opencode", "zai"];
export const METERED_PROVIDERS = [
  "anthropic",
  "cursor",
  "codex",
  "openai",
  "opencode",
  "openrouter",
  "zai",
];
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_USD = 1_000_000; // sanity ceiling for a single monthly figure

function configPath(repo) {
  return path.join(repo, ".aios", "cost-config.json");
}

/** Parse `<repo>/.aios/cost-config.json` (missing/corrupt → {}). */
export function readCostConfig(repo) {
  const file = configPath(repo);
  if (!repo || !existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function validUsd(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_USD;
}

/**
 * Shared coercion for config-sourced dollar values (ledger read path AND
 * Settings hydration): finite number or numeric string, 0..MAX_USD → number,
 * anything else → null.
 */
export function coerceUsd(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return validUsd(n) ? n : null;
}

/**
 * Owner-configured flat subscription for a provider (USD/month), or null.
 * Reads the extended `subscriptions.<provider>` shape, then the legacy Claude
 * keys claude-plan.mjs reads: `claude.monthly_usd`, else a bare `claude.plan`
 * mapped to its list price (that's what the CLI resolves it to, with source
 * "config" — the GUI must agree so Settings and ledger never diverge).
 */
export function configSubscriptionUsd(config, provider) {
  const sub = config?.subscriptions?.[provider];
  const v = coerceUsd(sub && typeof sub === "object" ? sub.monthly_usd : sub);
  if (v != null) return v;
  if (provider === "claude") {
    const legacy = coerceUsd(config?.claude?.monthly_usd);
    if (legacy != null) return legacy;
    const planPrice = PLAN_PRICES[config?.claude?.plan];
    if (planPrice != null) return planPrice;
  }
  return null;
}

/** Owner-entered exact metered spend for a provider in a period (YYYY-MM), or null. */
export function configMeteredUsd(config, provider, period) {
  return coerceUsd(config?.metered?.[provider]?.[period]);
}

/**
 * Validate a settings patch:
 *   { subscriptions?: { claude?: number|null, ... }, metered?: { anthropic?: { "2026-07": number|null } } }
 * `null` clears an entry. Returns an array of error strings ([] = valid).
 */
export function validateCostConfigPatch(patch) {
  const errors = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return ["patch must be a JSON object"];
  }
  for (const key of Object.keys(patch)) {
    if (key !== "subscriptions" && key !== "metered") errors.push(`unknown key "${key}"`);
  }
  const subs = patch.subscriptions ?? {};
  if (typeof subs !== "object" || Array.isArray(subs)) {
    errors.push("subscriptions must be an object");
  } else {
    for (const [provider, v] of Object.entries(subs)) {
      if (!SUBSCRIPTION_PROVIDERS.includes(provider)) {
        errors.push(`subscriptions: unknown provider "${provider}"`);
      } else if (v !== null && !validUsd(v)) {
        errors.push(`subscriptions.${provider}: must be a number 0–${MAX_USD} or null`);
      }
    }
  }
  const metered = patch.metered ?? {};
  if (typeof metered !== "object" || Array.isArray(metered)) {
    errors.push("metered must be an object");
  } else {
    for (const [provider, months] of Object.entries(metered)) {
      if (!METERED_PROVIDERS.includes(provider)) {
        errors.push(`metered: unknown provider "${provider}"`);
        continue;
      }
      if (!months || typeof months !== "object" || Array.isArray(months)) {
        errors.push(`metered.${provider}: must map "YYYY-MM" to USD`);
        continue;
      }
      for (const [period, v] of Object.entries(months)) {
        if (!PERIOD_RE.test(period)) {
          errors.push(`metered.${provider}: bad month "${period}" (use YYYY-MM)`);
        } else if (v !== null && !validUsd(v)) {
          errors.push(`metered.${provider}.${period}: must be a number 0–${MAX_USD} or null`);
        }
      }
    }
  }
  return errors;
}

/**
 * Apply a validated patch to a parsed config. Pure — returns a new object,
 * preserves every key it doesn't manage (incl. `claude.plan` and any
 * hand-added fields), and drops emptied containers.
 */
export function applyCostConfigPatch(config, patch) {
  const next = structuredClone(config ?? {});
  for (const [provider, v] of Object.entries(patch.subscriptions ?? {})) {
    if (v === null) {
      if (next.subscriptions) delete next.subscriptions[provider];
      if (provider === "claude" && next.claude) {
        // Clear BOTH legacy keys: a bare `claude.plan` still resolves to a
        // "config"-sourced price in claude-plan.mjs, which would resurrect an
        // owner-entered figure the GUI can never clear. Falling back to
        // auto-detection ("detected" provenance) is the honest state.
        delete next.claude.monthly_usd;
        delete next.claude.plan;
      }
    } else {
      next.subscriptions ??= {};
      next.subscriptions[provider] = { ...next.subscriptions[provider], monthly_usd: v };
      // Keep the legacy key the CLI reads (claude-plan.mjs) in lockstep.
      if (provider === "claude") next.claude = { ...next.claude, monthly_usd: v };
    }
  }
  for (const [provider, months] of Object.entries(patch.metered ?? {})) {
    for (const [period, v] of Object.entries(months ?? {})) {
      if (v === null) {
        if (next.metered?.[provider]) delete next.metered[provider][period];
      } else {
        next.metered ??= {};
        next.metered[provider] = { ...next.metered[provider], [period]: v };
      }
    }
    if (next.metered?.[provider] && !Object.keys(next.metered[provider]).length) {
      delete next.metered[provider];
    }
  }
  for (const key of ["subscriptions", "metered", "claude"]) {
    if (next[key] && typeof next[key] === "object" && !Object.keys(next[key]).length) {
      delete next[key];
    }
  }
  return next;
}

/**
 * The subset the Settings surface edits, resolved from a parsed config with the
 * SAME helpers the ledger read path uses (configSubscriptionUsd/coerceUsd) — so
 * any value the ledger accepts, the form displays and preserves.
 */
export function editableCostConfig(config) {
  const subscriptions = {};
  for (const p of SUBSCRIPTION_PROVIDERS) {
    subscriptions[p] = configSubscriptionUsd(config, p);
  }
  const metered = {};
  for (const p of METERED_PROVIDERS) {
    const months = config?.metered?.[p];
    metered[p] = {};
    if (months && typeof months === "object") {
      for (const period of Object.keys(months)) {
        if (!PERIOD_RE.test(period)) continue;
        const v = configMeteredUsd(config, p, period);
        if (v != null) metered[p][period] = v;
      }
    }
  }
  return { subscriptions, metered };
}

/**
 * Validate + merge + write a settings patch into `<repo>/.aios/cost-config.json`.
 * @returns {{ok: true, config: object}|{ok: false, errors: string[]}}
 */
export function updateCostConfig(repo, patch) {
  const errors = validateCostConfigPatch(patch);
  if (errors.length) return { ok: false, errors };
  const next = applyCostConfigPatch(readCostConfig(repo), patch);
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  // Atomic write: temp file + rename, so a crash mid-write never truncates the config.
  const file = configPath(repo);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return { ok: true, config: next };
}
