/**
 * roadmap-run.mjs — `aios roadmap-run`: a serial Linear walker that ships one unblocked issue
 * at a time via `aios ship --auto --auto-merge`, then advances the board.
 *
 * `aios ship`'s documented SHIP_EXIT table IS the interface: spawnShip runs ship as a child
 * process and the exit code decides continue / skip / halt (ROADMAP_DECISION). Selection is a
 * pure function over the candidate pool (unblocked, unassigned, Todo, by priority then oldest),
 * using the PROVEN blockedBy direction (§ linear-client.normalizeBlockedBy). Every run writes a
 * deterministic morning digest — the digest can never be the reason a run fails.
 *
 * Zero runtime deps; ESM only.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { c, callClaudeAgent, NO_TOOLS_ARGS } from "./relay-core.mjs";
import { SHIP_EXIT } from "./ship.mjs";
import { resolveLoopModels } from "./loop-models.mjs";
import { createLinearClient, resolveLinearApiKey, normalizeBlockedBy } from "./linear-client.mjs";

const DEFAULT_MAX_ISSUES = 3;
const ISSUE_RE = /^AIO-\d+$/;

// ── pure helpers (exported for tests) ───────────────────────────────────────────────────────

export function parseRoadmapArgs(args) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const hasFlag = (name) => args.includes(name);

  const out = {
    help: hasFlag("--help") || hasFlag("-h"),
    dryRun: hasFlag("--dry-run"),
    commentDigest: hasFlag("--comment-digest"),
    error: null,
    sourceType: null,
    sourceValue: null,
    maxIssues: DEFAULT_MAX_ISSUES,
    digestTarget: null,
  };
  if (out.help) return out;

  const label = flag("--label");
  const epic = flag("--epic");
  const project = flag("--project");
  const sources = [
    ["label", label],
    ["epic", epic],
    ["project", project],
  ].filter(([, v]) => v != null && v !== "");
  if (sources.length !== 1) {
    out.error =
      "exactly one source is required: --label <name> | --epic AIO-<n> | --project <name>";
    return out;
  }
  out.sourceType = sources[0][0];
  out.sourceValue = sources[0][1];

  const maxRaw = parseInt(flag("--max-issues") ?? String(DEFAULT_MAX_ISSUES), 10);
  out.maxIssues = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : DEFAULT_MAX_ISSUES;

  if (out.sourceType === "epic" && !ISSUE_RE.test(epic)) {
    out.error = `invalid --epic '${epic}' — expected AIO-<number>.`;
    return out;
  }

  const explicitTarget = flag("--digest-target");
  if (explicitTarget != null && explicitTarget !== "" && !ISSUE_RE.test(explicitTarget)) {
    out.error = `invalid --digest-target '${explicitTarget}' — expected AIO-<number>.`;
    return out;
  }

  // Digest-target resolution — usage-checked at parse time. --comment-digest requires an
  // unambiguous target: legal only with --epic (target = that epic) or an explicit
  // --digest-target. --comment-digest with --label/--project and no target → usage error.
  if (out.commentDigest) {
    if (explicitTarget) {
      out.digestTarget = explicitTarget;
    } else if (out.sourceType === "epic") {
      out.digestTarget = out.sourceValue;
    } else {
      out.error =
        "--comment-digest needs a target: use --epic (comments on the epic) or pass " +
        "--digest-target AIO-<n> (with --label/--project the target is ambiguous).";
      return out;
    }
  } else {
    out.digestTarget = explicitTarget || null;
  }
  return out;
}

// Every blockedBy blocker must be completed. Accepts a normalized issue (issue.blockedBy) or a
// raw node (inverseRelations) — falls back to normalizeBlockedBy so both shapes work.
export function isUnblocked(issue) {
  const blockers = issue?.blockedBy ?? normalizeBlockedBy(issue);
  return blockers.every((b) => b.stateType === "completed");
}

// Effective priority for ordering: Linear priority 1=urgent … 4=low; 0/none sorts LAST.
function effectivePriority(issue) {
  const p = issue?.priority;
  return p == null || p === 0 ? 999 : p;
}

// The single ranking used by BOTH the live run and `--dry-run` so the preview can never show a
// different order than what ships. Filters to eligible (unblocked, unassigned, Todo) then orders
// by priority, ties broken by oldest createdAt (a MISSING createdAt sorts LAST, via Infinity —
// consistent in both callers). Pure; exported.
export function rankEligible(candidates) {
  const eligible = (candidates ?? []).filter(
    (i) => i?.state?.type === "unstarted" && !i.assignee && isUnblocked(i)
  );
  return eligible.slice().sort((a, b) => {
    const pa = effectivePriority(a);
    const pb = effectivePriority(b);
    if (pa !== pb) return pa - pb;
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : Infinity;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : Infinity;
    return ta - tb; // oldest first
  });
}

// Pure selection: top unblocked, unassigned, Todo (unstarted) candidate — by priority, ties
// broken by oldest createdAt. Returns the issue or null.
export function selectNextIssue(candidates, { now } = {}) {
  void now; // selection is deterministic off createdAt; `now` kept for signature stability
  return rankEligible(candidates)[0] ?? null;
}

// Classify why a candidate was NOT selected (for the digest's "skipped candidates" section).
export function skipReason(issue) {
  if (issue?.assignee) return "assigned";
  if (issue?.state?.type !== "unstarted")
    return `not-Todo (${issue?.state?.name ?? issue?.state?.type ?? "?"})`;
  if (!isUnblocked(issue)) {
    const blocker = (issue.blockedBy ?? normalizeBlockedBy(issue)).find(
      (b) => b.stateType !== "completed"
    );
    return `blocked by ${blocker?.identifier ?? "?"} (state ${blocker?.stateType ?? "?"})`;
  }
  return "not selected this round";
}

// SHIP_EXIT → roadmap action. continue advances; skip escalates + moves on; halt stops the run.
export const ROADMAP_DECISION = {
  [SHIP_EXIT.OK]: "continue",
  [SHIP_EXIT.USAGE]: "halt",
  [SHIP_EXIT.RECON_FAILED]: "skip",
  [SHIP_EXIT.PLAN_UNAPPROVED]: "skip",
  [SHIP_EXIT.PLAN_REJECTED]: "halt",
  [SHIP_EXIT.PLAN_GATE_BLOCKED]: "halt",
  [SHIP_EXIT.BUILD_FAILED]: "skip",
  [SHIP_EXIT.BUILD_NONCONVERGENCE]: "skip",
  [SHIP_EXIT.PR_FAILED]: "halt",
  [SHIP_EXIT.REVIEW_NONCONVERGENCE]: "skip",
  [SHIP_EXIT.MERGE_BLOCKED]: "skip",
  [SHIP_EXIT.SAFETY_BLOCKED]: "skip",
  [SHIP_EXIT.MERGE_GATE_BLOCKED]: "halt",
  [SHIP_EXIT.MERGE_REJECTED]: "halt",
  [SHIP_EXIT.CLEANUP_FAILED]: "halt",
};

// Fail-safe default: an unknown exit code halts.
export function decideFromShipExit(code) {
  return ROADMAP_DECISION[code] ?? "halt";
}

// A short human reason for a non-OK ship exit (for the digest + Linear comment).
export function shipExitLabel(code) {
  const entry = Object.entries(SHIP_EXIT).find(([, v]) => v === code);
  return entry ? entry[0] : `UNKNOWN(${code})`;
}

// ── deterministic digest ───────────────────────────────────────────────────────────────────
// buildDigest is always deterministic — a model may PREPEND prose in cmdRoadmapRun, but the
// digest can never be the reason a run fails (deterministicOnly needs no model).
export function buildDigest(records, { date, deterministicOnly } = {}) {
  void deterministicOnly;
  const r = records ?? {};
  const merged = r.merged ?? [];
  const blocked = r.blocked ?? [];
  const refused = r.refused ?? [];
  const skipped = r.skipped ?? [];
  const lines = [
    `# Roadmap run — ${date ?? "unknown-date"}`,
    `Source: ${r.source ?? "?"}   Issues attempted: ${r.attempted ?? 0}/${r.max ?? 0}`,
    "",
    "## Merged",
    ...(merged.length
      ? merged.map((m) => `- ${m.issue} — ${m.pr ? `PR ${m.pr}` : "(merged)"}`)
      : ["- (none)"]),
    "",
    "## Blocked on operator",
    ...(blocked.length
      ? blocked.map((b) => `- ${b.issue} — ${b.reason} (SHIP_EXIT ${b.code})`)
      : ["- (none)"]),
    "",
    "## Refused to touch",
    ...(refused.length
      ? refused.map((x) => `- ${x.issue} — safety review withheld`)
      : ["- (none)"]),
    "",
    "## Skipped candidates",
    ...(skipped.length ? skipped.map((s) => `- ${s.issue} — ${s.reason}`) : ["- (none)"]),
    "",
  ];
  return lines.join("\n");
}

// ── default dep impls ────────────────────────────────────────────────────────────────────────

function defaultGitExec(argv, cwd) {
  return execFileSync("git", argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Run `aios ship <id> --auto --auto-merge` as a child; its SHIP_EXIT is the interface.
function defaultSpawnShip(repo, id) {
  const aios = path.join(path.dirname(fileURLToPath(import.meta.url)), "aios.mjs");
  try {
    execFileSync(process.execPath, [aios, "ship", id, "--auto", "--auto-merge", "--repo", repo], {
      stdio: "inherit",
    });
    return SHIP_EXIT.OK;
  } catch (e) {
    return e.status ?? SHIP_EXIT.USAGE;
  }
}

// The digest prose model. Runs at the NO_TOOLS tier: the prompt embeds the deterministic digest,
// which carries Linear issue titles (untrusted) — a prompt-injection payload must not gain any
// filesystem access. Wrapped by the caller's try/catch so a failure never blocks the run (the
// deterministic digest is always the fallback). callClaudeAgent strips ANTHROPIC_API_KEY → Claude
// Code login auth, matching ship's recon/safety stance.
function defaultCallDigestAgent(prompt, timeoutMs, opts = {}) {
  return callClaudeAgent(prompt, timeoutMs, { model: opts.model, extraArgs: NO_TOOLS_ARGS });
}

function defaultWriteDigest(repo, date, text) {
  const dir = path.join(repo, ".aios", "loop");
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `roadmap-digest-${date}.md`);
  writeFileSync(p, text);
  return p;
}

function isoDate(now) {
  const d = now ? now() : new Date();
  return d.toISOString().slice(0, 10);
}

async function listBySource(linear, { sourceType, sourceValue }) {
  if (sourceType === "label") return linear.listIssues({ label: sourceValue });
  if (sourceType === "epic") return linear.listIssues({ epicIdentifier: sourceValue });
  return linear.listIssues({ project: sourceValue });
}

// ── public entry ──────────────────────────────────────────────────────────────────────────────

function usage() {
  console.log(
    [
      "",
      c.blue("aios roadmap-run — serial Linear walker: ship one unblocked issue at a time"),
      "",
      "usage:",
      "  aios roadmap-run (--label <name> | --epic AIO-<n> | --project <name>) [options]",
      "",
      "options:",
      "  --max-issues N        max issues to ship this run (default: 3)",
      "  --comment-digest      post the digest as a comment on the resolved target",
      "  --digest-target AIO-<n>  explicit digest comment target (required for --comment-digest",
      "                        with --label/--project; with --epic the target defaults to the epic)",
      "  --dry-run             list ordered candidates + reasoning, then stop",
      "",
      "Requires LINEAR_API_KEY (reached via dotenvx). A digest is written every run to",
      "  .aios/loop/roadmap-digest-<date>.md — even a zero-issue run.",
    ].join("\n")
  );
}

/**
 * cmdRoadmapRun(repo, args, deps={}) → numeric exit code. Dispatch owns process.exit.
 */
