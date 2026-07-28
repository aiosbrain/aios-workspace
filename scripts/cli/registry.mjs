/**
 * registry.mjs — the declarative command table for `aios` (AIO-512 Phase 1).
 *
 * ONE descriptor per subcommand. This replaces the hand-maintained USAGE string and the
 * 45-branch if/else-if dispatch chain that used to live at the bottom of scripts/aios.mjs.
 *
 * Invariants (asserted by test/cli-registry.test.mjs):
 *   - Every name/alias appears exactly once.
 *   - `resolution` is the ONLY thing that decides how the repo root + config are resolved;
 *     silently widening a command from "workspace" to "offline" would let it run against an
 *     unconfigured directory, so the modes are parity-tested against the pre-refactor list.
 *   - `loader` is ALWAYS lazy. Nothing in this file may statically import a command module —
 *     that is the whole point: `aios status` must not parse ship.mjs/build.mjs/spec-eval.mjs.
 *   - `usage` is the exact block of `aios help` lines this command owns ([] = hidden).
 *
 * @typedef {Object} CommandDescriptor
 * @property {string}   name
 * @property {string[]} [aliases]
 * @property {"pre-config"|"update-root"|"offline"|"workspace"} resolution
 * @property {boolean}  [ownsRepoFlag]  true => dispatch must NOT consume `--repo`
 * @property {(rest: string[]) => boolean} [cwdFallback]  offline-only: accept cwd as the root
 * @property {() => Promise<object>} [loader]  lazy module import; omitted for inline handlers
 * @property {(ctx: object, mod: object|null) => Promise<any>} adapt
 * @property {"none"|"exit-code"|"exit-status"} [exit]
 * @property {string[]} usage
 */

import { USAGE_HEADER, USAGE_FOOTER, USAGE_LINES as U } from "./usage.mjs";

/**
 * The command table, in `aios help` order. Hidden commands (usage: []) go last.
 *
 * ctx = { repo, cfg, patterns, rest, local } — `local` carries the handlers that still
 * live inside scripts/aios.mjs (Phase 2 extracts them) plus the shared helpers they need.
 *
 * @type {CommandDescriptor[]}
 */
