/**
 * ship/gates.mjs — the gate-evaluation surface for `aios ship`: the SHIP_EXIT contract, plan/merge
 * gate decisions, the safety-review token/path detection, and the merge-check parser.
 *
 * This module owns the invariant that every gate decision is fail-closed: a blocked/unavailable/
 * unparseable signal never reads as "proceed". `resolveGates` decides plan/merge gate mode from
 * flags + TTY; `readChecks` treats a `gh pr checks` exit that can't be parsed (or an empty result
 * with no red/pending signal) as `unavailable`, never as green; `detectSafetyToken` requires the
 * exact SAFETY_APPROVED token alone on the last non-blank line; `touchesSafetySurface` is the path
 * predicate that decides whether the merge gate requires the safety reviewer at all.
 *
 * Extracted verbatim from scripts/ship.mjs (AIO-560, wave 5 of the safety-unit-extraction pattern
 * — docs/v1-operator-loop/domains/safety-unit-extraction.md). No predicate, tier comparison, or
 * gate-decision branch is edited in this move.
 */
import { existsSync } from "node:fs";
import { EXIT as BUILD_EXIT } from "../build.mjs";
import { parseCheckResults } from "../consolidate-findings.mjs";

// ── SHIP_EXIT — stable, documented exit-code table (docs/agent-build.md) ─────────────────────
export const SHIP_EXIT = {
  OK: 0, // plan→merge→cleanup completed
  USAGE: 1, // bad args / prereqs / unresolved issue id
  RECON_FAILED: 10, // issue fetch or recon model step failed
  SPEC_NOT_READY: 15, // spec-readiness gate failed (deterministic or adversarial blocker)
  PLAN_UNAPPROVED: 20, // plan loop spent its round budget without PLAN_READY
  PLAN_REJECTED: 21, // operator rejected the plan at the plan gate
  PLAN_GATE_BLOCKED: 22, // plan gate active in a non-TTY context without --auto (never hang)
  BUILD_FAILED: 30, // runBuild returned a non-recoverable code (NO_DIFF/FATAL/TIMEOUT/GATE)
  BUILD_NONCONVERGENCE: 31, // runBuild spent its rounds (worktree preserved)
  PR_FAILED: 40, // cmdPr push/create failed
  REVIEW_NONCONVERGENCE: 50, // fix loop hit --max-fix-rounds still BLOCKED (no partial merge)
  MERGE_BLOCKED: 60, // merge gate: CI red/pending/unavailable or unresolved Critical/High
  SAFETY_BLOCKED: 61, // path-gated safety review withheld approval
  MERGE_GATE_BLOCKED: 62, // merge gate active in a non-TTY context without --auto-merge
  MERGE_REJECTED: 63, // operator rejected at the merge gate
  CLEANUP_FAILED: 70, // post-merge ff-only failed / primary checkout dirty (never reset/clobber)
};
export const SAFETY_APPROVED_TOKEN = "SAFETY_APPROVED";
// Diff surfaces where an approval requires an explicit safety review over the diff. A changed
// path matches if it equals a listed file or starts with a listed directory prefix.
export const SAFETY_PATHS = [
  "hooks/",
  "validation/",
  "scripts/leak-gate.sh",
  "scaffold/.claude/",
  "docs/brain-api.md",
  "scripts/brain-client.mjs",
  "scripts/brain-config.mjs",
  "scripts/workspace-parse.mjs",
];
export const CODERABBIT_READY_LABEL = "ready-for-review";
// Gate decision per phase: 'skip' (auto flag), 'approved' (--approve-* after inspecting a
// pending gate), 'prompt' (interactive TTY), or 'blocked' (non-TTY: run UP TO the gate, persist
// a GATE-<name>.pending.md + state, and exit with the gate code — resumable, never hanging).
export function resolveGates({ auto, autoMerge, approvePlan, approveMerge, isTty }) {
  const decide = (autoFlag, approveFlag) =>
    autoFlag ? "skip" : approveFlag ? "approved" : isTty ? "prompt" : "blocked";
  return { plan: decide(auto, approvePlan), merge: decide(autoMerge, approveMerge) };
}
// build.mjs EXIT → ship codes. Pure; exported.
export function mapBuildExit(buildCode) {
  if (buildCode === BUILD_EXIT.OK) return SHIP_EXIT.OK;
  if (buildCode === BUILD_EXIT.NONCONVERGENCE) return SHIP_EXIT.BUILD_NONCONVERGENCE;
  // NO_DIFF / FATAL / TIMEOUT / GATE_FAILED → non-recoverable build failure.
  return SHIP_EXIT.BUILD_FAILED;
}
// The safety reviewer approves by placing SAFETY_APPROVED alone on the final non-blank line.
export function detectSafetyToken(text) {
  const lastLine =
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return lastLine === SAFETY_APPROVED_TOKEN;
}
// True iff any changed path equals a listed file or starts with a listed directory prefix.
export function touchesSafetySurface(paths, safetyPaths = SAFETY_PATHS) {
  const list = paths ?? [];
  return list.some((p) => safetyPaths.some((s) => (s.endsWith("/") ? p.startsWith(s) : p === s)));
}
export function localBugbotEvidenceMatches(
  state,
  { head, baseSha, artifactExists = existsSync } = {}
) {
  return Boolean(
    head &&
    baseSha &&
    state?.localBugbotHead === head &&
    state?.localBugbotBaseSha === baseSha &&
    state?.localBugbotReviewPath &&
    artifactExists(state.localBugbotReviewPath)
  );
}

