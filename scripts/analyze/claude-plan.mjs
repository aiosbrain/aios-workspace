/**
 * claude-plan.mjs — detect the local Claude *subscription* plan + its flat monthly cost.
 *
 * WHY THIS EXISTS: Claude Code subscription usage is NOT billed per token — a Max
 * plan is a flat monthly fee, and any overage draws from "usage credits". None of
 * that is fetchable programmatically: there is no OAuth/SDK endpoint, OAuth tokens
 * are server-restricted to Claude Code + Claude.ai, and the Admin API doesn't (yet)
 * return subscription users (anthropics/claude-code#27780). So for the flat fee we
 * do the best honest thing: read the plan tier Claude Code cached at login and map
 * it to Anthropic's published price — with a config override, because that cached
 * tier can LAG your real plan (it does not re-fetch on upgrade).
 *
 * Precedence: explicit config/env override → keychain/creds-file tier → unknown.
 * The token-estimate cost from metrics.mjs is a separate "API-equivalent value"
 * number and is never conflated with this flat subscription figure.
 *
 * Zero dependencies (Node >= 18).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Anthropic consumer-plan list pricing (USD/month), 2026-07. */
export const PLAN_PRICES = {
  free: 0,
  pro: 20,
  max_5x: 100,
  max_20x: 200,
};

const PLAN_LABELS = {
  free: "Free",
  pro: "Pro",
  max_5x: "Max 5×",
  max_20x: "Max 20×",
  custom: "Custom",
  unknown: "Unknown",
};

/** Read the Claude Code OAuth credential blob (macOS keychain, then creds file). */
function readClaudeCreds() {
  // macOS: stored in the login keychain, not on disk.
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const j = JSON.parse(raw);
    return j.claudeAiOauth || j;
  } catch {
    /* not macOS, or item absent */
  }
  // Linux / others: ~/.claude/.credentials.json
  const file = path.join(os.homedir(), ".claude", ".credentials.json");
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      return j.claudeAiOauth || j;
    } catch {
      /* unreadable */
    }
  }
  return null;
}

/** Map Claude Code's subscriptionType + rateLimitTier to a canonical plan key. */
export function mapPlan(subscriptionType, rateLimitTier) {
  const tier = String(rateLimitTier || "").toLowerCase();
  if (tier.includes("max_20x") || tier.includes("max20")) return "max_20x";
  if (tier.includes("max_5x") || tier.includes("max5")) return "max_5x";
  const sub = String(subscriptionType || "").toLowerCase();
  // subscriptionType alone can't distinguish 5×/20×; default the ambiguous "max"
  // to 5× and rely on the config override (documented) to correct it.
  if (sub === "max") return "max_5x";
  if (sub === "pro") return "pro";
  if (sub === "free") return "free";
  return null;
}

/**
 * @param {{config?: object, env?: NodeJS.ProcessEnv}} [opts]
 *   config: parsed .aios/cost-config.json (see loadCostConfig); env: process.env.
 * @returns {{provider:"claude", billing:"subscription", plan:string, label:string,
 *            monthly_usd:number|null, source:"config"|"keychain"|"unknown", note?:string}}
 */
export function detectClaudePlan({ config = {}, env = process.env } = {}) {
  const cfg = config?.claude || {};

  // 1. Explicit override (env wins over file). This is the escape hatch for a
  //    stale keychain tier — "tell your agent to fix it in config".
  const ovMonthly = env.AIOS_CLAUDE_MONTHLY_USD ?? cfg.monthly_usd;
  const ovPlan = env.AIOS_CLAUDE_PLAN ?? cfg.plan;
  if (ovMonthly != null && Number.isFinite(Number(ovMonthly))) {
    const plan = ovPlan || "custom";
    return {
      provider: "claude",
      billing: "subscription",
      plan,
      label: PLAN_LABELS[plan] || plan,
      monthly_usd: Number(ovMonthly),
      source: "config",
    };
  }
  if (ovPlan && PLAN_PRICES[ovPlan] != null) {
    return {
      provider: "claude",
      billing: "subscription",
      plan: ovPlan,
      label: PLAN_LABELS[ovPlan] || ovPlan,
      monthly_usd: PLAN_PRICES[ovPlan],
      source: "config",
    };
  }

  // 2. Keychain / creds file (best-effort; tier may lag the real plan).
  const creds = readClaudeCreds();
  if (creds) {
    const plan = mapPlan(creds.subscriptionType, creds.rateLimitTier);
    if (plan && PLAN_PRICES[plan] != null) {
      return {
        provider: "claude",
        billing: "subscription",
        plan,
        label: PLAN_LABELS[plan] || plan,
        monthly_usd: PLAN_PRICES[plan],
        source: "keychain",
        note: "plan read from the Claude Code login token — it can lag your real plan (it doesn't re-fetch on upgrade). Override in .aios/cost-config.json → claude.monthly_usd if wrong.",
      };
    }
  }

  // 3. Unknown — never fabricate a dollar figure.
  return {
    provider: "claude",
    billing: "subscription",
    plan: "unknown",
    label: PLAN_LABELS.unknown,
    monthly_usd: null,
    source: "unknown",
    note: "couldn't detect a Claude plan. Set claude.monthly_usd in .aios/cost-config.json to show your flat subscription cost.",
  };
}

/** Load optional per-machine cost config: <repo>/.aios/cost-config.json. */
export function loadCostConfig(repo) {
  if (!repo) return {};
  const file = path.join(repo, ".aios", "cost-config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
