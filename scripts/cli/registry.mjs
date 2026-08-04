/**
 * registry.mjs — declarative command table for `aios` (AIO-512): ONE descriptor per
 * subcommand, replacing the old USAGE string + 45-branch dispatch chain in aios.mjs.
 * Invariants (asserted by test/cli-registry.test.mjs): every name/alias appears exactly
 * once; `resolution` is the ONLY thing deciding repo-root + config resolution (modes are
 * parity-tested — a silently widened mode would run against an unconfigured directory);
 * `loader` is ALWAYS lazy (`aios status` must not parse ship.mjs/build.mjs); `usage` is
 * the exact `aios help` block this command owns ([] = hidden).
 *
 * @typedef {Object} CommandDescriptor
 * @property {string}   name
 * @property {string[]} [aliases]
 * @property {"pre-config"|"update-root"|"offline"|"workspace"} resolution
 * @property {boolean}  [ownsRepoFlag]  true => dispatch must NOT consume `--repo`
 * @property {boolean}  [usesDevtoolsDir] true => dispatch consumes the global devtools selector
 * @property {boolean}  [agentWorkspaceFallback] use AIOS_AGENT_WORKSPACE when cwd is not stamped
 * @property {(rest: string[]) => boolean} [cwdFallback]  offline-only: accept cwd as the root
 * @property {() => Promise<object>} [loader]  lazy module import; omitted for inline handlers
 * @property {(ctx: object, mod: object|null) => Promise<any>} adapt
 * @property {"none"|"exit-code"|"exit-status"} [exit]
 * @property {string[]} usage
 */

import { USAGE_HEADER, USAGE_FOOTER, USAGE_LINES as U } from "./usage.mjs";
import { DEVTOOLS_COMMANDS as DT } from "./devtools-commands.mjs";

/**
 * The command table, in `aios help` order; hidden commands (usage: []) go last. ctx =
 * { repo, cfg, patterns, rest, local }; `local` = handlers still in aios.mjs + helpers.
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
    agentWorkspaceFallback: true,
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
    agentWorkspaceFallback: true,
    adapt: (ctx) => ctx.local.cmdQuery(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.query,
  },
  {
    name: "member",
    resolution: "workspace",
    agentWorkspaceFallback: true,
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
    agentWorkspaceFallback: true,
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
    // Owns `--repo`: repeatable TARGET repo paths (workspace root = cwd walk-up/--workspace).
    ownsRepoFlag: true,
    loader: () => import("../timeline.mjs"),
    adapt: async (ctx, mod) => (await mod.cmdTimeline(ctx.repo, ctx.cfg, ctx.rest)) ?? 0,
    exit: "exit-code",
    usage: U.timeline,
  },
  {
    name: "mcp",
    // Stdio MCP server for agents that can't shell out; env-first, no workspace, owns the process.
    resolution: "pre-config",
    loader: () => import("../brain-mcp.mjs"),
    adapt: async (ctx, mod) => {
      const mcpCfg = mod.resolveBrainConfig();
      if (mcpCfg.missing.length) {
        // Brain unconfigured: still start IF a workspace resolves (local aios_* tools only).
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
    agentWorkspaceFallback: true,
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
    name: "codebase-health", // AIO-605 composed structural scorer — read-only; exit 0 on scoring
    resolution: "offline",
    loader: () => import("../codebase-health.mjs"),
    adapt: (ctx, mod) => mod.runCodebaseHealthCli(ctx.repo, ctx.rest, ctx.local.c),
    usage: U["codebase-health"],
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
    // Resolves a workspace OR the toolkit checkout — never a bare dir; --repo validated same way.
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
  DT.build,
  {
    name: "simplify",
    resolution: "offline",
    loader: () => import("../simplify.mjs"),
    adapt: (ctx, mod) => mod.cmdSimplify(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U.simplify,
  },
  DT.spec,
  {
    name: "pr",
    resolution: "offline",
    ownsRepoFlag: true, // its `--repo` is a GitHub owner/repo slug, NOT the workspace path
    loader: () => import("../pr.mjs"),
    adapt: (ctx, mod) => mod.cmdPr(ctx.repo, ctx.rest),
    usage: U.pr,
  },
  DT["consolidate-findings"],
  {
    name: "review-bugbot",
    resolution: "offline",
    loader: () => import("../review-bugbot.mjs"),
    adapt: (ctx, mod) => mod.cmdReviewBugbot(ctx.repo, ctx.rest),
    usage: U["review-bugbot"],
  },
  DT.ship,
  DT["roadmap-run"],
  {
    name: "inbox", // headline V1 surface — unreachable from `aios --help` until UX audit S3-8
    resolution: "offline",
    loader: () => import("../inbox.mjs"),
    adapt: (ctx, mod) => mod.cmdInbox(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.inbox,
  },
  {
    name: "delivery", // AIO-579 read-only reconciliation; owns `--repo` (a GitHub slug filter)
    resolution: "offline",
    ownsRepoFlag: true,
    loader: () => import("../delivery-status.mjs"),
    adapt: (ctx, mod) => mod.cmdDelivery(ctx.repo, ctx.cfg, ctx.rest),
    exit: "exit-code",
    usage: U.delivery,
  },
  {
    name: "repo-bootstrap", // AIO-602 split stamp — SOURCE is this toolkit checkout; TARGET positional
    resolution: "offline",
    cwdFallback: () => true,
    loader: () => import("../repo-bootstrap.mjs"),
    adapt: (ctx, mod) => mod.cmdRepoBootstrap(ctx.rest),
    exit: "exit-code",
    usage: U["repo-bootstrap"],
  },

  // ── hidden (no help text; reachable but undocumented, exactly as before) ────
  {
    name: "whoami",
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdWhoami(ctx.repo, ctx.cfg),
    usage: U.whoami,
  },
  // AIO-600 GUI seams: gui/server shells `aios gen-catalog|catalog|connector`, never scripts/*.
  {
    name: "gen-catalog",
    resolution: "offline",
    loader: () => import("../gen-catalog.mjs"),
    adapt: (ctx, mod) => mod.generate(ctx.repo),
    usage: [],
  },
  {
    name: "catalog",
    resolution: "offline",
    loader: () => import("../gen-catalog.mjs"),
    adapt: (ctx, mod) => mod.cmdCatalog(ctx.repo, ctx.rest),
    usage: U.catalog,
  },
  {
    name: "connector",
    resolution: "offline",
    loader: () => import("../connector-cli.mjs"),
    adapt: (ctx, mod) => mod.cmdConnector(ctx.repo, ctx.rest),
    exit: "exit-status",
    usage: U.connector,
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
 * The registered verb closest to `input`, or null when nothing is close enough. Same
 * threshold `aios inbox`/`aios asks` use for their subcommands (audit S6-4: `aios statu`
 * used to answer with 176 lines of help and no hint).
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
