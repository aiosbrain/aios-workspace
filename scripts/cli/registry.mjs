/**
 * The single declarative `aios` command registry. Tests enforce unique names, cold metadata,
 * lazy loaders, resolution modes, argument adaptation, usage, and exit semantics.
 *
 * @typedef {Object} CommandDescriptor
 * @property {string}   name
 * @property {string[]} [aliases]
 * @property {"diagnostic"|"pre-config"|"update-root"|"offline"|"workspace"} resolution
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
import { commandMetadata as M } from "./command-contract.mjs";
import { commandIndex, nearestName, renderCommandUsage } from "./registry-lookup.mjs";
import { DIAGNOSTIC_COMMANDS } from "./diagnostic-commands.mjs";
import { LINEAR_COMMANDS as LC } from "./linear-commands.mjs";
import { SLACK_COMMANDS as SC } from "./slack-commands.mjs";
import { HIDDEN_COMMANDS } from "./hidden-commands.mjs";

/** @type {CommandDescriptor[]} Help order; hidden commands (`usage: []`) stay last. */
export const COMMANDS = [
  ...DIAGNOSTIC_COMMANDS,
  {
    name: "status",
    metadata: M`status core.cli workspace brain required human-or-json requires-workspace`,
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdStatus(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U.status,
  },
  {
    // AIO-864 follow-up: the OGR validators live in the TOOLKIT (a workspace's validation/
    // holds only secret-patterns.txt). Offline — a workspace is validated before it is
    // configured; cwdFallback so `aios validate <path>` (and `--help`) works from anywhere.
    // A bare `aios validate` with no workspace above cwd still gets "could not locate repo root".
    name: "validate",
    metadata: M`validate core.cli optional none never human-or-json offline`,
    resolution: "offline",
    cwdFallback: (rest) => rest.some((a) => !a.startsWith("-") || a === "-h" || a === "--help"),
    loader: () => import("../validate-cmd.mjs"),
    adapt: (ctx, mod) => mod.cmdValidate(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U.validate,
  },
  {
    name: "onboard",
    metadata: M`onboard core.cli optional optional optional human-or-json offline`,
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
    metadata: M`connect core.cli optional none required human offline`,
    resolution: "offline",
    agentWorkspaceFallback: true,
    // AIO-1067: `aios connect linear` works from ANY directory (user-level reference mode).
    cwdFallback: (rest) => rest[0] === "linear",
    adapt: (ctx) => ctx.local.cmdConnect(ctx.repo, ctx.rest),
    usage: U.connect,
  },
  LC.disconnect,
  LC.linear,
  SC.slack,
  {
    name: "review",
    metadata: M`review core.cli workspace brain required human requires-workspace`,
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdReview(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U.review,
  },
  {
    name: "push",
    metadata: M`push core.cli workspace brain required human requires-workspace`,
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdPush(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U.push,
  },
  {
    name: "work",
    metadata: M`work core.cli workspace brain required human requires-workspace`,
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdWork(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U.work,
  },
  {
    name: "pull",
    metadata: M`pull core.cli workspace brain required human requires-workspace`,
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdPull(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.pull,
  },
  {
    name: "promote",
    metadata: M`promote core.cli workspace brain required human requires-workspace`,
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
    metadata: M`install-skill core.cli optional brain required human offline`,
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdInstallSkill(ctx.repo, ctx.rest),
    usage: U["install-skill"],
  },
  {
    name: "query",
    metadata: M`query core.cli workspace brain required human-or-json requires-workspace`,
    resolution: "workspace",
    agentWorkspaceFallback: true,
    adapt: (ctx) => ctx.local.cmdQuery(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.query,
  },
  {
    name: "member",
    metadata: M`member core.cli workspace brain required human-or-json requires-workspace`,
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
    metadata: M`stakeholders core.cli workspace brain required human-or-json requires-workspace`,
    resolution: "workspace",
    agentWorkspaceFallback: true,
    adapt: (ctx) => ctx.local.cmdStakeholders(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.stakeholders,
  },
  {
    name: "loop",
    metadata: M`loop core.cli optional optional optional human offline`,
    resolution: "offline",
    loader: () => import("../loop.mjs"),
    adapt: (ctx, mod) => mod.cmdLoop(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.loop,
  },
  {
    // Owns `--repo`: repeatable TARGET repo paths (workspace root = cwd walk-up/--workspace).
    name: "timeline",
    metadata: M`timeline core.cli optional optional optional human-or-json offline`,
    resolution: "offline",
    ownsRepoFlag: true,
    loader: () => import("../timeline.mjs"),
    adapt: async (ctx, mod) => (await mod.cmdTimeline(ctx.repo, ctx.cfg, ctx.rest)) ?? 0,
    exit: "exit-code",
    usage: U.timeline,
  },
  {
    name: "mcp", // stdio MCP server for agents that can't shell out; env-first, owns the process
    metadata: M`mcp core.cli none optional optional protocol pre-config`,
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
    metadata: M`analyze core.cli optional optional optional human-or-json offline`,
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
    metadata: M`maturity-week core.cli optional optional optional human-or-json offline`,
    resolution: "offline",
    loader: () => import("../maturity-week-cmd.mjs"),
    adapt: (ctx, mod) => mod.cmdMaturityWeek(ctx.repo, ctx.rest),
    usage: U["maturity-week"],
  },
  {
    name: "instincts",
    metadata: M`instincts core.cli optional optional optional human-or-json offline`,
    resolution: "offline",
    loader: () => import("../instincts.mjs"),
    adapt: (ctx, mod) => mod.cmdInstincts(ctx.repo, ctx.rest),
    usage: U.instincts,
  },
  {
    name: "time",
    metadata: M`time core.cli optional optional optional human-or-json offline`,
    resolution: "offline",
    loader: () => import("../time.mjs"),
    adapt: (ctx, mod) => mod.cmdTime(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.time,
  },
  {
    name: "asks",
    metadata: M`asks core.cli optional optional optional human-or-json offline`,
    resolution: "offline",
    loader: () => import("../asks.mjs"),
    adapt: (ctx, mod) => mod.cmdAsks(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.asks,
  },
  {
    name: "transcripts",
    metadata: M`transcripts core.cli workspace optional optional human requires-workspace`,
    resolution: "workspace",
    loader: () => import("../transcripts.mjs"),
    adapt: (ctx, mod) => mod.cmdTranscripts(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.transcripts,
  },
  {
    name: "pm",
    metadata: M`pm core.cli workspace provider required human-or-json requires-workspace`,
    resolution: "workspace",
    agentWorkspaceFallback: true,
    loader: () => import("../pm.mjs"),
    adapt: (ctx, mod) => mod.cmdPm(ctx.cfg, ctx.rest),
    usage: U.pm,
  },
  {
    name: "mode",
    metadata: M`mode core.cli optional none never human offline`,
    resolution: "offline",
    loader: () => import("../mode.mjs"),
    adapt: (ctx, mod) => mod.cmdMode(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.mode,
  },
  {
    name: "decisions",
    metadata: M`decisions core.cli optional none never human-or-json offline`,
    resolution: "offline",
    loader: () => import("../decisions.mjs"),
    adapt: (ctx, mod) => mod.cmdDecisions(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.decisions,
  },
  {
    name: "council",
    metadata: M`council core.cli optional optional optional human offline`,
    resolution: "offline",
    loader: () => import("../council.mjs"),
    adapt: (ctx, mod) => mod.runCouncil(ctx.repo, ctx.rest),
    usage: U.council,
  },
  {
    name: "verify",
    metadata: M`verify core.cli optional none never human-or-json offline`,
    resolution: "offline",
    loader: () => import("../verify.mjs"),
    adapt: (ctx, mod) => mod.cmdVerify(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U.verify,
  },
  {
    name: "export-okf",
    metadata: M`export-okf core.cli optional none never human offline`,
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdExportOkf(ctx.repo, ctx.cfg, ctx.rest),
    usage: U["export-okf"],
  },
  {
    name: "pull-bundle",
    metadata: M`pull-bundle core.cli workspace brain required human requires-workspace`,
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdPullBundle(ctx.repo, ctx.cfg, ctx.rest),
    usage: U["pull-bundle"],
  },
  {
    name: "graph",
    metadata: M`graph core.cli optional none never human-or-json offline`,
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdGraph(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.graph,
  },
  {
    name: "skills",
    metadata: M`skills core.cli optional none never human offline`,
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdSkills(ctx.repo, ctx.rest),
    usage: U.skills,
  },
  {
    name: "assess-codebase",
    metadata: M`assess-codebase core.cli optional none never human-or-json offline`,
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdAssessCodebase(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U["assess-codebase"],
  },
  {
    name: "context-health",
    metadata: M`context-health core.cli optional none never human-or-json offline`,
    resolution: "offline",
    loader: () => import("../context-health.mjs"),
    adapt: (ctx, mod) => mod.runContextHealthCli(ctx.repo, ctx.rest, ctx.local.c),
    usage: U["context-health"],
  },
  {
    name: "codebase-health", // AIO-605 composed structural scorer — read-only; exit 0 on scoring
    metadata: M`codebase-health core.cli optional none never human-or-json offline`,
    resolution: "offline",
    loader: () => import("../codebase-health.mjs"),
    adapt: (ctx, mod) => mod.runCodebaseHealthCli(ctx.repo, ctx.rest, ctx.local.c),
    usage: U["codebase-health"],
  },
  {
    name: "worktree",
    metadata: M`worktree core.cli optional none never human-or-json offline`,
    resolution: "offline",
    loader: () => import("../worktree.mjs"),
    adapt: (ctx, mod) => mod.cmdWorktree(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.worktree,
  },
  {
    name: "update",
    metadata: M`update core.cli user-or-workspace none required human-or-json offline`,
    // Resolves a workspace OR the toolkit checkout — never a bare dir; --repo validated same
    // way. cmdUpdate returns a structured result (never exits; callers read .applyAllowed).
    resolution: "update-root",
    loader: () => import("../update.mjs"),
    adapt: async (ctx, mod) => (await mod.cmdUpdate(ctx.repo, ctx.cfg, ctx.rest)).exitStatus,
    exit: "exit-status",
    usage: U.update,
  },
  {
    name: "rails",
    metadata: M`rails core.cli optional none never human-or-json offline`,
    resolution: "offline",
    loader: () => import("../rails.mjs"),
    adapt: (ctx, mod) => mod.cmdRails(ctx.repo, ctx.cfg, ctx.rest),
    exit: "exit-status",
    usage: U.rails,
  },
  {
    name: "learn",
    metadata: M`learn core.cli optional none never human offline`,
    resolution: "offline",
    adapt: (ctx) => ctx.local.cmdLearn(ctx.repo, ctx.cfg, ctx.patterns, ctx.rest),
    usage: U.learn,
  },
  {
    name: "relay",
    metadata: M`relay core.cli optional optional optional human offline`,
    resolution: "offline",
    loader: () => import("../relay.mjs"),
    adapt: (ctx, mod) => mod.cmdRelay(ctx.repo, ctx.rest),
    usage: U.relay,
  },
  DT.build,
  {
    name: "simplify",
    metadata: M`simplify core.cli optional none never human offline`,
    resolution: "offline",
    loader: () => import("../simplify.mjs"),
    adapt: (ctx, mod) => mod.cmdSimplify(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U.simplify,
  },
  DT.spec,
  {
    name: "pr",
    metadata: M`pr core.cli optional none required human-or-json offline`,
    resolution: "offline",
    ownsRepoFlag: true, // its `--repo` is a GitHub owner/repo slug, NOT the workspace path
    loader: () => import("../pr.mjs"),
    adapt: (ctx, mod) => mod.cmdPr(ctx.repo, ctx.rest),
    usage: U.pr,
  },
  DT["consolidate-findings"],
  {
    name: "review-bugbot",
    metadata: M`review-bugbot core.cli optional optional optional human-or-json offline`,
    resolution: "offline",
    loader: () => import("../review-bugbot.mjs"),
    adapt: (ctx, mod) => mod.cmdReviewBugbot(ctx.repo, ctx.rest),
    usage: U["review-bugbot"],
  },
  DT.ship,
  DT["roadmap-run"],
  {
    name: "inbox", // headline V1 surface — unreachable from `aios --help` until UX audit S3-8
    metadata: M`inbox core.cli optional optional optional human-or-json offline`,
    resolution: "offline",
    loader: () => import("../inbox.mjs"),
    adapt: (ctx, mod) => mod.cmdInbox(ctx.repo, ctx.cfg, ctx.rest),
    usage: U.inbox,
  },
  {
    name: "delivery", // AIO-579 read-only reconciliation; owns `--repo` (a GitHub slug filter)
    metadata: M`delivery core.cli optional none required human-or-json offline`,
    resolution: "offline",
    ownsRepoFlag: true,
    loader: () => import("../delivery-status.mjs"),
    adapt: (ctx, mod) => mod.cmdDelivery(ctx.repo, ctx.cfg, ctx.rest),
    exit: "exit-code",
    usage: U.delivery,
  },
  {
    name: "repo-bootstrap", // AIO-602 split stamp — SOURCE is this toolkit checkout; TARGET positional
    metadata: M`repo-bootstrap core.cli optional none never human offline`,
    resolution: "offline",
    cwdFallback: () => true,
    loader: () => import("../repo-bootstrap.mjs"),
    adapt: (ctx, mod) => mod.cmdRepoBootstrap(ctx.rest),
    exit: "exit-code",
    usage: U["repo-bootstrap"],
  },

  // ── hidden (no help text; reachable but undocumented) — see hidden-commands.mjs ────
  ...HIDDEN_COMMANDS,
];

const BY_NAME = commandIndex(COMMANDS);

/** @returns {CommandDescriptor|undefined} */
export function findCommand(name) {
  return BY_NAME.get(name);
}

/** Every dispatchable verb (names + aliases), for did-you-mean. */
export function commandNames() {
  return [...BY_NAME.keys()];
}

export function nearestCommand(input) {
  return nearestName(commandNames(), input);
}

/** The full `aios help` text, derived from the descriptors. No other source exists. */
export function renderUsage() {
  return renderCommandUsage(COMMANDS, USAGE_HEADER, USAGE_FOOTER);
}
