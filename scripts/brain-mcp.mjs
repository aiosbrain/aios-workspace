#!/usr/bin/env node
/**
 * brain-mcp.mjs — AIOS Team Brain MCP server (stdio transport).
 *
 * Bridges any MCP-capable client (Claude Desktop, Claude Cowork, Codex, Conductor,
 * …) to an AIOS Team Brain over the v1 contract in docs/brain-api.md. This is the
 * GUI-surface counterpart to the `aios` CLI: shell-capable agents call `aios` directly
 * (faster, cheaper, no schema overhead); GUI-only agents that cannot spawn a shell
 * reach the brain through this server instead. See docs/strategy/team-brain-access-strategy.md.
 *
 * DESIGN CONSTRAINTS
 *   - Zero npm dependencies (Node >= 18: built-in fetch, JSON-RPC hand-rolled over stdio).
 *     The MCP TypeScript SDK is deliberately NOT used — it would pull a dependency tree
 *     into an otherwise zero-dep toolkit, and the wire protocol is small enough to own.
 *   - Works with NO workspace. A Claude Desktop user has no scaffolded repo, so config is
 *     resolved env-first (AIOS_BRAIN_URL / AIOS_API_KEY / AIOS_TEAM), then an optional .env
 *     in cwd, then an optional aios.yaml walking up. None of those are required.
 *   - READ-ONLY in v1. The brain's safety model is tier-at-the-boundary; pushing from a
 *     contextless GUI (no spine, no per-file tiers) is intentionally deferred to the PRD.
 *     Every tool here is a tier-filtered read the server re-checks server-side (brain_status
 *     is a zero-data connection probe — it returns no content, only reachability).
 *
 * STDIO PROTOCOL
 *   MCP stdio is newline-delimited JSON-RPC 2.0. stdout carries ONLY protocol frames;
 *   every diagnostic goes to stderr (anything else corrupts the stream for the client).
 *
 * TESTABILITY
 *   `createDispatcher({ client, serverInfo })` is a pure async function of an injected
 *   `client`, so the protocol layer (initialize / tools/list / tools/call / errors) is
 *   unit-tested without a network or a live brain. `runStdio(config)` wires the real
 *   client + real stdin/stdout around it. See brain-mcp.test.mjs.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlatYaml, stripQuotes } from "./flat-yaml.mjs";

export const SERVER_NAME = "aios-team-brain-mcp-server";
export const SERVER_VERSION = "0.1.0";
const API_VERSION = "v1";
// MCP revision we implement. Clients negotiate; we echo back our supported value.
const PROTOCOL_VERSION = "2024-11-05";
// Truncate tool payloads so a single pull can't blow out the client's context window.
// The client can paginate (next_cursor) or narrow (project/path_prefix) for more.
const CHARACTER_LIMIT = 25_000;

// ── config resolution (env-first; no workspace required) ─────────────────────

/** Minimal .env reader — mirrors aios.mjs loadDotEnv (skips dotenvx ciphertext). */
function loadDotEnv(dir) {
  const envPath = path.join(dir, ".env");
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const val = stripQuotes(m[2].trim());
    if (m[1] === "DOTENV_PUBLIC_KEY" || val.startsWith("encrypted:")) continue;
    out[m[1]] = val;
  }
  return out;
}

