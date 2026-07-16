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
 * keeps working) and `subscriptions.claude` (the uniform new shape). Unknown keys
 * are always preserved — a pre-existing config keeps working with no migration.
 *
 * Pure helpers (validate/apply) are exported for unit tests; only read/update
 * touch the filesystem. Zero dependencies.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SUBSCRIPTION_PROVIDERS = ["claude", "cursor", "codex"];
export const METERED_PROVIDERS = ["anthropic", "cursor", "codex", "opencode"];
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
      if (provider === "claude" && next.claude) delete next.claude.monthly_usd;
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

/** The subset the Settings surface edits, resolved from a parsed config. */
export function editableCostConfig(config) {
  const subscriptions = {};
  for (const p of SUBSCRIPTION_PROVIDERS) {
    const sub = config?.subscriptions?.[p];
    let v = sub && typeof sub === "object" ? sub.monthly_usd : sub;
    if (p === "claude" && !validUsd(v)) v = config?.claude?.monthly_usd;
    subscriptions[p] = validUsd(v) ? v : null;
  }
  const metered = {};
  for (const p of METERED_PROVIDERS) {
    const months = config?.metered?.[p];
    metered[p] = {};
    if (months && typeof months === "object") {
      for (const [period, v] of Object.entries(months)) {
        if (PERIOD_RE.test(period) && validUsd(v)) metered[p][period] = v;
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
  writeFileSync(configPath(repo), JSON.stringify(next, null, 2) + "\n", "utf8");
  return { ok: true, config: next };
}
