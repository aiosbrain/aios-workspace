/**
 * pr.mjs — `aios pr`: push the current branch and open a GitHub PR (idempotent).
 *
 * Owns the push/PR step that the build phase's fenced builder is forbidden from doing.
 * Zero-dep, offline-command style. All child calls use execFileSync with argv arrays
 * (never shell strings) so branch/title/body never touch a shell.
 *
 * The PR title always carries the AIO-<n> issue key so the repo's GitHub automations
 * fire: `pr-in-review.yml` moves the issue to In Review on open, `aios-work-sync.yml`
 * moves it to Done on merge.
 *
 * Exported:
 *   cmdPr(repo, args)                    — CLI + chained from `aios build --pr`
 *   buildPushArgv(branch)                — pure: git push argv
 *   buildPrCreateArgv({repo,title,bodyFile,branch}) — pure: gh pr create argv
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { c, die, validateBranch } from "./relay-core.mjs";

const ISSUE_RE = /^AIO-\d+$/;

// Replicated from wait-for-bots.mjs (both are small offline commands; avoids coupling
// two command modules). Returns owner/repo from the origin remote, or null.
export function detectRepo(cwd = process.cwd()) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return url
      .replace(/^git@github\.com:/, "")
      .replace(/^https:\/\/github\.com\//, "")
      .replace(/\.git$/, "");
  } catch {
    return null;
  }
}

export function buildPushArgv(branch) {
  return ["push", "-u", "origin", branch];
}

export function buildPrCreateArgv({ repo, title, bodyFile, branch }) {
  return [
    "pr",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body-file",
    bodyFile,
    "--head",
    branch,
  ];
}

function gitOut(argv, cwd) {
  return execFileSync("git", argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Existing open PR for this head branch, or null.
function existingPrNumber(repo, branch) {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--head", branch, "--repo", repo, "--json", "number", "--jq", ".[0].number"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function cmdPr(repo, args) {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(
      [
        "",
        c.blue("aios pr — push the branch and open a GitHub PR (idempotent)"),
        "",
        "usage:",
        "  aios pr [options]",
        "",
        "options:",
        "  --branch <name>    branch to push + open a PR for (default: current branch)",
        "  --issue AIO-<n>    issue key to weave into the PR title/body (default: from branch)",
        "  --title <text>     PR title (default: '<issue>: <branch>')",
        "  --body-file <path> file to use as the PR body (default: generated)",
        "  --repo owner/repo  target repo (default: detected from origin)",
        "  --dry-run          print the push + gh pr create argv without executing",
        "",
        "Prints PR_NUMBER=<n> on success (existing PR reused if one is already open).",
      ].join("\n")
    );
    return null;
  }

  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const hasFlag = (name) => args.includes(name);

  const dryRun = hasFlag("--dry-run");
  const branch = flag("--branch") ?? gitOut(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  if (!branch || branch === "HEAD") die("could not resolve a branch — pass --branch <name>.");
  validateBranch(branch);

  const repoSlug = flag("--repo") ?? detectRepo(repo);
  if (!repoSlug) die("could not detect the target repo — pass --repo owner/repo.");

  const issue = flag("--issue") ?? branch.match(/AIO-\d+/)?.[0] ?? null;
  if (issue && !ISSUE_RE.test(issue)) die(`invalid --issue '${issue}' — expected AIO-<number>.`);

  const pushArgv = buildPushArgv(branch);

  // Title always carries the issue key when we have one (drives the Linear automations).
  const title = flag("--title") ?? (issue ? `${issue}: ${branch}` : branch);

  // Body: an explicit --body-file, else a generated body (always referencing the issue).
  let bodyFile = flag("--body-file");
  let tmpDir = null;
  if (!bodyFile) {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "aios-pr-body-"));
    bodyFile = path.join(tmpDir, "body.md");
    const lines = [`Automated PR opened by \`aios pr\` for branch \`${branch}\`.`];
    if (issue) lines.push("", `Implements ${issue}.`);
    writeFileSync(bodyFile, lines.join("\n") + "\n");
  } else if (!existsSync(bodyFile)) {
    die(`--body-file not found: ${bodyFile}`);
  }
  const createArgv = buildPrCreateArgv({ repo: repoSlug, title, bodyFile, branch });

  try {
    // --dry-run is a pure preview: print the argv and make NO child calls (no idempotency
    // query, no push, no create). Requires --branch/--repo to avoid resolving them via git.
    if (dryRun) {
      console.log(c.dim("[dry-run] git " + pushArgv.join(" ")));
      console.log(c.dim("[dry-run] gh " + createArgv.join(" ")));
      return null;
    }

    // Idempotency: if a PR is already open for this branch, reuse it — no push, no create.
    const existing = existingPrNumber(repoSlug, branch);
    if (existing) {
      console.log(c.dim(`PR already exists for ${branch}: #${existing}`));
      console.log(`PR_NUMBER=${existing}`);
      return existing;
    }

    execFileSync("git", pushArgv, { cwd: repo, stdio: "inherit" });

    let createOut = "";
    try {
      createOut = execFileSync("gh", createArgv, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      process.stdout.write(createOut);
    } catch (e) {
      const msg = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
      die(`gh pr create failed: ${msg || e.message}`);
    }

    // Parse the PR number from the printed URL; fall back to a re-query.
    const m = createOut.match(/\/pull\/(\d+)/);
    const prNumber = m ? parseInt(m[1], 10) : existingPrNumber(repoSlug, branch);
    if (prNumber) console.log(`PR_NUMBER=${prNumber}`);
    return prNumber ?? null;
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}
