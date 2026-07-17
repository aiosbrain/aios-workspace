/**
 * brain-client.mjs — shared AIOS Team Brain HTTP/auth client.
 *
 * The single place that knows how to talk to a Team Brain over the v1 contract
 * (docs/brain-api.md): build the request URL, attach `Authorization: Bearer` +
 * an optional non-empty `X-AIOS-Team` header, make the fetch, map HTTP errors, and parse the
 * streaming `/query` (SSE) answer.
 *
 * Both consumers import this:
 *   - scripts/aios.mjs     (the sync CLI — resolves config by walking the workspace)
 *   - scripts/brain-mcp.mjs (the MCP server — resolves config env-first, no workspace)
 *
 * CONFIG RESOLUTION IS NOT SHARED ON PURPOSE. Each caller resolves its own config
 * (workspace-walking vs env-first) and passes the *resolved* object in here. This
 * module only knows "given a resolved config, make authed requests + run a query".
 *
 * A resolved config is: { brain_url, api_key, team_id, member? }.
 * `deps.fetch` is injectable for tests.
 */

import {
  brainApiUrl,
  fetchBrainOriginLocked,
  normalizeBrainOriginFromConfig,
} from "./brain-origin.mjs";

/**
 * Parse one SSE event block (already split on the blank-line separator) into
 * `{ event, data }`. Joins multiple `data:` lines with newlines per the SSE spec,
 * tolerates CRLF, and returns `data: null` when the JSON payload is absent/invalid.
 * `event` defaults to "message" when no `event:` field is present.
 */
export function parseSseBlock(block) {
  let event = null;
  const dataLines = [];
  // Normalize CRLF → LF before splitting so `\r` never clings to a field value.
  for (const rawLine of block.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      // Per SSE, a single leading space after the colon is stripped; the rest is kept.
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  const payload = dataLines.join("\n").trim();
  let data = null;
  if (payload) {
    try {
      data = JSON.parse(payload);
    } catch {
      data = null;
    }
  }
  return { event: event || "message", data };
}

/**
 * Split a buffer into complete SSE event blocks on the blank-line (`\n\n`)
 * separator, returning `{ blocks, rest }` where `rest` is the trailing partial
 * block not yet terminated. CRLF blank lines (`\r\n\r\n`) are handled too.
 * This is the robust, spec-correct framing both consumers use.
 */
export function splitSseBlocks(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = [];
  let rest = normalized;
  let idx;
  while ((idx = rest.indexOf("\n\n")) !== -1) {
    blocks.push(rest.slice(0, idx));
    rest = rest.slice(idx + 2);
  }
  return { blocks, rest };
}

/**
 * Build the brain client. Methods:
 *   fetchJson(method, route, body?) → parsed JSON (throws Error "<status> <code>: <msg>")
 *   query(question, project?)       → { text, sources } (buffers the SSE answer stream)
 *   streamQuery(question, project?, handlers) → consumes the SSE stream incrementally,
 *       invoking handlers.onDelta(text) / onSources(sources) / onDone(data) as events
 *       arrive. Resolves to { text, sources } once the stream ends.
 *   meta                            → non-secret connection metadata (never the API key)
 */
export function createBrainClient(config, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  const headers = {
    Authorization: `Bearer ${config.api_key}`,
  };
  if (String(config.team_id || "").trim()) headers["X-AIOS-Team"] = String(config.team_id).trim();
  const origin = normalizeBrainOriginFromConfig(config.brain_url);
  const request = (route, options) =>
    fetchBrainOriginLocked(doFetch, brainApiUrl(origin, route), options, origin);

  async function fetchJson(method, route, body = null) {
    const res = await request(route, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = json?.error?.message || text.slice(0, 200);
      throw new Error(`${res.status} ${json?.error?.code || ""}: ${msg}`.trim());
    }
    return json;
  }

  // Open the SSE /query stream; throws a mapped Error on a non-OK response.
  async function openQuery(question, project = null) {
    const res = await request("/query", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ question, project: project || null }),
    });
    if (!res.ok) {
      const raw = await res.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      throw new Error(
        `${res.status} ${json?.error?.code || ""}: ${json?.error?.message || raw.slice(0, 200)}`.trim()
      );
    }
    return res;
  }

  // Drive one parsed SSE event into accumulator + optional handlers. Returns the
  // (possibly updated) accumulator. Shared by query() and streamQuery().
  function applyEvent({ event, data }, acc, handlers) {
    if (data == null) return acc;
    if (event === "delta" && typeof data.text === "string") {
      acc.text += data.text;
      handlers.onDelta?.(data.text);
    } else if (event === "sources" && Array.isArray(data.sources)) {
      acc.sources = data.sources;
      handlers.onSources?.(data.sources);
    } else if (event === "done") {
      handlers.onDone?.(data);
    }
    return acc;
  }

  // Buffered query: collect the whole answer, then return { text, sources }.
  // Used by callers (the MCP server) that need the full answer at once.
  async function query(question, project = null) {
    const res = await openQuery(question, project);
    const raw = await res.text();
    const acc = { text: "", sources: [] };
    const { blocks, rest } = splitSseBlocks(raw);
    // Include the trailing partial too — a buffered body may end without a final
    // blank line, yet that last block can still carry a complete event.
    for (const block of [...blocks, rest]) {
      applyEvent(parseSseBlock(block), acc, {});
    }
    return acc;
  }

  // Streaming query: parse the body incrementally and fire handlers as events
  // arrive (e.g. printing deltas live). Resolves to the final { text, sources }.
  async function streamQuery(question, project = null, handlers = {}) {
    const res = await openQuery(question, project);
    const acc = { text: "", sources: [] };
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const { blocks, rest } = splitSseBlocks(buffer);
      buffer = rest;
      for (const block of blocks) {
        applyEvent(parseSseBlock(block), acc, handlers);
      }
    }
    // Flush any trailing complete block left without a terminating blank line.
    const tail = (buffer + decoder.decode()).trim();
    if (tail) applyEvent(parseSseBlock(tail), acc, handlers);
    return acc;
  }

  // Non-secret connection metadata for status/probe surfaces. The API key is
  // deliberately absent — nothing here may leak a credential.
  const meta = {
    brain_url: origin,
    team: config.team_id || null,
    member: config.member || null,
  };

  return { fetchJson, query, streamQuery, meta };
}
