/**
 * relay-core.mjs — primitives shared by the aios relay (plan) and build phases.
 *
 * Both scripts/relay.mjs (Opus plans ↔ Cursor reviews) and scripts/build.mjs (Opus
 * builds via Claude Code ↔ Cursor reviews) import from here so the agent subprocess
 * drivers, git helpers, colours, prereq checks, branch validation, approval tokens,
 * and the --log writer all have a single source of truth.
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
// The plan loop calls Opus via the SDK (needs ANTHROPIC_API_KEY) and reviews with
// Cursor. The build loop drives Claude Code (the Opus builder) + Cursor (the
// reviewer), so it passes { requireAnthropic: false, requireClaude: true }.

export function checkPrereqs({
  requireAnthropic = true,
  requireClaude = false,
  requireCursor = true,
} = {}) {
  if (requireAnthropic && !process.env.ANTHROPIC_API_KEY) {
    die("ANTHROPIC_API_KEY is not set. Add it to your .env or export it in your shell.");
  }
  if (requireCursor) {
    try {
      execFileSync("cursor", ["--version"], { stdio: "pipe" });
    } catch {
      die("cursor CLI not found. Install: curl https://cursor.com/install -fsS | bash");
    }
  }
  if (requireClaude) {
    try {
      execFileSync("claude", ["--version"], { stdio: "pipe" });
    } catch {
      die("claude CLI (Claude Code) not found. See https://docs.claude.com/claude-code");
    }
  }
}

// ── agent subprocesses (Cursor + Claude Code) ────────────────────────────────
// Both the Cursor CLI and the Claude Code CLI stream NDJSON in the same handful of
// event shapes, so one driver parses both. opts.cwd runs the agent in a specific
// directory — the build phase passes its isolated worktree so edits land there,
// never in the primary checkout. opts.extraArgs are appended to the argv.

function spawnAgentStream(label, bin, args, timeoutMs, opts = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`\n[${label}] invoking agent...\n`);

    const proc = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd ?? process.cwd(),
      // Only override the child env when a caller supplies one (e.g. the build
      // phase strips ANTHROPIC_API_KEY so Claude Code uses its own login auth).
      // Absent opts.env, the child inherits process.env implicitly — unchanged.
      ...(opts.env ? { env: opts.env } : {}),
    });

    const timer = setTimeout(() => {
      proc.kill();
      const err = new Error(
        `${label} agent timed out after ${timeoutMs / 1000}s — increase the timeout and retry`
      );
      // Carry whatever the agent streamed before the kill: callers persist it as a
      // <stage>-PARTIAL artifact instead of discarding near-complete work (AIO-239 R4a).
      err.partial = text;
      reject(err);
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
        // (Cursor and Claude Code both use this; tool_use blocks are ignored.)
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
        // Shape 3: {type:"result", result:"..."} (final summary — Cursor + Claude Code)
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
          new Error(`${label} agent exited ${code}${errMsg ? ": " + errMsg.slice(0, 400) : ""}`)
        );
      }
    });
  });
}

// Cursor agent — used as the build-phase code reviewer (/ai-code-review). The build
// phase passes --trust (a fresh worktree is otherwise untrusted) and --force.
export async function callCursorAgent(prompt, timeoutMs, opts = {}) {
  const args = ["agent", "-p", prompt, "--output-format", "stream-json", ...(opts.extraArgs ?? [])];
  return spawnAgentStream("cursor", "cursor", args, timeoutMs, opts);
}

// DeepSeek's own API — an alternative reviewer backend, called directly (no Cursor
// subprocess, no Cursor account/quota). Matches callCursorAgent's external contract:
// (prompt, timeoutMs, opts) in, a trimmed response string out, rejects on timeout or
// a non-OK response. opts.model defaults to "deepseek-v4-pro".
export async function callDeepSeekDirect(prompt, timeoutMs, opts = {}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY not set — required for a deepseek-* review model");
  const model = opts.model ?? "deepseek-v4-pro";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`deepseek agent timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`deepseek agent request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`deepseek agent exited ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("deepseek agent returned no content");
  return content.trim();
}

// Claude Code agent — used as the build-phase builder (Opus implements the plan,
// edits files, runs tests, commits). opts.model selects the model (default Opus);
// the build phase passes --dangerously-skip-permissions for autonomous edits in the
// sandboxed worktree.
//
// ANTHROPIC_API_KEY is ALWAYS stripped from the child env: `aios build` runs under
// `npm run aios` (dotenvx-injected key), and without this strip the spawned Claude
// Code flips from its own login/subscription auth to metered API billing and dies on
// a low-credit account. The strip is idempotent — a caller-supplied opts.env is
// cloned/mutated, not required, so this stays authoritative even when the build phase
// passes its own env (e.g. GIT_CEILING_DIRECTORIES).
export async function callClaudeAgent(prompt, timeoutMs, opts = {}) {
  const model = opts.model ?? "claude-opus-4-8";
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    ...(opts.extraArgs ?? []),
  ];
  const childEnv = opts.env ?? { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  return spawnAgentStream("claude", "claude", args, timeoutMs, { ...opts, env: childEnv });
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