export async function cmdRoadmapRun(repo, args, deps = {}) {
  const opts = parseRoadmapArgs(args);
  if (opts.help) {
    usage();
    return 0;
  }
  if (opts.error) {
    console.error(c.red(`error: ${opts.error}`));
    return 1;
  }

  const now = deps.now ?? (() => new Date());
  const date = isoDate(now);
  const writeDigest = deps.writeDigest ?? ((d, text) => defaultWriteDigest(repo, d, text));

  // Linear client — required (except when a fake is injected). A missing key is a clean,
  // actionable message (no stack trace), never a crash.
  let linear = deps.linear;
  if (!linear) {
    const apiKey = resolveLinearApiKey(repo);
    if (!apiKey) {
      console.error(c.red("error: LINEAR_API_KEY is not set — required for `aios roadmap-run`."));
      console.error(c.dim("Set it in your environment (dotenvx injects it) and retry."));
      return 1;
    }
    linear = createLinearClient({ apiKey });
  }

  const selector = `${opts.sourceType}:${opts.sourceValue}`;

  // ── dry-run: list ordered candidates + reasoning, then stop. ──
  if (opts.dryRun) {
    let candidates;
    try {
      candidates = await listBySource(linear, opts);
    } catch (e) {
      console.error(c.red(`error: could not list issues (${selector}): ${e.message}`));
      return 1;
    }
    // Rank via the SAME rankEligible the live run uses — the preview cannot drift from selection.
    const ordered = rankEligible(candidates);
    const eligible = ordered;
    console.log(c.blue(`\naios roadmap-run — dry-run (${selector})`));
    console.log(
      `Candidates: ${candidates.length}   eligible: ${eligible.length}   max: ${opts.maxIssues}\n`
    );
    console.log("Ordered eligible (would ship top-down):");
    if (!ordered.length) console.log("  (none eligible)");
    for (const i of ordered.slice(0, opts.maxIssues)) {
      console.log(`  ${i.identifier}  p${i.priority ?? "?"}  ${i.title ?? ""}`);
    }
    console.log("\nSkipped (not eligible):");
    const skipped = candidates.filter((i) => !eligible.includes(i));
    if (!skipped.length) console.log("  (none)");
    for (const i of skipped) console.log(`  ${i.identifier} — ${skipReason(i)}`);
    return 0;
  }

  // ── real serial run ──
  const spawnShip = deps.spawnShip ?? ((id) => defaultSpawnShip(repo, id));
  const gitExec = deps.gitExec ?? defaultGitExec;

  const records = {
    source: selector,
    attempted: 0,
    max: opts.maxIssues,
    merged: [],
    blocked: [],
    refused: [],
    skipped: [],
  };
  const attemptedIds = new Set();
  // Non-zero on any abnormal stop so cron/systemd sees the failure. A ship `halt` surfaces its
  // original SHIP_EXIT code; infra failures (issue list, ff-only) surface an informative code.
  // The digest + comment still run to completion first — this is returned AFTER them.
  let exitCode = 0;

  for (let n = 0; n < opts.maxIssues; n++) {
    let candidates;
    try {
      candidates = await listBySource(linear, opts);
    } catch (e) {
      console.error(c.red(`error: could not list issues (${selector}): ${e.message}`));
      exitCode = 1;
      break;
    }
    // Never re-pick an issue we already attempted this run (avoids a stuck-issue loop).
    const pool = candidates.filter((i) => !attemptedIds.has(i.identifier));
    const next = selectNextIssue(pool, { now });
    if (!next) {
      console.log(c.dim("roadmap-run: no eligible issue remaining — stopping."));
      // Record the skipped candidates for the digest.
      for (const i of pool.filter((x) => x.state?.type === "unstarted")) {
        records.skipped.push({ issue: i.identifier, reason: skipReason(i) });
      }
      break;
    }

    attemptedIds.add(next.identifier);
    records.attempted++;
    console.log(c.blue(`\n▶ shipping ${next.identifier}: ${next.title ?? ""}`));
    const code = await spawnShip(next.identifier);
    const action = decideFromShipExit(code);
    const label = shipExitLabel(code);

    if (action === "continue") {
      records.merged.push({ issue: next.identifier, pr: null });
    } else {
      // Escalate: comment on the issue + record it. SAFETY_BLOCKED is the "refused" bucket.
      const reason = `${action === "halt" ? "halted" : "skipped"} — ${label}`;
      try {
        await linear.addComment(
          next.identifier,
          `\`aios roadmap-run\`: ${reason} (SHIP_EXIT ${code}).`
        );
      } catch (e) {
        console.error(
          c.yellow(`roadmap-run: could not comment on ${next.identifier}: ${e.message}`)
        );
      }
      if (code === SHIP_EXIT.SAFETY_BLOCKED) records.refused.push({ issue: next.identifier });
      else records.blocked.push({ issue: next.identifier, reason: label, code });

      if (action === "halt") {
        console.error(c.red(`roadmap-run: ${next.identifier} → ${label} (halt) — stopping.`));
        // Surface the halt as a non-zero exit (was previously masked as success).
        exitCode = code;
        break;
      }
      console.error(c.yellow(`roadmap-run: ${next.identifier} → ${label} (skip) — advancing.`));
      // Fall through to the between-issue refresh: a skip advances like a merge (a long failed
      // ship can still have moved origin/main), only a halt bypasses it.
    }

    // Between issues (after a merge OR a skip — never after a halt): fast-forward main so the
    // next issue bases off fresh state.
    try {
      gitExec(["fetch", "origin", "main"], repo);
      gitExec(["merge", "--ff-only", "origin/main"], repo);
    } catch (e) {
      console.error(
        c.red(
          `roadmap-run: could not ff-only main after ${next.identifier}: ${e.message} — stopping.`
        )
      );
      // main is not ff-able → the next issue would base off stale state; stop with a failure code.
      exitCode = SHIP_EXIT.CLEANUP_FAILED;
      break;
    }
  }

  // ── digest (deterministic; a model may prepend prose, but never blocks the run) ──
  // The prose model is a real live seam by default (defaultCallDigestAgent), overridable via deps.
  let digestText = buildDigest(records, { date });
  const callDigestAgent = deps.callDigestAgent ?? defaultCallDigestAgent;
  try {
    const models = (deps.resolveModels ?? resolveLoopModels)({ repo });
    const cfg = models.digest;
    const prose = await callDigestAgent(
      `Summarize this roadmap run in 2-3 sentences:\n\n${digestText}`,
      cfg?.timeoutMs ?? 120 * 1000,
      { model: cfg?.model }
    );
    if (prose && prose.trim()) digestText = `${prose.trim()}\n\n${digestText}`;
  } catch (e) {
    console.error(
      c.yellow(`roadmap-run: digest prose failed (${e.message}) — using deterministic digest.`)
    );
  }

  let digestPath = null;
  try {
    digestPath = writeDigest(date, digestText);
    console.log(c.dim(`digest → ${digestPath}`));
  } catch (e) {
    console.error(c.yellow(`roadmap-run: could not write digest: ${e.message}`));
  }

  if (opts.commentDigest && opts.digestTarget) {
    try {
      await linear.addComment(opts.digestTarget, digestText);
      console.log(c.dim(`digest posted to ${opts.digestTarget}`));
    } catch (e) {
      console.error(
        c.yellow(`roadmap-run: could not post digest to ${opts.digestTarget}: ${e.message}`)
      );
    }
  }

  return exitCode;
}

// Direct entrypoint so `node scripts/roadmap-run.mjs --help` works; the normal path is aios.mjs.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const repo = process.cwd();
  const code = await cmdRoadmapRun(repo, args);
  process.exit(code);
}
