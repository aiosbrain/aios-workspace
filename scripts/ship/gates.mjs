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