/** Walk up from `dir` looking for an aios.yaml; return its parsed config or {}. */
function findWorkspaceConfig(dir) {
  let cur = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    const p = path.join(cur, "aios.yaml");
    if (existsSync(p)) {
      try {
        return parseFlatYaml(readFileSync(p, "utf8"));
      } catch {
        return {};
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return {};
}

/**
 * Resolve brain connection config. Precedence: process env → cwd/.env → aios.yaml.
 * env-first is deliberate: a Claude Desktop / Cowork user configures the server purely
 * through the extension's env block and has no workspace. Returns a config object plus
 * `missing[]` listing any required field that could not be resolved.
 */
export function resolveBrainConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const dotenv = loadDotEnv(cwd);
  const ws = findWorkspaceConfig(cwd);
  const keyEnv = ws.api_key_env || "AIOS_API_KEY";

  const brain_url = (env.AIOS_BRAIN_URL || dotenv.AIOS_BRAIN_URL || ws.brain_url || "").replace(
    /\/$/,
    ""
  );
  const api_key = env[keyEnv] || dotenv[keyEnv] || env.AIOS_API_KEY || dotenv.AIOS_API_KEY || "";
  const team_id = env.AIOS_TEAM || dotenv.AIOS_TEAM || ws.team_id || "";
  const member = env.AIOS_MEMBER || dotenv.AIOS_MEMBER || ws.member || "";

  const missing = [];
  if (!brain_url) missing.push("AIOS_BRAIN_URL");
  if (!api_key) missing.push(keyEnv);
  if (!team_id) missing.push("AIOS_TEAM");

  return { brain_url, api_key, team_id, member, missing };
}

// ── brain HTTP client ────────────────────────────────────────────────────────

/**
 * Build the client the dispatcher calls. Two methods:
 *   fetchJson(method, route, body?) → parsed JSON (throws Error "<status> <code>: <msg>")
 *   query(question, project?)       → { text, sources } (consumes the SSE answer stream)
 * `deps.fetch` is injectable for tests.
 */
export function createBrainClient(config, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  const headers = {
    Authorization: `Bearer ${config.api_key}`,
    "X-AIOS-Team": config.team_id || "",
  };
  const base = `${config.brain_url}/api/${API_VERSION}`;

  async function fetchJson(method, route, body = null) {
    const res = await doFetch(`${base}${route}`, {
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

  async function query(question, project = null) {
    const res = await doFetch(`${base}/query`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ question, project: project || null }),
    });
    const raw = await res.text();
    if (!res.ok) {
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
    // Parse the SSE transcript: `event: <name>` + `data: <json>` blocks.
    let answer = "";
    let sources = [];
    let event = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event === "delta" && typeof data.text === "string") answer += data.text;
        else if (event === "sources" && Array.isArray(data.sources)) sources = data.sources;
      }
    }
    return { text: answer, sources };
  }

  // Non-secret connection metadata the brain_status tool can echo. The API key is
  // deliberately absent — nothing here may leak a credential.
  const meta = {
    brain_url: config.brain_url,
    team: config.team_id || null,
    member: config.member || null,
  };

  return { fetchJson, query, meta };
}

// ── tool surface (read-only v1) ──────────────────────────────────────────────

/** Build a route query string from defined params only. */
function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

