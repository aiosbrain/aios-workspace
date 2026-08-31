// Shared harness for the workflow-policy gate tests (leak-gate-remediation-plan.md §5.1.3).
//
// Split out of test/check-workflow-policy.test.mjs when that file passed the 500-line size cap.
// Not named `*.test.mjs` on purpose: the suite runner discovers by that suffix, and a helper file
// that gets executed as a test would report zero assertions and look like a passing lane.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCRIPT = path.join(ROOT, "scripts", "check-workflow-policy.mjs");
export const FIXTURES = "test/__fixtures__/workflow-policy";
const NO_ALLOWLIST = path.join(tmpdir(), "workflow-policy-absent-allowlist.json");

/** Rules whose applicability depends on the ORIGINATING trigger, not the audited file's `on:`. */
export const ORIGIN_DEPENDENT_RULES = [
  "pr-target-checkout",
  "pr-target-artifact-download",
  "pr-target-package-install",
  "pr-target-dynamic-run",
];

/** A file reached only through a workflow_call / workflow_run edge, not by its own trigger. */
export const INDIRECT = /^called by |^workflow_run of /;

export const VALID_JUSTIFICATION =
  "Waived pending the phase-7 cutover that deletes the workflow; owner tracked in the plan.";

/** Run the gate and return { code, out } with stdout and stderr merged. */
export function run({ dir = FIXTURES, allowlist = NO_ALLOWLIST, cwd = ROOT } = {}) {
  try {
    const stdout = execFileSync("node", [SCRIPT, "--dir", dir, "--allowlist", allowlist], {
      cwd,
      encoding: "utf8",
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Every `PR-reachable <file>  (via <reason>)` line, as file -> reason. */
export function reachedVia(out) {
  return new Map(
    [...out.matchAll(/^ {2}PR-reachable {2}(\S+) {2}\((?:via )(.+)\)$/gm)].map(
      ([, file, reason]) => [path.basename(file), reason]
    )
  );
}

/** Every `FAIL <file> job \`<job>\` [<rule>]` line, as {file, job, rule}. */
export function failures(out) {
  return [...out.matchAll(/^FAIL {2}(\S+?)(?::\d+)? {2}job `([^`]+)` {2}\[([a-z-]+)\]$/gm)].map(
    ([, file, job, rule]) => ({ file: path.basename(file), job, rule })
  );
}

/** Run `body` against a temporary allowlist file containing `entries`. */
export function withAllowlist(entries, body) {
  const dir = mkdtempSync(path.join(tmpdir(), "wf-policy-"));
  const file = path.join(dir, "allowlist.json");
  writeFileSync(file, JSON.stringify({ entries }, null, 2));
  try {
    return body(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
