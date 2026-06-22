/**
 * relay-core.mjs — primitives shared by the aios relay (plan) and build phases.
 *
 * Both scripts/relay.mjs (Opus ↔ Cursor plan loop) and scripts/build.mjs (Cursor
 * build/review loop) import from here so the Cursor subprocess driver, git helpers,
 * colours, prereq checks, branch validation, approval tokens, and the --log writer
 * all have a single source of truth.
 */

import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync, existsSync } from "node:fs";

// ── approval tokens ─────────────────────────────────────────────────────────
// PLAN_READY  — the plan loop's reviewer (/review-plan) approves a plan to build.
// MERGE_READY — the build loop's reviewer (/ai-code-review) approves code to merge.
// Keeping them distinct disambiguates the two phases (the plan loop historically
// reused MERGE_READY, which collided with the build reviewer's own token).
export const PLAN_READY_TOKEN = "PLAN_READY";
export const MERGE_READY_TOKEN = "MERGE_READY";

// Allowlist: letters, digits, hyphens, underscores, forward-slash, dots only.
// Rejects any shell metacharacter before it reaches execFileSync.
export const VALID_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;

export const c = {
  red: (s) => `\x1b[0;31m${s}\x1b[0m`,
  green: (s) => `\x1b[0;32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[1;33m${s}\x1b[0m`,
  blue: (s) => `\x1b[0;34m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

export function die(msg) {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

// ── prereq checks ───────────────────────────────────────────────────────────
// The plan loop needs ANTHROPIC_API_KEY (it calls Opus); the build loop drives
// Cursor only, so it passes { requireAnthropic: false }.

export function checkPrereqs({ requireAnthropic = true } = {}) {
  if (requireAnthropic && !process.env.ANTHROPIC_API_KEY) {
    die("ANTHROPIC_API_KEY is not set. Add it to your .env or export it in your shell.");
  }
  try {
    execFileSync("cursor", ["--version"], { stdio: "pipe" });
  } catch {
    die("cursor CLI not found. Install: curl https://cursor.com/install -fsS | bash");
  }
}

// ── Cursor agent subprocess ─────────────────────────────────────────────────
// opts.cwd runs the agent in a specific directory — the build phase passes its
// isolated worktree so file edits land there, never in the primary checkout.
// When omitted the agent inherits the current process cwd (the plan loop's
// original behaviour, which only reviews and never edits).
// opts.extraArgs are appended to the `cursor agent` argv — the build phase passes
// --trust (a fresh worktree is otherwise untrusted) and --force (autonomous edits).

export async function callCursorAgent(prompt, timeoutMs, opts = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write("\n[cursor] invoking agent...\n");

    const args = [
      "agent",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      ...(opts.extraArgs ?? []),
    ];
    const proc = spawn("cursor", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd ?? process.cwd(),
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `cursor agent timed out after ${timeoutMs / 1000}s — increase the timeout and retry`
        )
      );
    }, timeoutMs);

    const rl = createInterface({ input: proc.stdout });
    const errBufs = [];
    let text = "";

    proc.stderr.on("data", (d) => errBufs.push(d));

    rl.on("line", (line) => {
      const raw = line.trim();
      if (!raw) return;

      try {
        const ev = JSON.parse(raw);

        // Shape 1: {type:"assistant", message:{content:[{type:"text",text:"..."}]}}
        if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type === "text") {
              process.stdout.write(block.text);
              text += block.text;
            }
          }
          return;
        }
        // Shape 2: {type:"text", text:"..."}
        if (ev.type === "text" && typeof ev.text === "string") {
          process.stdout.write(ev.text);
          text += ev.text;
          return;
        }
        // Shape 3: {type:"result", result:"..."} (final summary in some Cursor versions)
        if (ev.type === "result" && typeof ev.result === "string" && !text) {
          text = ev.result;
          return;
        }
        // Shape 4: {type:"content_block_delta", delta:{type:"text_delta",text:"..."}}
        if (ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          process.stdout.write(ev.delta.text);
          text += ev.delta.text;
          return;
        }
      } catch {
        process.stdout.write(raw + "\n");
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || (code === null && text)) {
        resolve(text.trim());
      } else {
        const errMsg = Buffer.concat(errBufs).toString().trim();
        reject(
          new Error(`cursor agent exited ${code}${errMsg ? ": " + errMsg.slice(0, 400) : ""}`)
        );
      }
    });
  });
}

// ── git operations ───────────────────────────────────────────────────────────

export function validateBranch(branchName) {
  if (!VALID_BRANCH_RE.test(branchName)) {
    die(
      `invalid branch name '${branchName}' — only letters, digits, hyphens, underscores, dots, and slashes are allowed`
    );
  }
}

export function gitMergeAndDelete(
  repo,
  branchName,
  dryRun,
  message = "chore: merge via aios relay"
) {
  validateBranch(branchName);
  if (dryRun) {
    console.log(
      c.dim(`[dry-run] git merge --no-ff -- ${branchName} && git branch -d -- ${branchName}`)
    );
    return;
  }
  execFileSync("git", ["merge", "--no-ff", "-m", message, "--", branchName], {
    stdio: "inherit",
    cwd: repo,
  });
  execFileSync("git", ["branch", "-d", "--", branchName], { stdio: "inherit", cwd: repo });
  console.log(c.green(`\n✓ Merged and deleted: ${branchName}`));
}

// ── --log writer ──────────────────────────────────────────────────────────────
// Returns a logger that appends `## label` sections to a markdown file (or a
// no-op when logFile is null). The header is written once up front so partial
// runs are recoverable.

export function makeLogger(logFile, header, { append = false } = {}) {
  if (logFile) {
    // append mode (e.g. `relay --build` reusing the plan's log) keeps prior sections.
    if (append && existsSync(logFile)) appendFileSync(logFile, `\n${header}`);
    else writeFileSync(logFile, header);
  }
  return (label, text) => {
    if (!logFile) return;
    appendFileSync(logFile, `\n---\n## ${label}\n\n${text}\n`);
  };
}
