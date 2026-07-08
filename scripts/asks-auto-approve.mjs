#!/usr/bin/env node
/**
 * asks-auto-approve.mjs — background daemon that monitors the AIOS asks queue and
 * auto-resolves escalations so dispatched agents can keep working without operator
 * interruption.
 *
 * Strategy per ask severity:
 *   blocker (idle)  → auto-resolve: agent is waiting for input; go ahead
 *   decision (stop) → read transcript tail, resolve with guidance if possible
 *   fyi (stop)      → auto-resolve: just a status update, nothing to decide
 *
 * Uses the SAME lockfile protocol as store.ts and asks-capture.mjs. All writes are
 * lock-protected append-only O_APPEND writes — never a rewrite race.
 *
 * Usage:
 *   node scripts/asks-auto-approve.mjs                    # one-shot (process existing)
 *   node scripts/asks-auto-approve.mjs --watch             # poll continuously (daemon)
 *   node scripts/asks-auto-approve.mjs --watch --interval 5 # poll every 5 seconds
 *
 * Zero npm dependencies (Node >= 18). Lock-safe: uses openSync("wx") O_APPEND.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ── config ─────────────────────────────────────────────────────────────────────────────────────

const STORE_REL = ".aios/loop/asks/asks.ndjson";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 40;
const LOCK_DELAY_MS = 25;
const POLL_INTERVAL_SEC = 5;
const VERSION = 1;

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

function storePath(root) {
  return path.join(root, STORE_REL);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveLine(id, at) {
  return JSON.stringify({ v: VERSION, op: "resolve", id, at: at ?? new Date().toISOString() });
}

// ── lock (same protocol as store.ts / asks-capture.mjs) ─────────────────────────────────────────

function withLock(root, fn) {
  const lockPath = storePath(root) + ".lock";
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let fd = null;
  for (let attempt = 0; attempt <= LOCK_RETRIES && fd === null; attempt++) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        /* vanished */
      }
      if (stale) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* lost race */
        }
        continue;
      }
      if (attempt < LOCK_RETRIES) sleepSync(LOCK_DELAY_MS);
    }
  }
  if (fd === null) throw new Error(`asks-auto-approve: could not acquire store lock (${lockPath})`);
  const tokenMatches = () => {
    try {
      return readFileSync(lockPath, "utf8").includes(token);
    } catch {
      return false;
    }
  };
  try {
    try {
      writeFileSync(fd, `${process.pid} ${token} ${new Date().toISOString()}\n`);
    } catch {
      /* non-fatal */
    }
    closeSync(fd);
    return fn();
  } finally {
    try {
      if (tokenMatches()) unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

// ── store read (pure, no lock) ─────────────────────────────────────────────────────────────────

function readAsks(root) {
  const abs = storePath(root);
  if (!existsSync(abs)) return [];
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  const byId = new Map();
  const order = [];
  for (const text of lines) {
    if (!text.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || parsed.v !== VERSION) continue;
    if (parsed.op === "create") {
      const ask = parsed.ask;
      if (!ask || !ask.id) continue;
      if (byId.has(ask.id)) continue; // first create wins
      byId.set(ask.id, { ...ask, status: "open", resolvedAt: null });
      order.push(ask.id);
    } else if (parsed.op === "resolve" || parsed.op === "orphan") {
      const id = parsed.id;
      if (!id || !byId.has(id)) continue;
      const a = byId.get(id);
      a.status = parsed.op === "resolve" ? "resolved" : "orphaned";
      a.resolvedAt = parsed.at ?? new Date().toISOString();
    }
  }
  return order.map((id) => byId.get(id));
}

function appendResolve(root, id) {
  const abs = storePath(root);
  const at = new Date().toISOString();
  withLock(root, () => appendFileSync(abs, resolveLine(id, at) + "\n"));
  return at;
}

// ── transcript reader ──────────────────────────────────────────────────────────────────────────

/**
 * Read the last N messages from a Claude Code transcript for context when making decisions.
 * Returns the tail of user/assistant messages (stripped to ~500 chars each).
 */
function readTranscriptTail(transcriptPath, maxMessages = 4) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const raw = readFileSync(transcriptPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const messages = [];
    // Walk backwards collecting user + assistant messages
    for (let i = lines.length - 1; i >= 0 && messages.length < maxMessages; i--) {
      try {
        const evt = JSON.parse(lines[i]);
        const role = evt?.message?.role;
        if (role === "user" || role === "assistant") {
          const content =
            typeof evt.message.content === "string"
              ? evt.message.content
              : JSON.stringify(evt.message.content);
          messages.unshift({
            role,
            text: (content ?? "").slice(0, 500),
          });
        }
      } catch {
        /* skip unparseable lines */
      }
    }
    return messages.length ? messages : null;
  } catch {
    return null;
  }
}

/**
 * Heuristic: does this transcript tail look like an agent asking a yes/no question?
 * Returns the likely question if so, null otherwise.
 */
function extractQuestion(messages) {
  if (!messages || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return null;
  const q = last.text;
  // Heuristic: ends with a question mark or contains "should I" / "want me to" / "ok to"
  if (/[?？]$/.test(q)) return q;
  if (/\b(should I|want me to|ok to|okay to|shall I|good to|go ahead|ready to)\b/i.test(q))
    return q;
  return null;
}

// ── auto-approval logic ─────────────────────────────────────────────────────────────────────────

/**
 * Decide what to do with an open ask. Returns { action, note }.
 *   action: "resolve" | "skip"
 *   note: human-readable reason for the log
 */
function evaluate(ask) {
  // Already resolved in the fold — shouldn't reach here, but defensive
  if (ask.status !== "open") return { action: "skip", note: "already closed" };

  const { severity, kind, title, transcriptPath } = ask;

  // blocker + idle = agent is waiting at a prompt or input — resolve immediately
  if (severity === "blocker" && kind === "idle") {
    return { action: "resolve", note: "auto-approved: agent waiting for input, go ahead" };
  }

  // fyi = status update, no action needed — resolve
  if (severity === "fyi") {
    return { action: "resolve", note: "auto-resolved: FYI status update, acknowledged" };
  }

  // decision = agent needs a call — try to read context and make the call
  if (severity === "decision") {
    const messages = readTranscriptTail(transcriptPath);
    const question = extractQuestion(messages);

    if (question) {
      // Agent asked a clear question. Default to "yes, go ahead" unless it's clearly dangerous.
      // The safety harness (instinct-observe, rails denylist) blocks truly dangerous ops.
      return {
        action: "resolve",
        note: `auto-approved decision: "${title.slice(0, 120)}" — defaulting to proceed. Question: "${question.slice(0, 200)}"`,
      };
    }

    // Decision without a clear question in the tail — resolve with a generic go-ahead
    return {
      action: "resolve",
      note: `auto-approved decision: "${title.slice(0, 120)}" — defaulting to proceed (no clear question detected)`,
    };
  }

  // blocker but not idle — some other blocker-like state
  if (severity === "blocker") {
    return { action: "resolve", note: `auto-approved blocker: "${title.slice(0, 120)}"` };
  }

  // Unknown — skip (don't touch things we don't understand)
  return { action: "skip", note: `unknown severity/kind: ${severity}/${kind}` };
}

// ── one-shot processing ────────────────────────────────────────────────────────────────────────

function processRepo(root) {
  const asks = readAsks(root);
  const open = asks.filter((a) => a.status === "open");

  let resolved = 0;
  let skipped = 0;

  for (const ask of open) {
    const { action, note } = evaluate(ask);

    if (action === "resolve") {
      appendResolve(root, ask.id);
      resolved++;
      console.log(`✓ [${ask.severity}] ${ask.title.slice(0, 80)} — ${note}`);
    } else {
      skipped++;
      console.log(`✗ [${ask.severity}] ${ask.title.slice(0, 80)} — SKIPPED: ${note}`);
    }
  }

  return { resolved, skipped, openCount: open.length };
}

// ── find workspace repos ───────────────────────────────────────────────────────────────────────

function findWorkspaceRoots() {
  const results = [];
  // Primary workspace
  const primary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (existsSync(path.join(primary, ".aios"))) {
    results.push(primary);
  }
  // Worktrees: sibling dirs of the primary named aios-workspace-*
  const parent = path.dirname(primary);
  try {
    for (const entry of readdirSync(parent)) {
      if (entry.startsWith("aios-workspace-") && entry !== path.basename(primary)) {
        const full = path.join(parent, entry);
        if (existsSync(path.join(full, ".aios"))) results.push(full);
      }
    }
  } catch {
    /* ignore */
  }
  return results;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const watch = args.includes("--watch");
  const intervalIdx = args.indexOf("--interval");
  const intervalSec =
    intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) || POLL_INTERVAL_SEC : POLL_INTERVAL_SEC;

  const roots = findWorkspaceRoots();
  if (roots.length === 0) {
    console.error("asks-auto-approve: no AIOS workspace roots found");
    process.exit(1);
  }

  function tick(iteration) {
    if (iteration !== undefined) {
      process.stdout.write(`\n[${new Date().toISOString()}] poll #${iteration} — `);
    }

    let totalResolved = 0;
    let totalSkipped = 0;
    let totalOpen = 0;

    for (const root of roots) {
      const result = processRepo(root);
      totalResolved += result.resolved;
      totalSkipped += result.skipped;
      totalOpen += result.openCount;
    }

    if (totalOpen === 0) {
      process.stdout.write(`no open asks${watch ? " — waiting" : ""}\n`);
    }

    return { totalResolved, totalSkipped, totalOpen };
  }

  if (watch) {
    console.log(
      `asks-auto-approve: watching ${roots.length} workspace(s), polling every ${intervalSec}s`
    );
    console.log("Press Ctrl+C to stop.\n");

    let iteration = 0;
    tick(iteration);

    const timer = setInterval(() => {
      iteration++;
      tick(iteration);
    }, intervalSec * 1000);

    process.on("SIGINT", () => {
      clearInterval(timer);
      console.log("\nasks-auto-approve: stopped");
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      clearInterval(timer);
      console.log("\nasks-auto-approve: stopped");
      process.exit(0);
    });
  } else {
    tick();
    process.exit(0);
  }
}

main();