export const COMMANDS = [
  {
    name: "status",
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdStatus(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U.status,
  },
  {
    name: "onboard",
    resolution: "offline",
    cwdFallback: (rest) => rest.includes("--inspect"),
    loader: () => import("../onboard-command.mjs"),
    adapt: (ctx, mod) =>
      mod.cmdOnboard(ctx.repo, ctx.cfg, ctx.rest, {
        connectFlow: ctx.local.connectFlow,
        nextAction: ctx.local.nextAction,
      }),
    usage: U.onboard,
  },
  {
    name: "connect",
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdConnect(ctx.repo, ctx.rest),
    usage: U.connect,
  },
  {
    name: "review",
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdReview(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U.review,
  },
  {
    name: "push",
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdPush(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U.push,
  },
  {
    name: "work",
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdWork(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U.work,
  },
  {
    name: "pull",
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdPull(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.pull,
  },
  {
    name: "promote",
    resolution: "workspace",
    loader: () => import("../promote.mjs"),
    adapt: (ctx, mod) =>
      mod.cmdPromote(ctx.repo, ctx.cfg, ctx.rest, {
        resolveMember: () =>
          ctx.local.resolveMember(ctx.repo, ctx.cfg, ctx.local.loadDotEnv(ctx.repo)),
      }),
    usage: U.promote,
  },
  {
    name: "install-skill",
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdInstallSkill(ctx.repo, ctx.rest),
    usage: U["install-skill"],
  },
  {
    name: "query",
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdQuery(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.query,
  },
  {
    name: "member",
    resolution: "workspace",
    loader: () => import("../member-cli.mjs"),
    adapt: (ctx, mod) =>
      mod.cmdMember(ctx.repo, ctx.cfg, ctx.rest, {
        api: (m, r, b) => ctx.local.api(ctx.cfg, m, r, b),
      }),
    usage: U.member,
  },
  {
    name: "stakeholders",
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdStakeholders(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.stakeholders,
  },
  {
    name: "loop",
    resolution: "offline",
    loader: () => import("../loop.mjs"),
    adapt: (ctx, mod) => mod.cmdLoop(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.loop,
  },
  {
    name: "timeline",
    resolution: "offline",
    // `timeline` owns `--repo` — repeatable TARGET repo paths (its workspace root comes from
    // the cwd walk-up or its own `--workspace`). Consuming it here would hide the override.
    ownsRepoFlag: true,
    loader: () => import("../timeline.mjs"),
    adapt: async (ctx, mod) => (await mod.cmdTimeline(ctx.repo, ctx.cfg, ctx.rest)) ?? 0,
    exit: "exit-code",
    usage: U.timeline,
  },
  {
    name: "mcp",
    // The GUI-surface bridge: a long-lived stdio MCP server for agents that can't shell out
    // to this CLI (Claude Desktop/Cowork/claude.ai — NOT Codex or Conductor, which run real
    // shell sessions and call this CLI directly). It must run with NO workspace —
    // config is env-first — so it resolves nothing and owns the process until the client
    // disconnects.
    resolution: "pre-config",
    loader: () => import("../brain-mcp.mjs"),
    adapt: async (ctx, mod) => {
      const mcpCfg = mod.resolveBrainConfig();
      if (mcpCfg.missing.length) {
        // Brain unconfigured: still start IF a workspace resolves here, exposing local aios_*
        // tools (the Operator Loop collector). brain_* tools return a clear "not configured"
        // error when called. With neither brain config nor a workspace, there's nothing to do.
        // Use the offline resolver so project.yaml / engagement.yaml workspaces are recognized
        // too (matches `aios loop` + the MCP tool's findWorkspaceRoot, not just aios.yaml).
        const ws = ctx.local.findRepoRootOffline(process.cwd());
        if (!ws) {
          ctx.local.die(
            `aios mcp: missing brain config: ${mcpCfg.missing.join(", ")} and no workspace at cwd. ` +
              `Set the brain env (AIOS_BRAIN_URL/AIOS_API_KEY/AIOS_TEAM) or run from a workspace.`
          );
        }
        process.stderr.write(
          `aios mcp: brain not configured (${mcpCfg.missing.join(", ")}); ` +
            `starting in local-only mode — aios_* tools available.\n`
        );
      }
      await mod.runStdio(mcpCfg);
      return 0;
    },
    exit: "exit-code",
    usage: U.mcp,
  },
  {
    name: "analyze",
    resolution: "offline",
    loader: () => import("../analyze/index.mjs"),
    adapt: (ctx, mod) =>
      mod.cmdAnalyze(ctx.repo, ctx.cfg, ctx.rest, {
        api: ctx.local.api,
        resolveMember: ctx.local.resolveMember,
        loadDotEnv: ctx.local.loadDotEnv,
      }),
    usage: U.analyze,
  },
  {
    name: "maturity-week",
    resolution: "offline",
    loader: () => import("../maturity-week-cmd.mjs"),
    adapt: (ctx, mod) => mod.cmdMaturityWeek(ctx.repo, ctx.rest),
    usage: U["maturity-week"],
  },
  {
    name: "instincts",
    resolution: "offline",
    loader: () => import("../instincts.mjs"),
    adapt: (ctx, mod) => mod.cmdInstincts(ctx.repo, ctx.rest),
    usage: U.instincts,
  },
  {
    name: "time",
    resolution: "offline",
    loader: () => import("../time.mjs"),
    adapt: (ctx, mod) => mod.cmdTime(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.time,
  },
  {
    name: "asks",
    resolution: "offline",
    loader: () => import("../asks.mjs"),
    adapt: (ctx, mod) => mod.cmdAsks(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.asks,
  },
  {
    name: "transcripts",
    resolution: "workspace",
    loader: () => import("../transcripts.mjs"),
    adapt: (ctx, mod) => mod.cmdTranscripts(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.transcripts,
  },
  {
    name: "pm",
    resolution: "workspace",
    loader: () => import("../pm.mjs"),
    adapt: (ctx, mod) => mod.cmdPm(ctx.cfg, ctx.rest),
    usage: U.pm,
  },
  {
    name: "mode",
    resolution: "offline",
    loader: () => import("../mode.mjs"),
    adapt: (ctx, mod) => mod.cmdMode(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.mode,
  },
  {
    name: "decisions",
    resolution: "offline",
    loader: () => import("../decisions.mjs"),
    adapt: (ctx, mod) => mod.cmdDecisions(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.decisions,
  },
  {
    name: "council",
    resolution: "offline",
    loader: () => import("../council.mjs"),
    adapt: (ctx, mod) => mod.runCouncil(ctx.repo, ctx.rest),
    usage: U.council,
  },
  {
    name: "verify",
    resolution: "offline",
    loader: () => import("../verify.mjs"),
    adapt: (ctx, mod) => mod.cmdVerify(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U.verify,
  },
  {
    name: "export-okf",
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdExportOkf(ctx.repo, ctx.cfg, ctx.rest),
    usage: U["export-okf"],
  },
  {
    name: "pull-bundle",
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdPullBundle(ctx.repo, ctx.cfg, ctx.rest),
    usage: U["pull-bundle"],
  },
  {
    name: "graph",
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdGraph(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.graph,
  },
  {
    name: "skills",
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdSkills(ctx.repo, ctx.rest),
    usage: U.skills,
  },
  {
    name: "assess-codebase",
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdAssessCodebase(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U["assess-codebase"],
  },
  {
    name: "context-health",
    resolution: "offline",
    loader: () => import("../context-health.mjs"),
    adapt: (ctx, mod) => mod.runContextHealthCli(ctx.repo, ctx.rest, ctx.local.c),
    usage: U["context-health"],
  },
  {
    name: "worktree",
    resolution: "offline",
    loader: () => import("../worktree.mjs"),
    adapt: (ctx, mod) => mod.cmdWorktree(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.worktree,
  },
  {
    name: "update",
    // update resolves a workspace OR the toolkit checkout — never a bare README dir (see
    // findUpdateRoot). An explicit --repo is validated the SAME way, so it can't be pointed
    // at an arbitrary directory to re-vendor governance into.
    resolution: "update-root",
    loader: () => import("../update.mjs"),
    // cmdUpdate returns a structured result (never exits, so callers can read .applyAllowed).
    adapt: async (ctx, mod) => (await mod.cmdUpdate(ctx.repo, ctx.cfg, ctx.rest)).exitStatus,
    exit: "exit-status",
    usage: U.update,
  },
  {
    name: "rails",
    resolution: "offline",
    loader: () => import("../rails.mjs"),
    adapt: (ctx, mod) => mod.cmdRails(ctx.repo, ctx.cfg, ctx.rest),
    exit: "exit-status",
    usage: U.rails,
  },
  {
    name: "learn",
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdLearn(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U.learn,
  },
  {
    name: "relay",
    resolution: "offline",
    loader: () => import("../relay.mjs"),
    adapt: (ctx, mod) => mod.cmdRelay(ctx.repo, ctx.rest),
    usage: U.relay,
  },
  {
    name: "build",
    resolution: "offline",
    loader: () => import("../build.mjs"),
    adapt: (ctx, mod) => mod.cmdBuild(ctx.repo, ctx.rest),
    usage: U.build,
  },
  {
    name: "simplify",
    resolution: "offline",
    loader: () => import("../simplify.mjs"),
    adapt: (ctx, mod) => mod.cmdSimplify(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U.simplify,
  },
  {
    name: "spec",
    resolution: "offline",
    loader: () => import("../spec-eval.mjs"),
    adapt: (ctx, mod) => mod.cmdSpec(ctx.repo, ctx.rest),
    usage: U.spec,
  },
  {
    name: "pr",
    resolution: "offline",
    // `pr` owns its own `--repo` flag — a GitHub owner/repo slug, NOT the workspace path.
    ownsRepoFlag: true,
    loader: () => import("../pr.mjs"),
    adapt: (ctx, mod) => mod.cmdPr(ctx.repo, ctx.rest),
    usage: U.pr,
  },
  {
    name: "consolidate-findings",
    resolution: "offline",
    // Same GitHub-slug `--repo` as `pr` — dispatch must not consume it.
    ownsRepoFlag: true,
    loader: () => import("../consolidate-findings.mjs"),
    adapt: (ctx, mod) => mod.cmdConsolidateFindings(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U["consolidate-findings"],
  },
  {
    name: "review-bugbot",
    resolution: "offline",
    loader: () => import("../review-bugbot.mjs"),
    adapt: (ctx, mod) => mod.cmdReviewBugbot(ctx.repo, ctx.rest),
    usage: U["review-bugbot"],
  },
  {
    name: "ship",
    // ship + roadmap-run take `--repo <path>` as a WORKSPACE path (the generic walk-up, like
    // build/relay) — NOT a GitHub slug — so they are NOT in the pr/consolidate opt-out.
    // Ship derives the GitHub slug internally via detectRepo(repo).
    resolution: "offline",
    loader: () => import("../ship.mjs"),
    adapt: (ctx, mod) => mod.cmdShip(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U.ship,
  },
  {
    name: "roadmap-run",
    resolution: "offline",
    loader: () => import("../roadmap-run.mjs"),
    adapt: (ctx, mod) => mod.cmdRoadmapRun(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U["roadmap-run"],
  },

  // The Unified Inbox is a headline V1 surface; it was unreachable from `aios --help` until the
  // UX audit found that nothing in the CLI's own help mentioned it (S3-8).
  {
    name: "inbox",
    resolution: "offline",
    loader: () => import("../inbox.mjs"),
    adapt: (ctx, mod) => mod.cmdInbox(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.inbox,
  },

  // AIO-579 read-only slice: cross-repo PR/worktree/branch reconciliation. `--repo` here is a
  // GitHub owner/repo slug filter (like pr/consolidate-findings), not the workspace path — it
  // owns the flag for the same reason they do.
  {
    name: "delivery",
    resolution: "offline",
    ownsRepoFlag: true,
    loader: () => import("../delivery-status.mjs"),
    adapt: (ctx, mod) => mod.cmdDelivery(ctx.repo, ctx.cfg, ctx.rest),
    exit: "exit-code",
    usage: U.delivery,
  },

  // ── hidden (no help text; reachable but undocumented, exactly as before) ────
  {
    name: "whoami",
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdWhoami(ctx.repo, ctx.cfg),
    usage: U.whoami,
  },
];

const BY_NAME = new Map();
for (const d of COMMANDS) {
  for (const n of [d.name, ...(d.aliases ?? [])]) {
    if (BY_NAME.has(n)) throw new Error(`aios registry: duplicate command name '${n}'`);
    BY_NAME.set(n, d);
  }
}

/** @returns {CommandDescriptor|undefined} */
export function findCommand(name) {
  return BY_NAME.get(name);
}

/** Every dispatchable verb (names + aliases), for did-you-mean. */
export function commandNames() {
  return [...BY_NAME.keys()];
}

/** Levenshtein distance — small inputs only (command names), so the naive DP is fine. */
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const cur = [i];
    for (let j = 1; j < cols; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[cols - 1];
}

/**
 * The registered verb closest to `input`, or null when nothing is close enough.
 *
 * Mirrors the threshold `aios inbox` / `aios asks` already use for their subcommands — the audit
 * (S6-4) found the capability existed one level down but not at top level, so `aios statu` (a
 * one-character typo) answered with 176 lines of help and no hint.
 */
export function nearestCommand(input) {
  if (!input) return null;
  const ranked = commandNames()
    .map((name) => ({ name, distance: editDistance(input, name) }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  const best = ranked[0];
  return best && best.distance <= Math.max(2, Math.floor(input.length / 3)) ? best.name : null;
}

/** The full `aios help` text, derived from the descriptors. No other source exists. */
export function renderUsage() {
  const lines = [...USAGE_HEADER];
  for (const d of COMMANDS) lines.push(...d.usage);
  lines.push(...USAGE_FOOTER);
  return lines.join("\n");
}