/** Stringify + cap a tool payload so a single call can't flood the client context. */
function asContent(obj) {
  let text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n\n…[truncated at ${CHARACTER_LIMIT} chars — narrow with project/path_prefix or page with the cursor]`;
  }
  return { content: [{ type: "text", text }] };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// A far-future cursor makes `GET /items?since=…` return an empty 200 for ANY valid key
// regardless of tier — so it's a zero-data probe that exercises auth + team + URL without
// returning content. Used by brain_status.
const PROBE_CURSOR = "9999-12-31T23:59:59Z";

/**
 * Tool registry. Each entry: { name, description, inputSchema (JSON Schema), annotations,
 * handler(args, client) }. Names are service-prefixed (`brain_*`) to avoid collisions
 * with other connected servers, per MCP naming guidance.
 */
export const TOOLS = [
  {
    name: "brain_status",
    description:
      "Check whether this connector can reach the AIOS Team Brain — verifies the brain URL, " +
      "API key, and team id by making a zero-result probe read (returns no content). " +
      "Call this FIRST when set up, or whenever another brain_* tool fails, to tell a bad/missing " +
      "credential apart from an empty result. Reports { connected, brain_url, team, member }; " +
      "on failure, connected:false plus the reason and what to fix. Never returns team data and " +
      "never echoes the API key.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    async handler(_args, client) {
      try {
        await client.fetchJson("GET", `/items${qs({ since: PROBE_CURSOR })}`);
        return asContent({
          connected: true,
          ...client.meta,
          checked: "URL, API key, and team verified via a zero-result probe read",
        });
      } catch (e) {
        // A failure here IS the answer, so report it as a normal (non-isError) result the
        // model can read structurally, rather than letting it surface as a tool error.
        return asContent({
          connected: false,
          ...client.meta,
          error: e?.message ?? String(e),
          hint: "Check AIOS_BRAIN_URL, AIOS_API_KEY, and AIOS_TEAM in the MCP client's env block (a 401 usually means a bad key or a team mismatch).",
        });
      }
    },
  },
  {
    name: "brain_query",
    description:
      "Ask the AIOS Team Brain a natural-language question across all shared team memory " +
      "(decisions, deliverables, tasks, transcripts) the caller's access tier may see. " +
      "Returns a grounded answer with [S#] citation markers and a sources list. " +
      "Use for 'what did we decide about…', 'what's the status of…', 'who owns…'. " +
      "Read-only; answers are tier-filtered server-side.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The natural-language question." },
        project: {
          type: "string",
          description: "Optional project slug to scope the answer to one project.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async handler(args, client) {
      const { text, sources } = await client.query(args.question, args.project);
      return asContent({ answer: text, sources });
    },
  },
  {
    name: "brain_list_projects",
    description:
      "List the team's projects visible to the caller's tier (team-tier keys only; an " +
      "external-tier key is rejected). Use to discover project slugs before scoping other " +
      "tools. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    async handler(_args, client) {
      return asContent(await client.fetchJson("GET", "/projects"));
    },
  },
  {
    name: "brain_list_tasks",
    description:
      "List task rows from the Team Brain (assignee, status, sprint, due), optionally only " +
      "those changed after a timestamp. Use for 'what's on the board', 'what changed since…'. " +
      "Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "Optional ISO-8601 cursor; return only rows updated strictly after it.",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async handler(args, client) {
      return asContent(await client.fetchJson("GET", `/tasks${qs({ since: args.since })}`));
    },
  },
  {
    name: "brain_list_decisions",
    description:
      "List decision-log rows from the Team Brain (title, rationale, decided-by, impact), " +
      "optionally only those changed after a timestamp. Tier-scoped: an external-tier key " +
      "sees only external-audience decisions. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "Optional ISO-8601 cursor; return only rows updated strictly after it.",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async handler(args, client) {
      return asContent(await client.fetchJson("GET", `/decisions${qs({ since: args.since })}`));
    },
  },
  {
    name: "brain_pull_items",
    description:
      "Fetch content items (deliverables, transcripts, decisions, tasks, artifacts, skills) " +
      "from the Team Brain, tier-filtered server-side. Narrow with project, kinds, or " +
      "path_prefix; page with cursor. Use to read a deliverable's body or a skill folder. " +
      "Large result sets are truncated — narrow or paginate. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "Optional ISO-8601 cursor (updated_at)." },
        project: { type: "string", description: "Optional project slug filter." },
        kinds: {
          type: "string",
          description: "Optional comma list: deliverable,transcript,decision,task,artifact,skill.",
        },
        path_prefix: {
          type: "string",
          description:
            "Optional path prefix, e.g. '2-work/' or '.claude/skills/<name>/' for a whole skill.",
        },
        cursor: { type: "string", description: "Opaque pagination cursor from a prior call." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async handler(args, client) {
      const route = `/items${qs({
        since: args.since,
        project: args.project,
        kinds: args.kinds,
        path_prefix: args.path_prefix,
        cursor: args.cursor,
      })}`;
      return asContent(await client.fetchJson("GET", route));
    },
  },
  {
    name: "brain_get_item",
    description:
      "Fetch a single content item by its id (tier-filtered; a 404 means missing or above " +
      "the caller's tier). Use after brain_pull_items or brain_query surfaces an item id. " +
      "Read-only.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The item UUID." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async handler(args, client) {
      return asContent(await client.fetchJson("GET", `/items/${encodeURIComponent(args.id)}`));
    },
  },
];

// ── JSON-RPC dispatcher ──────────────────────────────────────────────────────

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/**
 * Validate `tools/call` arguments against a tool's inputSchema before invoking the
 * handler, so a missing/mistyped required arg becomes a clean JSON-RPC -32602
 * (Invalid params) rather than a confused downstream request (e.g. GET /items/undefined)
 * or an empty answer. Covers the JSON-Schema subset our inputSchemas use:
 * object · properties · type · required · additionalProperties:false.
 * Returns an array of human-readable problems (empty = valid).
 */
function validateArgs(schema, args) {
  if (!schema || schema.type !== "object") return [];
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return ["arguments must be an object"];
  }
  const errors = [];
  const props = schema.properties || {};
  for (const key of schema.required || []) {
    const v = args[key];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
      errors.push(`missing required argument: ${key}`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in props)) errors.push(`unexpected argument: ${key}`);
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    const t = spec?.type;
    const ok =
      (t === "string" && typeof v === "string") ||
      (t === "number" && typeof v === "number") ||
      (t === "boolean" && typeof v === "boolean") ||
      (t === "array" && Array.isArray(v)) ||
      (t === "object" && typeof v === "object" && !Array.isArray(v)) ||
      t === undefined;
    if (!ok) errors.push(`argument ${key} must be a ${t}`);
  }
  return errors;
}

/**
 * Create the message dispatcher. Returns `async dispatch(message)` → a response object,
 * or `null` for notifications (no `id`) and unknown notifications, which get no reply.
 */
export function createDispatcher({
  client,
  serverInfo = { name: SERVER_NAME, version: SERVER_VERSION },
  tools = TOOLS,
} = {}) {
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  return async function dispatch(message) {
    const isNotification = message == null || message.id === undefined || message.id === null;
    const id = isNotification ? null : message.id;
    const method = message?.method;

    // Notifications never get a response. We only care about `initialized`.
    if (isNotification) return null;

    if (message.jsonrpc !== "2.0" || typeof method !== "string") {
      return rpcError(id, -32600, "Invalid Request");
    }

    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo,
        });

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          })),
        });

      case "tools/call": {
        const name = message.params?.name;
        const args = message.params?.arguments || {};
        const tool = toolByName.get(name);
        if (!tool) {
          return rpcError(id, -32602, `Unknown tool: ${name}`);
        }
        const argErrors = validateArgs(tool.inputSchema, args);
        if (argErrors.length) {
          return rpcError(id, -32602, `Invalid params for ${name}: ${argErrors.join("; ")}`, {
            errors: argErrors,
          });
        }
        try {
          const out = await tool.handler(args, client);
          return rpcResult(id, out);
        } catch (e) {
          // Tool-level failures are reported in-band (isError) so the model can react,
          // not as JSON-RPC protocol errors. Matches MCP guidance.
          return rpcResult(id, {
            content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }],
            isError: true,
          });
        }
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
}

// ── stdio loop ───────────────────────────────────────────────────────────────

/**
 * Run the server over stdin/stdout until the stream closes. Resolves when stdin ends.
 * Diagnostics go to stderr only — stdout is reserved for protocol frames.
 */
export function runStdio(config, deps = {}) {
  const client = createBrainClient(config, deps);
  const dispatch = createDispatcher({ client });
  const out = deps.stdout || process.stdout;
  const input = deps.stdin || process.stdin;
  const log = (m) => (deps.stderr || process.stderr).write(`${m}\n`);

  log(
    `${SERVER_NAME} v${SERVER_VERSION} → ${config.brain_url} (team ${config.team_id}) · ${TOOLS.length} tools · read-only`
  );

  let buf = "";
  input.setEncoding("utf8");

  return new Promise((resolve) => {
    const handleLine = async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        out.write(JSON.stringify(rpcError(null, -32700, "Parse error")) + "\n");
        return;
      }
      try {
        const response = await dispatch(message);
        if (response) out.write(JSON.stringify(response) + "\n");
      } catch (e) {
        log(`dispatch error: ${e?.stack || e}`);
        if (message?.id !== undefined && message?.id !== null) {
          out.write(JSON.stringify(rpcError(message.id, -32603, "Internal error")) + "\n");
        }
      }
    };

    // Serialize line handling so out-of-order awaits never interleave stdout frames.
    let chain = Promise.resolve();
    input.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        chain = chain.then(() => handleLine(line));
      }
    });
    input.on("end", () => {
      chain.then(() => resolve());
    });
    input.on("close", () => resolve());
  });
}

// Direct execution (`node scripts/brain-mcp.mjs`) — used by `aios mcp`.
// Compare resolved paths (robust across platforms / symlinks vs a raw file:// string).
const invokedDirectly =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const config = resolveBrainConfig();
  if (config.missing.length) {
    process.stderr.write(
      `aios-team-brain-mcp-server: missing config: ${config.missing.join(", ")}.\n` +
        `Set them in the MCP client's env block (or a local .env / aios.yaml).\n`
    );
    process.exit(1);
  }
  runStdio(config).then(() => process.exit(0));
}
