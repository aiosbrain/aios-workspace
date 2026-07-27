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
 *   cmdPr(repo, args, opts)              — CLI + chained from `aios build --pr`; callers may
 *                                          request `{ number, reused }` metadata
 *   PrError                              — thrown (not die()) when opts.throwOnError is set
 *   buildPushArgv(branch)                — pure: git push argv
 *   buildPrCreateArgv({repo,title,bodyFile,branch}) — pure: gh pr create argv
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { c, die, validateBranch } from "./relay-core.mjs";

const ISSUE_RE = /^AIO-\d+$/;

// A recoverable `aios pr` failure. The CLI path lets these reach die() (exit 1); the
// `aios build --pr` path passes { throwOnError } so finish() can catch it and return a
// gate-failure exit code instead of the process aborting mid-build via process.exit.
export class PrError extends Error {}

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

// Existing open PR for this head branch, or null when the query succeeds and finds none.
// Throws when the `gh pr list` query ITSELF fails (auth/network/API) — callers must NOT
// swallow that into "no PR", or they'd push on top of a broken GitHub connection.
function existingPrNumber(repo, branch) {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--head", branch, "--repo", repo, "--json", "number", "--jq", ".[0].number"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

export async function cmdPr(repo, args, { throwOnError = false, returnMetadata = false } = {}) {
  // fail() = die() for the CLI (exit 1), throw for the build path so finish() can map it
  // to a gate-failure exit code. Every recoverable abort below goes through fail().
  const fail = throwOnError
    ? (msg) => {
        throw new PrError(msg);
      }
    : die;
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
        "  --title <text>     PR title (default: '<issue>: <branch>'); the AIO-<n> key is",
        "                     prefixed automatically if a custom title omits it",
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
  if (!branch || branch === "HEAD") fail("could not resolve a branch — pass --branch <name>.");
  validateBranch(branch);

  const repoSlug = flag("--repo") ?? detectRepo(repo);
  if (!repoSlug) fail("could not detect the target repo — pass --repo owner/repo.");

  const issue = flag("--issue") ?? branch.match(/AIO-\d+/)?.[0] ?? null;
  if (issue && !ISSUE_RE.test(issue)) fail(`invalid --issue '${issue}' — expected AIO-<number>.`);
  // A PR title/body without an AIO-<n> key silently breaks the Linear automations
  // (pr-in-review.yml / aios-work-sync.yml). Fail fast, before any push or create.
  if (!issue)
    fail(
      "no issue key — pass --issue AIO-<n> or use a branch whose name contains AIO-<n> " +
        "(the PR title must carry the key to drive the Linear automations)."
    );

  const pushArgv = buildPushArgv(branch);

  // Title MUST carry the issue key (drives the Linear automations). A custom --title that
  // omits it is prefixed rather than trusted verbatim — otherwise a hand-written title
  // silently breaks pr-in-review.yml / aios-work-sync.yml. (issue is guaranteed above.)
  // Match the key on a word boundary, mirroring the workflows' key extraction: a plain
  // substring test would treat "AIO-420" as containing "AIO-42" and mis-route the issue.
  const customTitle = flag("--title");
  const keyRe = new RegExp(`\\b${issue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const title = customTitle
    ? keyRe.test(customTitle)
      ? customTitle
      : `${issue}: ${customTitle}`
    : `${issue}: ${branch}`;

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
    fail(`--body-file not found: ${bodyFile}`);
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

    // Idempotency query FIRST. A FAILED query (auth/network/API) aborts here, before any
    // push — never treated as "no PR", which would push on top of a broken GitHub connection.
    let existing;
    try {
      existing = existingPrNumber(repoSlug, branch);
    } catch (e) {
      const msg = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
      fail(`could not query existing PRs (gh pr list): ${msg || e.message}`);
    }

    // Push ALWAYS (push is idempotent). New local commits must reach the remote even when a
    // PR is already open — idempotency applies to PR *creation*, not to the push. stderr is
    // PIPED (not inherited) so a rejected push's detail is available to the wrapped die() UX
    // rather than lost to the terminal; git's normal progress is echoed back through on success.
    try {
      const out = execFileSync("git", pushArgv, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (out) process.stdout.write(out);
    } catch (e) {
      const msg = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
      fail(`git push failed: ${msg || e.message}`);
    }

    // With the branch pushed, an already-open PR is reused — skip create only.
    if (existing) {
      console.log(c.dim(`PR already exists for ${branch}: #${existing}`));
      console.log(`PR_NUMBER=${existing}`);
      return returnMetadata ? { number: existing, reused: true } : existing;
    }

    let createOut = "";
    try {
      createOut = execFileSync("gh", createArgv, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      process.stdout.write(createOut);
    } catch (e) {
      const msg = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
      fail(`gh pr create failed: ${msg || e.message}`);
    }

    // Determine the new PR number: parse the printed URL, else a best-effort re-query.
    // If BOTH fail, the PR exists on GitHub but we can't confirm its number — fail loudly
    // rather than return null (which callers, incl. `aios build --pr`, read as success).
    const m = createOut.match(/\/pull\/(\d+)/);
    let prNumber = m ? parseInt(m[1], 10) : null;
    if (!prNumber) {
      try {
        prNumber = existingPrNumber(repoSlug, branch);
      } catch {
        prNumber = null;
      }
    }
    if (!prNumber) {
      fail(
        "PR was created but its number could not be determined (unparseable `gh pr create` " +
          `output and the re-query failed). Check it on GitHub: https://github.com/${repoSlug}/pulls`
      );
    }
    console.log(`PR_NUMBER=${prNumber}`);
    return returnMetadata ? { number: prNumber, reused: false } : prNumber;
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