// ── readChecks — survives a non-zero `gh pr checks` exit ─────────────────────────────────────
// `gh pr checks` exits non-zero when checks are pending (8) or failing (1). ghExec must capture
// stdout even on non-zero exit and NEVER throw for this call. Returns a fail-closed verdict:
//   { ok, red, pending, unavailable, raw }. Empty/unparseable stdout → unavailable (→ MERGE_BLOCKED).
export function readChecks(pr, { ghExec, slug } = {}) {
  const argv = [
    "pr",
    "checks",
    String(pr),
    ...(slug ? ["--repo", slug] : []),
    "--json",
    "name,state,bucket",
  ];
  let res;
  try {
    res = ghExec(argv);
  } catch (e) {
    // A ghExec that throws despite the contract is treated as unavailable (fail closed).
    return {
      ok: false,
      unavailable: true,
      red: false,
      pending: false,
      raw: String(e?.message ?? ""),
    };
  }
  const stdout = res?.stdout ?? "";
  const parsed = parseCheckResults(stdout);
  if (!parsed.parsed) {
    // No usable check data (auth/network/no checks yet/malformed) → fail closed.
    return { ok: false, unavailable: true, red: false, pending: false, raw: stdout };
  }
  // An empty check set with no red/pending signal (e.g. `gh pr checks --json` returns `[]`)
  // means CI has reported NO checks — it is NOT proof of green. Treat it as unavailable so the
  // merge gate fails closed rather than waving a PR through on the absence of any CI data.
  if (parsed.checks.length === 0 && !parsed.ciRed && !parsed.ciPending) {
    return { ok: false, unavailable: true, red: false, pending: false, raw: stdout };
  }
  const ok = !parsed.ciRed && !parsed.ciPending;
  return { ok, unavailable: false, red: parsed.ciRed, pending: parsed.ciPending, raw: stdout };
}

/**
 * Which issue-body `spec_gate` value ship will actually honour.
 *
 * AIO-573 made issue-body frontmatter effective for the FIRST time (it had been masked by the
 * heading `buildSpecTextFromIssue` prepends). That is the documented precedence — but it also
 * means anyone with Linear write access can now change how the readiness gate behaves with no
 * git-reviewed change. So frontmatter may SOFTEN the gate, never disable it, and never soften it
 * where no human will read the warning:
 *
 *   - `off` is never honoured from an issue body. It skips `evaluateSpec` outright. Turning the
 *     gate fully off stays a deliberate act at the CLI (`--spec-gate off` / `--skip-spec-gate`).
 *   - `advisory` is honoured interactively — it still RUNS and records the eval, and a human sees
 *     the warning — but NOT under `--auto`, where `roadmap-run` ships unattended and nobody does.
 *   - Any CLI flag outranks frontmatter entirely, so this returns `undefined` and lets the
 *     documented precedence chain apply. (Checking the CLI first is what stops a `spec_gate: off`
 *     issue body from rejecting a run where the operator explicitly passed `--skip-spec-gate`.)
 *
 * Returns the value to feed the precedence chain, or `undefined` to fall through to it.
 */
export function usableFrontmatterGate(fmGate, opts = {}, c = { yellow: (x) => x }) {
  if (!fmGate || opts.specGate || opts.skipSpecGate) return undefined;
  if (fmGate === "off") {
    console.error(
      c.yellow(
        "warn: ignoring `spec_gate: off` from the issue body — it would disable the readiness " +
          "gate with no repo-side change to review. Pass --skip-spec-gate to mean it."
      )
    );
    return undefined;
  }
  if (fmGate === "advisory" && opts.auto) {
    console.error(
      c.yellow(
        "warn: ignoring `spec_gate: advisory` from the issue body under --auto — an advisory " +
          "warning nobody reads is not a gate. Pass --spec-gate advisory to mean it."
      )
    );
    return undefined;
  }
  return fmGate;
}

