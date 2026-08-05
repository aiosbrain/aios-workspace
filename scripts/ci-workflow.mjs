import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const CI_WORKFLOW_KEY = "ci_workflow";
export const CI_WORKFLOW_EXPLANATION =
  "This adds an optional GitHub Actions workflow that reports merge-time code health to the Team Brain. It is useful for an AI-assisted codebase; it is not needed for notes, consulting, or standalone work.";

export function ciWorkflowState(cfg = {}) {
  if (cfg[CI_WORKFLOW_KEY] === "true" || cfg[CI_WORKFLOW_KEY] === true) return true;
  if (cfg[CI_WORKFLOW_KEY] === "false" || cfg[CI_WORKFLOW_KEY] === false) return false;
  return null;
}

export function persistCiWorkflow(repo, enabled) {
  const file = path.join(repo, "aios.yaml");
  if (!existsSync(file)) throw new Error("Cannot save CI preference: aios.yaml is missing.");
  const before = readFileSync(file, "utf8");
  const line = `${CI_WORKFLOW_KEY}: ${enabled ? "true" : "false"}`;
  const after = new RegExp(`^${CI_WORKFLOW_KEY}:\\s*.*$`, "m").test(before)
    ? before.replace(new RegExp(`^${CI_WORKFLOW_KEY}:\\s*.*$`, "m"), line)
    : `${before.replace(/\\s*$/, "")}\n${line}\n`;
  if (after !== before) writeFileSync(file, after);
  return { enabled, changed: after !== before };
}

export function checkGhCli() {
  try { execFileSync("gh", ["--version"], { stdio: "ignore" }); }
  catch { return { ok: false, reason: "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com/, then rerun this action." }; }
  try { execFileSync("gh", ["auth", "status"], { stdio: "ignore" }); }
  catch { return { ok: false, reason: "GitHub CLI is not authenticated. Run `gh auth login`, then rerun this action." }; }
  return { ok: true };
}
