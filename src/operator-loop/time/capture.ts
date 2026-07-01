// Capture (side-effecting): read session logs → derive blocks → scope by realpath (default-deny) →
// tier → merge into the store. This is the ONLY component that reaches outside the workspace (into
// ~/.claude); the pure source just reads the store it writes. First run scaffolds a safe default
// `.aios/time-config.json` (current workspace only, default:"exclude") so scoping is explicit.

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  loadTimeConfig,
  scopeRepo,
  TIME_CONFIG_REL,
  DEFAULT_IDLE_GAP_MIN,
  type RepoRule,
  type TimeConfig,
} from "./config.js";
import { readSessionEvents } from "./session-log.js";
import { deriveBlocks } from "./runtime.js";
import {
  readStore,
  upsertRows,
  writeStore,
  storeRel,
  requireSpineLog,
  rowsEqual,
  type StoreRow,
} from "./store.js";

export interface CaptureOptions {
  root: string;
  now?: Date;
  configPath?: string; // override config file
  projectsDir?: string; // override ~/.claude/projects (tests)
  extraTeamRepos?: string[]; // --repos: additional realpaths allowlisted at `team` for this run
  windowDays?: number; // limit sessions scanned by file mtime (default 30)
  dryRun?: boolean;
}

export interface CaptureSummary {
  totalBlocks: number;
  captured: number; // blocks that passed scoping
  excludedUnlisted: number; // blocks dropped because the repo was not allowlisted
  written: number; // rows added or updated (0 on a no-op)
  rel: string; // store path (workspace-relative)
  dryRun: boolean;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Write a safe default `.aios/time-config.json` on first run (never overwrites an existing one,
 *  and is skipped when an explicit --config path is used). */
function ensureDefaultConfig(root: string, cws: string, configPath?: string): boolean {
  if (configPath) return false;
  const file = path.join(root, TIME_CONFIG_REL);
  if (existsSync(file)) return false;
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const cfg = {
    repos: { [cws]: { tier: "team", alias: path.basename(cws) } },
    default: "exclude",
    idleGapMin: DEFAULT_IDLE_GAP_MIN,
  };
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return true;
}

function withExtraRepos(cfg: TimeConfig, extras: string[] | undefined): TimeConfig {
  if (!extras?.length) return cfg;
  for (const p of extras) {
    const key = safeRealpath(p);
    if (!cfg.repos.has(key)) cfg.repos.set(key, { tier: "team" } as RepoRule);
  }
  return cfg;
}

export function capture(opts: CaptureOptions): CaptureSummary {
  const rel = storeRel(opts.root); // throws clear no-spine error before any work
  const now = opts.now ?? new Date();
  const cws = safeRealpath(opts.root);
  const cfg = withExtraRepos(loadTimeConfig(opts.root, opts.configPath), opts.extraTeamRepos);

  const windowDays = opts.windowDays ?? 30;
  const sinceMs = now.getTime() - windowDays * 86_400_000;
  const events = readSessionEvents({ projectsDir: opts.projectsDir, sinceMs });
  const blocks = deriveBlocks(events, { nowMs: now.getTime(), idleGapMin: cfg.idleGapMin });

  const derived: StoreRow[] = [];
  let excludedUnlisted = 0;
  for (const b of blocks) {
    const scope = scopeRepo(cfg, cws, b.cwdRealpath);
    if (!scope.capture) {
      excludedUnlisted++;
      continue;
    }
    derived.push({
      id: b.id,
      startIso: b.startIso,
      endIso: b.endIso,
      repo: scope.alias,
      runtimeMin: b.runtimeMin,
      tag: b.tag,
      tier: scope.tier,
      confirmed: false,
      taskRef: "",
    });
  }

  const existing = readStore(opts.root).rows;
  const merged = upsertRows(existing, derived);
  const byId = new Map(existing.map((r) => [r.id, r]));
  let written = 0;
  for (const m of merged) {
    const prev = byId.get(m.id);
    if (!prev || !rowsEqual(prev, m)) written++;
  }

  if (!opts.dryRun) {
    ensureDefaultConfig(opts.root, cws, opts.configPath);
    writeStore(opts.root, merged);
  }

  return {
    totalBlocks: blocks.length,
    captured: derived.length,
    excludedUnlisted,
    written,
    rel,
    dryRun: Boolean(opts.dryRun),
  };
}
