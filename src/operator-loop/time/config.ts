// Time-tracking config + repo scoping (AIO-139).
//
// The allowlist maps ABSOLUTE REALPATHS → { tier, alias }, so scoping can never be fooled by a
// basename collision across worktrees or unrelated repos. Scoping is DEFAULT-DENY by repo: a repo
// that is neither the current workspace nor explicitly allowlisted is EXCLUDED (or admin) — never
// team/external. No private/NDA paths live in committed source; they live only in the git-ignored
// `.aios/time-config.json`. This module defines the shape + the scoping logic and validates the
// config loudly (a malformed config throws rather than silently up-scoping).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Tier } from "../signal.js";

export const TIME_CONFIG_REL = ".aios/time-config.json";
export const DEFAULT_IDLE_GAP_MIN = 25;

/** A repo may be tiered admin/team/external, or explicitly excluded from capture. */
export type RepoTier = Tier | "exclude";
/** How to treat a repo that is neither the current workspace nor allowlisted. */
export type UnknownRepoDefault = "exclude" | "admin";

export interface RepoRule {
  tier: RepoTier;
  alias?: string;
}

export interface TimeConfig {
  repos: Map<string, RepoRule>; // key = canonical absolute realpath
  unknownDefault: UnknownRepoDefault;
  idleGapMin: number;
}

const REPO_TIERS: ReadonlySet<string> = new Set<RepoTier>(["admin", "team", "external", "exclude"]);

export function defaultTimeConfig(): TimeConfig {
  return { repos: new Map(), unknownDefault: "exclude", idleGapMin: DEFAULT_IDLE_GAP_MIN };
}

/** Canonicalize a configured repo key: absolute + realpath when it exists, else absolute literal. */
function canonicalizeKey(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Load `.aios/time-config.json` (or an explicit override path). Missing → safe defaults.
 *  Malformed → throws a clear error (never a silent up-scope). */
export function loadTimeConfig(root: string, overridePath?: string): TimeConfig {
  const file = overridePath ?? path.join(root, TIME_CONFIG_REL);
  if (!existsSync(file)) return defaultTimeConfig();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`time-config: cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`time-config: invalid JSON in ${file}: ${(e as Error).message}`);
  }
  return parseTimeConfig(parsed, file);
}

/** Validate + normalize a parsed config object. Exposed for tests. */
export function parseTimeConfig(parsed: unknown, file = "<config>"): TimeConfig {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`time-config: ${file} must be a JSON object`);
  }
  const o = parsed as Record<string, unknown>;
  const cfg = defaultTimeConfig();

  if (o.idleGapMin !== undefined) {
    if (typeof o.idleGapMin !== "number" || !Number.isFinite(o.idleGapMin) || o.idleGapMin <= 0) {
      throw new Error(`time-config: idleGapMin must be a positive number`);
    }
    cfg.idleGapMin = o.idleGapMin;
  }

  if (o.default !== undefined) {
    if (o.default !== "exclude" && o.default !== "admin") {
      throw new Error(`time-config: default must be "exclude" or "admin"`);
    }
    cfg.unknownDefault = o.default;
  }

  if (o.repos !== undefined) {
    if (!o.repos || typeof o.repos !== "object" || Array.isArray(o.repos)) {
      throw new Error(`time-config: repos must be an object of path → rule`);
    }
    for (const [k, v] of Object.entries(o.repos as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        throw new Error(`time-config: repos[${JSON.stringify(k)}] must be an object`);
      }
      const rule = v as Record<string, unknown>;
      if (typeof rule.tier !== "string" || !REPO_TIERS.has(rule.tier)) {
        throw new Error(
          `time-config: repos[${JSON.stringify(k)}].tier must be admin|team|external|exclude`
        );
      }
      const out: RepoRule = { tier: rule.tier as RepoTier };
      if (rule.alias !== undefined) {
        if (typeof rule.alias !== "string") {
          throw new Error(`time-config: repos[${JSON.stringify(k)}].alias must be a string`);
        }
        out.alias = rule.alias;
      }
      cfg.repos.set(canonicalizeKey(k), out);
    }
  }
  return cfg;
}

export interface ScopeResult {
  capture: boolean;
  tier: Tier; // meaningful only when capture === true
  alias: string;
}

/** True when `child` is `parent` or lives inside it (both canonical absolute paths). */
function contains(parent: string, child: string): boolean {
  if (child === parent) return true;
  const p = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(p);
}

/**
 * Scope a session's canonical cwd realpath → capture decision + tier + display alias.
 *
 * DEFAULT-DENY BY REPO. A cwd is attributed to the LONGEST (most specific) matching path among the
 * allowlist and the current workspace — so an explicit sub-path rule beats a broad parent, and the
 * current workspace defaults to `team` (config may override it, incl. `exclude`). A cwd that
 * matches nothing is excluded (or admin, per `default`), NEVER team. A null cwd is always excluded.
 */
export function scopeRepo(
  cfg: TimeConfig,
  currentWorkspaceRealpath: string,
  cwdRealpath: string | null
): ScopeResult {
  if (!cwdRealpath) return { capture: false, tier: "admin", alias: "unknown" };

  let bestPath: string | null = null;
  let bestRule: RepoRule | null = null;
  const consider = (p: string, rule: RepoRule) => {
    if (contains(p, cwdRealpath) && (bestPath === null || p.length > bestPath.length)) {
      bestPath = p;
      bestRule = rule;
    }
  };

  for (const [p, rule] of cfg.repos) consider(p, rule);
  // The current workspace is a candidate at `team` unless an explicit repos entry already covers
  // its exact path (that entry wins via the loop above and its tier is authoritative).
  if (!cfg.repos.has(currentWorkspaceRealpath)) {
    consider(currentWorkspaceRealpath, { tier: "team" });
  }

  if (bestPath === null || bestRule === null) {
    if (cfg.unknownDefault === "admin") {
      return { capture: true, tier: "admin", alias: path.basename(cwdRealpath) };
    }
    return { capture: false, tier: "admin", alias: path.basename(cwdRealpath) };
  }
  const rule: RepoRule = bestRule;
  const alias = rule.alias ?? path.basename(bestPath);
  if (rule.tier === "exclude") return { capture: false, tier: "admin", alias };
  return { capture: true, tier: rule.tier, alias };
}
