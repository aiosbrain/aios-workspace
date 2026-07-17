/** Safe, owner-local lifecycle for Claude asks surfaced in the Unified Inbox. */
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { loadSecretPatterns, redactSecrets } from "./memory-reviewer.mjs";

const TAIL_BYTES = 256 * 1024;
const MESSAGE_MAX = 8000;
const SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const HOOK_SOURCES = new Set(["hook:idle", "hook:stop"]);

function httpError(message, statusCode, errorCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function bounded(text, max) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function conversationalRecord(record) {
  if (!record || (record.type !== "user" && record.type !== "assistant")) return null;
  const text = textContent(record.message?.content ?? record.content);
  // tool_result-only user records are SDK mechanics, not evidence that the owner returned.
  if (!text.trim()) return null;
  const timestamp = Date.parse(record.timestamp || record.message?.timestamp || "");
  return {
    role: record.type === "assistant" ? "Claude" : "You",
    text,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
  };
}

function readTail(file) {
  const size = statSync(file).size;
  const length = Math.min(size, TAIL_BYTES);
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let raw = buffer.toString("utf8");
    if (size > length) raw = raw.slice(raw.indexOf("\n") + 1);
    return raw;
  } finally {
    closeSync(fd);
  }
}

function defaultAllowedRoots() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return [path.join(configDir, "projects")];
}

/** Bind an ask to its canonical transcript without trusting a client path/session claim. */
export function readBoundTranscript(ask, { allowedRoots = defaultAllowedRoots() } = {}) {
  if (!ask || !HOOK_SOURCES.has(ask.source) || !SESSION_RE.test(ask.sessionId || "")) {
    throw httpError("ask is not bound to a resumable Claude session", 409);
  }
  if (!ask.transcriptPath || path.basename(ask.transcriptPath) !== `${ask.sessionId}.jsonl`) {
    throw httpError("ask transcript/session binding is invalid", 409);
  }
  let file;
  try {
    file = realpathSync(ask.transcriptPath);
  } catch {
    throw httpError("Claude session transcript is unavailable", 409);
  }
  const insideAllowedRoot = allowedRoots.some((root) => {
    try {
      const realRoot = realpathSync(root);
      const rel = path.relative(realRoot, file);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    } catch {
      return false;
    }
  });
  if (!insideAllowedRoot)
    throw httpError("ask transcript is outside the Claude session store", 409);

  const records = [];
  for (const line of readTail(file).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const embeddedSession = parsed.session_id ?? parsed.sessionId;
      if (embeddedSession && embeddedSession !== ask.sessionId) {
        throw httpError("transcript contains a different Claude session", 409);
      }
      const turn = conversationalRecord(parsed);
      if (turn) records.push(turn);
    } catch (error) {
      if (error?.statusCode) throw error;
      // A partial/corrupt JSONL line is ignored; it is never rendered or lifecycle evidence.
    }
  }
  return records;
}

export function projectClaudeAskContext(repo, ask, options = {}) {
  const patterns = loadSecretPatterns(repo);
  const records = readBoundTranscript(ask, options);
  const assistant = [...records].reverse().find((turn) => turn.role === "Claude");
  const fallback = ask.body || ask.title || "Claude needs your input.";
  const summary = bounded(redactSecrets(assistant?.text || fallback, patterns), 560);
  const subjectSource = summary.split(/[.!?]\s|\n/)[0] || ask.title || "Claude needs your input";
  return {
    subject: bounded(redactSecrets(subjectSource, patterns), 120),
    summary,
    turns: records.slice(-4).map((turn) => ({
      role: turn.role,
      text: bounded(redactSecrets(turn.text, patterns), 700),
    })),
    canReply: ask.status === "open",
  };
}

function canonicalAsk(loop, repo, id) {
  const ask = loop.readAsks(repo).asks.find((candidate) => candidate.id === id);
  if (!ask) throw httpError("ask not found", 404);
  return ask;
}

