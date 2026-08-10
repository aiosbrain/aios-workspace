import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";

export const CI_WORKFLOW_KEY = "ci_workflow";
export const CI_WORKFLOW_EXPLANATION =
  "This adds an optional GitHub Actions workflow that reports merge-time code health to the Team Brain. It is useful for an AI-assisted codebase; it is not needed for notes, consulting, or standalone work.";

export function ciWorkflowState(cfg = {}) {
  if (cfg[CI_WORKFLOW_KEY] === "true" || cfg[CI_WORKFLOW_KEY] === true) return true;
  if (cfg[CI_WORKFLOW_KEY] === "false" || cfg[CI_WORKFLOW_KEY] === false) return false;
  return null;
}

/**
 * Set one flat top-level scalar in a workspace's `aios.yaml`, replacing the line in place if
 * the key is already there and appending it otherwise. A line rewrite, not a YAML round-trip:
 * aios.yaml is a deliberately restricted flat subset (see flat-yaml.mjs) and comments,
 * ordering, and hand-formatting in it are the owner's, so re-emitting the file would churn
 * far more than the one key we mean to touch.
 *
 * `what` names the setting in the not-found error, since callers persist different keys.
 */
export function persistScalar(repo, key, value, what = `\`${key}\``) {
  const file = path.join(repo, "aios.yaml");
  if (!existsSync(file)) throw new Error(`Cannot save ${what}: aios.yaml is missing.`);
  const before = readFileSync(file, "utf8");
  const line = `${key}: ${value}`;
  const keyRe = new RegExp(`^${key}:\\s*.*$`, "m");
  // `\s*$` (real whitespace, not the literal `\\s` this once had) so appending to a file that
  // already ends in a newline doesn't leave a blank line behind it.
  const after = keyRe.test(before)
    ? before.replace(keyRe, line)
    : `${before.replace(/\s*$/, "")}\n${line}\n`;
  if (after !== before) writeFileSync(file, after);
  return { changed: after !== before };
}

export function persistCiWorkflow(repo, enabled) {
  const { changed } = persistScalar(
    repo,
    CI_WORKFLOW_KEY,
    enabled ? "true" : "false",
    "CI preference"
  );
  return { enabled, changed };
}

export async function askCiWorkflow({
  log = console.log,
  createInterface = readline.createInterface,
} = {}) {
  log(CI_WORKFLOW_EXPLANATION);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Are you actively building a codebase with AI? [y/N] ");
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Resolve gh from fixed, administrator-controlled install locations; never search PATH. */
export function ghExecutable({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
} = {}) {
  const explicit = env.AIOS_GH_PATH;
  if (explicit && path.isAbsolute(explicit) && exists(explicit)) return explicit;
  const candidates =
    platform === "win32"
      ? ["C:\\Program Files\\GitHub CLI\\gh.exe"]
      : ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
  return candidates.find(exists) ?? null;
}

export function checkGhCli({ execFile = execFileSync, ...opts } = {}) {
  const executable = ghExecutable(opts);
  if (!executable)
    return {
      ok: false,
      reason:
        "GitHub CLI (`gh`) is not installed in a trusted location. Install it from https://cli.github.com/, then rerun this action.",
    };
  try {
    execFile(executable, ["--version"], { stdio: "ignore" });
  } catch {
    return {
      ok: false,
      reason:
        "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com/, then rerun this action.",
    };
  }
  try {
    execFile(executable, ["auth", "status"], { stdio: "ignore" });
  } catch {
    return {
      ok: false,
      reason: "GitHub CLI is not authenticated. Run `gh auth login`, then rerun this action.",
    };
  }
  return { ok: true };
}
