/**
 * normalize.mjs — the NormalizedEvent schema + factory.
 *
 * Every per-tool parser (parse-claude / parse-codex / parse-cursor) emits an
 * array of NormalizedEvent. Everything downstream (metrics, aem, report) reads
 * ONLY this shape — the parsers are the only code that knows a tool's raw log
 * format. Keep this file the single source of truth for the event contract.
 *
 * PRIVACY: a NormalizedEvent carries NO message text, NO prompt content, NO file
 * contents. It carries structural facts only (token counts, tool names, roles,
 * timestamps, threading ids). Even so, the whole NormalizedEvent[] is admin-tier
 * and never leaves the machine — only the daily aggregates in metrics.mjs do.
 *
 * Zero dependencies (Node >= 18).
 */

export const TOOLS = ["claude", "codex", "cursor", "opencode"];
export const ACTORS = ["user", "assistant", "subagent"];
export const BLOCK_TYPES = [
  "thinking",
  "text",
  "tool_use",
  "tool_result",
  "mode",
  "permission",
  "meta",
  null,
];

/**
 * @typedef {Object} Tokens
 * @property {number} in            input_tokens
 * @property {number} out           output_tokens
 * @property {number} cache_read    cache_read_input_tokens
 * @property {number} cache_create  cache_creation_input_tokens
 *
 * @typedef {Object} NormalizedEvent
 * @property {"claude"|"codex"|"cursor"|"opencode"} tool
 * @property {string}  session_id
 * @property {string}  ts            ISO8601; coerced to session start when absent
 * @property {"user"|"assistant"|"subagent"} actor
 * @property {string|null} model
 * @property {Tokens|null} tokens     null unless this is an assistant usage record
 *   INVARIANT: `in` = FRESH (uncached) input tokens; `cache_read` = cached input
 *   tokens. Tools that report a full prompt count (Codex) MUST subtract the
 *   cached portion in their parser so `in` means the same thing everywhere.
 * @property {string|null} block_type
 * @property {string|null} tool_name  set when block_type === "tool_use"
 * @property {string|null} git_branch
 * @property {string|null} project    cwd-slug → workspace correlation
 * @property {string|null} turn_parent parentUuid / response-chain id
 * @property {string|null} raw_uuid   this record's own uuid (loop reconstruction)
 * @property {boolean} is_error       tool_result.is_error / event error
 */

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Coerce a loose token object into the canonical short-key shape, or null. */
export function normalizeTokens(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = {
    in: num(raw.input_tokens ?? raw.in),
    out: num(raw.output_tokens ?? raw.out),
    cache_read: num(raw.cache_read_input_tokens ?? raw.cache_read),
    cache_create: num(raw.cache_creation_input_tokens ?? raw.cache_create),
  };
  // An all-zero token record carries no signal — treat it as "no usage".
  if (t.in === 0 && t.out === 0 && t.cache_read === 0 && t.cache_create === 0) {
    return null;
  }
  return t;
}

/**
 * Build a NormalizedEvent, filling defaults and coercing types so downstream
 * consumers can null-guard one consistent shape regardless of source tool.
 * @returns {NormalizedEvent}
 */
export function makeEvent(e) {
  if (!TOOLS.includes(e.tool)) throw new Error(`normalize: bad tool '${e.tool}'`);
  return {
    tool: e.tool,
    session_id: String(e.session_id ?? "unknown"),
    ts: e.ts ? String(e.ts) : null,
    actor: ACTORS.includes(e.actor) ? e.actor : "assistant",
    model: e.model != null ? String(e.model) : null,
    tokens: e.tokens && typeof e.tokens === "object" ? normalizeTokens(e.tokens) : null,
    block_type: BLOCK_TYPES.includes(e.block_type) ? e.block_type : null,
    tool_name: e.tool_name != null ? String(e.tool_name) : null,
    git_branch: e.git_branch != null ? String(e.git_branch) : null,
    project: e.project != null ? String(e.project) : null,
    turn_parent: e.turn_parent != null ? String(e.turn_parent) : null,
    raw_uuid: e.raw_uuid != null ? String(e.raw_uuid) : null,
    is_error: Boolean(e.is_error),
  };
}

/** Total tokens across all four buckets (0 when tokens is null). */
export function totalTokens(tokens) {
  if (!tokens) return 0;
  return tokens.in + tokens.out + tokens.cache_read + tokens.cache_create;
}