/**
 * Read the evaluator frontmatter (`spec_gate`, `eval_tier`) from a Linear issue.
 *
 * `body` MUST be the RAW issue description, never `buildSpecTextFromIssue(issue)` — that
 * prepends a `# <id>: <title>` heading which pushes the frontmatter off the start of the string,
 * so `^---` never matches and every key silently reverts to its default. That trap is pinned for
 * `safety:` in test/ship-spec-eval.test.mjs; it was missed for these two keys until AIO-573, so
 * `spec_gate:` declared in an issue body had never actually reached ship.
 *
 * A malformed value REFUSES rather than guesses. `specEvalHints` is all-or-nothing, so one typo'd
 * key discards every other key — an issue with `eval_tier: full` plus a bad `spec_gate` would
 * silently lose the adversarial layer its author explicitly asked for. Guessing a default there
 * is worse than stopping: `aios spec eval` already exits 4 on the same input, so refusing keeps
 * ship consistent with the CLI instead of quietly diverging from it.
 *
 * The defaults are still returned alongside `invalid` so a caller that chooses to continue lands
 * on the parser's own documented values, never on `{}` — an undefined `tier` would make
 * `evaluateSpec` default `useLlm` to true and re-opt a broken spec INTO the opt-in layer.
 */
export function readSpecFrontmatter(hintsFn, body) {
  try {
    return hintsFn(body);
  } catch (e) {
    // Literal defaults, not a second `hintsFn("")` call: ship injects this dependency, so a stub
    // that throws unconditionally would make the error handler throw from inside itself.
    return { tier: "deterministic", planTraceable: false, specGate: undefined, invalid: e.message };
  }
}

/**
 * Malformed evaluator frontmatter in the issue body — refuse, don't guess.
 *
 * Records the aborted stage before returning: `SHIP_EXIT.USAGE` is a `halt` in roadmap-run, so
 * one typo'd key in one issue body stops an unattended run, and the record stream is the only
 * place that says why (this returns upstream of the `writeAudit`, so `.aios/loop/<issue>/` is
 * empty).
 */
export function badSpecFrontmatter(records, c, message) {
  console.error(c.red(`error: invalid evaluator frontmatter in the issue body — ${message}`));
  records?.stages?.push({ stage: "spec-eval", error: `invalid frontmatter: ${message}` });
  return { code: SHIP_EXIT.USAGE, records };
}

/**
 * The evaluator tier `aios ship` will actually run, given the spec's declaration.
 *
 * Since AIO-573 the adversarial layer is opt-in and ship honours `eval_tier`. Two contexts
 * ESCALATE back to `full` regardless of what the issue declares, because in each the adversarial
 * pass is not a redundant second opinion but the only model review in the run:
 *
 *   - `--loop light` has NO planner and no plan gate (the SPEC_READY spec *is* the approved build
 *     contract, which is why `--spec-gate off` is already refused there). Left deterministic-only,
 *     a light-loop ship would go from Linear issue to merged code with no model having reviewed
 *     the spec or a plan.
 *   - `safety: true` is the declaration that already forces the safety merge review and mandatory
 *     CodeRabbit. Safety work is precisely what the rubric names as worth the second opinion, so
 *     the spec gate should not be the one place that quietly settles for less.
 *
 * A spec may always opt INTO `full`; it may not opt out of these two.
 */
export function specEvalTier(declaredTier, { lightLoop = false, safety = false } = {}) {
  return lightLoop || safety ? "full" : declaredTier;
}

/**
 * The audit copy of a spec, written to `.aios/loop/<issue>/spec.md`.
 *
 * `buildSpecTextFromIssue` prepends a `# <id>: <title>` heading, which pushes any evaluator
 * frontmatter off the start of the string. That is fine for reading, but the documented recovery
 * path is `aios spec fix .aios/loop/<issue>/spec.md` — and on that artifact the frontmatter is
 * invisible, so a spec that declared `eval_tier: full` would be re-run deterministic-only and
 * never re-run the adversarial layer that blocked ship in the first place. Re-emitting the raw
 * frontmatter block ahead of the heading keeps the artifact self-describing and re-runnable.
 *
 * The block must contain at least one `key:` line to count. A body that merely OPENS with a
 * horizontal rule (`---\n\nsome prose\n\n---`) is not frontmatter, and copying that prose to the
 * head of the audit artifact would corrupt it. Whitespace/CRLF tolerance matches `specEvalHints`.
 */
export function auditSpecText(rawBody, specText) {
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(rawBody ?? ""));
  const block = m && /^[A-Za-z_][\w-]*:/m.test(m[1]) ? m[0] : undefined;
  return block ? `${block}\n${specText}` : specText;
}