/** Resolve stale hook asks only when a later ordinary user transcript turn is hard evidence. */
export function reconcileClaudeAsks(loop, repo, options = {}) {
  let resolved = 0;
  for (const ask of loop.readAsks(repo).asks) {
    if (ask.status !== "open" || !HOOK_SOURCES.has(ask.source)) continue;
    try {
      const createdAt = Date.parse(ask.createdAt);
      const reconcileAfter = Date.parse(ask.reconcileAfter || "");
      const evidenceAfter = Number.isFinite(reconcileAfter)
        ? Math.max(createdAt, reconcileAfter)
        : createdAt;
      if (!Number.isFinite(evidenceAfter)) continue;
      const turns = readBoundTranscript(ask, options);
      const laterUser = turns.find(
        (turn) => turn.role === "You" && turn.timestamp !== null && turn.timestamp > evidenceAfter
      );
      if (!laterUser) continue;
      const result = loop.resolveUnclaimed(
        repo,
        ask.id,
        new Date(laterUser.timestamp).toISOString()
      );
      if (result === "resolved") resolved++;
    } catch {
      // Missing/unbound transcripts are not proof; preserve the ask for the owner.
    }
  }
  return resolved;
}

export function archiveClaudeAsk(loop, repo, id) {
  const result = loop.archiveAsk(repo, id);
  if (result === "archived") return { ok: true, archived: true };
  if (result === "already-archived") return { ok: true, archived: true, alreadyArchived: true };
  if (result === "missing") throw httpError("ask not found", 404);
  if (result === "busy") throw httpError("reply already in progress", 409, "reply_in_progress");
  throw httpError("only open asks can be archived", 409, "ask_closed");
}

/** Resume the exact canonical session. The ask closes only after a successful exact-session result. */
export async function replyToClaudeAsk(loop, repo, id, payload, deps = {}, options = {}) {
  const ask = canonicalAsk(loop, repo, id);
  if (ask.status !== "open") throw httpError("ask is no longer open", 409, "ask_closed");
  readBoundTranscript(ask, options);
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (!message) throw httpError("message is required", 400);
  if (message.length > MESSAGE_MAX)
    throw httpError(`message exceeds ${MESSAGE_MAX} characters`, 400);
  if (typeof deps.query !== "function")
    throw httpError("Claude session resume is unavailable", 503);

  const claimToken = randomUUID();
  const claim = loop.claimReply(repo, ask.id, claimToken);
  if (claim === "busy") throw httpError("reply already in progress", 409, "reply_in_progress");
  if (claim === "closed") throw httpError("ask is no longer open", 409, "ask_closed");
  if (claim === "missing") throw httpError("ask not found", 404);

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 120_000);
  let initBound = false;
  let succeeded = false;
  let completed = false;
  try {
    if (typeof deps.getSessionInfo === "function") {
      const info = await deps.getSessionInfo(ask.sessionId, { dir: repo });
      // Undefined can be a valid summary-less session; only a positive mismatch is fatal.
      if (info && info.sessionId !== ask.sessionId)
        throw httpError("Claude session was not found", 409);
    }
    const stream = deps.query({
      prompt: message,
      options: {
        cwd: repo,
        resume: ask.sessionId,
        settingSources: ["user", "project"],
        permissionMode: "default",
        abortController,
      },
    });
    for await (const event of stream) {
      if (event?.type === "system" && event.subtype === "init") {
        if (event.session_id !== ask.sessionId)
          throw httpError("Claude resumed a different session", 409);
        initBound = true;
      }
      if (event?.type === "result") {
        if (event.session_id !== ask.sessionId)
          throw httpError("Claude result session mismatch", 409);
        succeeded = event.subtype === "success";
      }
    }
    if (!initBound || !succeeded) throw httpError("Claude did not accept the reply", 502);
    const completion = loop.completeReply(repo, ask.id, claimToken);
    if (completion !== "resolved")
      throw httpError("ask lifecycle changed during reply", 409, "lifecycle_conflict");
    completed = true;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw httpError(
      abortController.signal.aborted ? "Claude reply timed out" : "Claude reply failed",
      502
    );
  } finally {
    clearTimeout(timer);
    if (!completed) loop.releaseReply(repo, ask.id, claimToken);
  }
  return { ok: true, accepted: true };
}
