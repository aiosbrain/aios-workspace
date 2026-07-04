// Timeline repo config — `.aios/timeline-config.json` (AIO-209).
//
// Same posture as `.aios/time-config.json` (src/operator-loop/time/config.ts): repo paths and
// live URLs are per-machine, never committed, and tiering is default-deny — a repo with no
// explicit tier is `team` (visible to the team render only), and only an explicit
// `tier: "external"` lets a repo's items into the shareable external render. Malformed config
// throws loudly rather than silently up-scoping.
//
// Shape:
//   { "repos": { "<abs-or-rel path>": { "tier"?: "admin"|"team"|"external", "alias"?: str, "liveUrl"?: str } } }

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Tier } from "../operator-loop/signal.js";
import type { TimelineRepoConfig } from "./types.js";

export const TIMELINE_CONFIG_REL = ".aios/timeline-config.json";

const TIERS: ReadonlySet<string> = new Set<Tier>(["admin", "team", "external"]);

interface RepoRuleRaw {
  tier?: unknown;
  alias?: unknown;
  liveUrl?: unknown;
}

export interface TimelineConfig {
  /** key = absolute resolved path */
  repos: Map<string, { tier: Tier; alias?: string; liveUrl?: string }>;
}

export function loadTimelineConfig(root: string, overridePath?: string): TimelineConfig {
  const file = overridePath ?? path.join(root, TIMELINE_CONFIG_REL);
  if (!existsSync(file)) return { repos: new Map() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`timeline-config: invalid JSON in ${file}: ${(e as Error).message}`);
  }
  return parseTimelineConfig(parsed, file, root);
}

/** Validate + normalize a parsed config object. Exposed for tests. */
export function parseTimelineConfig(
  parsed: unknown,
  file = "<config>",
  root = "."
): TimelineConfig {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`timeline-config: ${file} must be a JSON object`);
  }
  const o = parsed as Record<string, unknown>;
  const cfg: TimelineConfig = { repos: new Map() };
  if (o.repos === undefined) return cfg;
  if (!o.repos || typeof o.repos !== "object" || Array.isArray(o.repos)) {
    throw new Error(`timeline-config: repos must be an object of path → rule`);
  }
  for (const [k, v] of Object.entries(o.repos as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new Error(`timeline-config: repos[${JSON.stringify(k)}] must be an object`);
    }
    const rule = v as RepoRuleRaw;
    let tier: Tier = "team";
    if (rule.tier !== undefined) {
      if (typeof rule.tier !== "string" || !TIERS.has(rule.tier)) {
        throw new Error(
          `timeline-config: repos[${JSON.stringify(k)}].tier must be admin|team|external`
        );
      }
      tier = rule.tier as Tier;
    }
    const entry: { tier: Tier; alias?: string; liveUrl?: string } = { tier };
    if (rule.alias !== undefined) {
      if (typeof rule.alias !== "string") {
        throw new Error(`timeline-config: repos[${JSON.stringify(k)}].alias must be a string`);
      }
      entry.alias = rule.alias;
    }
    if (rule.liveUrl !== undefined) {
      if (typeof rule.liveUrl !== "string") {
        throw new Error(`timeline-config: repos[${JSON.stringify(k)}].liveUrl must be a string`);
      }
      entry.liveUrl = rule.liveUrl;
    }
    cfg.repos.set(path.resolve(root, k), entry);
  }
  return cfg;
}

/**
 * Merge CLI `--repo <path>[=liveUrl]` arguments with the config file into the final repo list.
 * CLI order is preserved; a CLI liveUrl overrides the config's. Tier/alias come from config
 * (default tier `team`, alias = basename).
 */
export function resolveRepos(
  cliRepos: { path: string; liveUrl?: string }[],
  cfg: TimelineConfig
): TimelineRepoConfig[] {
  return cliRepos.map((r) => {
    const abs = path.resolve(r.path);
    const rule = cfg.repos.get(abs);
    const out: TimelineRepoConfig = {
      path: abs,
      alias: rule?.alias ?? path.basename(abs),
      tier: rule?.tier ?? "team",
    };
    const live = r.liveUrl ?? rule?.liveUrl;
    if (live) out.liveUrl = live;
    return out;
  });
}
