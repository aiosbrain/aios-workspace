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
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFlatYaml, stripQuotes } from "./flat-yaml.mjs";
import { createBrainClient } from "./brain-client.mjs";

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));

// Re-exported so existing importers (and tests) can keep pulling the brain client
// from this module; the implementation now lives in the shared brain-client.mjs.
export { createBrainClient };

export const SERVER_NAME = "aios-team-brain-mcp-server";
export const SERVER_VERSION = "0.1.0";
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

/** Walk up from `dir` for a workspace root (aios.yaml | project.yaml | engagement.yaml). */
function findWorkspaceRoot(dir) {
  let cur = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    if (
      existsSync(path.join(cur, "aios.yaml")) ||
      existsSync(path.join(cur, "project.yaml")) ||
      existsSync(path.join(cur, "engagement.yaml"))
    )
      return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/** Dynamic-import the compiled operator-loop core (shared with the CLI). */
async function loadOperatorLoop() {
  const distPath = path.join(MCP_DIR, "..", "dist", "operator-loop", "index.js");
  if (!existsSync(distPath)) {
    throw new Error("operator-loop is not built — run: npm run build:loop");
  }
  return import(pathToFileURL(distPath).href);
}

/**
 * A stand-in brain client used when the server starts WITHOUT brain config (local-only
 * mode). brain_* tools that call it get a clear "not configured" error in-band; local
 * aios_* tools never touch it. `meta` is a safe empty object so brain_status can render
 * connected:false without throwing.
 */
function makeUnconfiguredBrainClient(missing) {
  const fail = () => {
    throw new Error(
      `brain not configured: missing ${missing.join(", ")}. ` +
        `Set them in the MCP client's env block, a local .env, or aios.yaml.`
    );
  };
  return {
    meta: { brain_url: "", team: "", member: "" },
    async fetchJson() {
      fail();
    },
    async query() {
      fail();
    },
    async streamQuery() {
      fail();
    },
  };
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
// The HTTP/auth client (fetchJson + query + meta) now lives in the shared
// scripts/brain-client.mjs, imported above and re-exported. The MCP server keeps
// its own env-first config resolution (resolveBrainConfig) and passes the result
// into createBrainClient(config, deps).

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
  {
    name: "brain_stakeholders",
    description:
      "Query the team's structured Company-Graph (AIO-141): people, roles, org chart, and " +
      "who-owns-what. Team-tier only — an external-tier key is rejected. Provide EXACTLY ONE of: " +
      "`owns` (people who own/touch/produce a workflow matching the term — 'who owns finance'), " +
      "`who` (one person's role, job family, reports-to, and owned workflows), or `meeting` " +
      "(attendees of a meeting, derived from meeting items' participants). Returns snake_case rows " +
      "verbatim. Read-only; tier re-checked server-side.",
    inputSchema: {
      type: "object",
      properties: {
        owns: {
          type: "string",
          description: "Domain/workflow term — returns the people who own/touch/produce a match.",
        },
        who: {
          type: "string",
          description: "Person name (substring) — returns their role, org, and owned workflows.",
        },
        meeting: {
          type: "string",
          description: "Meeting title (substring) — returns attendees from the meeting item.",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async handler(args, client) {
      const modes = ["owns", "who", "meeting"].filter((k) => args[k] != null && args[k] !== "");
      if (modes.length !== 1) {
        throw new Error("provide exactly one of: owns, who, meeting");
      }
      // Tier probe first (defense in depth) — reject non-team keys before any data leg, so the
      // `meeting` mode (which reads /items) can't leak a partial answer to an external key.
      const me = await client.fetchJson("GET", "/me");
      if (me?.tier !== "team") {
        throw new Error("403 forbidden_tier: the stakeholder map is team-tier only");
      }

      if (args.meeting != null && args.meeting !== "") {
        const q = String(args.meeting).toLowerCase();
        let cursor = null;
        const meetings = [];
        do {
          const route = `/items${qs({
            since: "1970-01-01T00:00:00Z",
            kinds: "artifact",
            cursor,
          })}`;
          const res = await client.fetchJson("GET", route);
          for (const item of res.items || []) {
            const fm = item.frontmatter || {};
            if (fm.meeting !== true) continue;
            const t = String(fm.title || item.path || "");
            if (!t.toLowerCase().includes(q)) continue;
            meetings.push({
              title: t,
              path: item.path,
              participants: String(fm.participants || "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            });
          }
          cursor = res.next_cursor || null;
        } while (cursor);
        return asContent({ mode: "meeting", query: args.meeting, meetings });
      }

      // owns / who read the structured graph. Tolerate a 404 from an older brain that predates
      // the endpoint by returning a clean not-available result rather than an error.
      let graph;
      try {
        graph = await client.fetchJson("GET", "/company-graph");
      } catch (e) {
        if (/^404\b/.test(String(e?.message))) {
          return asContent({ available: false, reason: "company graph endpoint not available" });
        }
        throw e;
      }
      const people = Array.isArray(graph.people) ? graph.people : [];
      const ownership = Array.isArray(graph.ownership) ? graph.ownership : [];

      if (args.owns != null && args.owns !== "") {
        const q = String(args.owns).toLowerCase();
        const matches = ownership.filter(
          (o) =>
            String(o.target_name || "")
              .toLowerCase()
              .includes(q) ||
            String(o.target_job_family || "")
              .toLowerCase()
              .includes(q)
        );
        const ids = new Set(matches.map((o) => o.person_id));
        // Return the matched edges + involved people rows verbatim (snake_case) so the caller
        // can resolve person_id → name/role without a second call.
        return asContent({
          mode: "owns",
          query: args.owns,
          ownership: matches,
          people: people.filter((p) => ids.has(p.entity_id)),
        });
      }

      // who
      const q = String(args.who).toLowerCase();
      const person =
        people.find((p) =>
          String(p.name || "")
            .toLowerCase()
            .includes(q)
        ) || null;
      const owned = person ? ownership.filter((o) => o.person_id === person.entity_id) : [];
      const reports_to = person?.reports_to
        ? people.find((p) => p.entity_id === person.reports_to) || null
        : null;
      return asContent({ mode: "who", query: args.who, person, ownership: owned, reports_to });
    },
  },
  {
    // Local-tool namespace (`aios_*`) — reads the workspace, not the brain. Lets GUI-only
    // agents drive the Operator Loop through the SAME core the CLI uses (`aios loop collect`).
    name: "aios_loop_collect",
    description:
      "Collect local workspace work signals (decisions, tasks, hours, deliverables, inbox) for a " +
      "time window into a tier-tagged run manifest — the Operator Loop C1 collector. Local and " +
      "read-only: reads the workspace at the server's working directory; NO brain connection " +
      "required. Returns the same manifest as `aios loop collect` on the CLI. Arg: cadence " +
      "('daily' = 1-day/minimal, 'weekly' = 7-day/full; default weekly).",
    inputSchema: {
      type: "object",
      properties: {
        cadence: {
          type: "string",
          enum: ["daily", "weekly"],
          description:
            "Window: daily (1-day, minimal kinds) or weekly (7-day, full set). Default weekly.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(args, _client, ctx) {
      const cwd = (ctx && ctx.cwd) || process.cwd();
      const repo = findWorkspaceRoot(cwd);
      if (!repo) {
        throw new Error(
          "no AIOS workspace found at the server's working directory (need aios.yaml/project.yaml/" +
            "engagement.yaml). Start the MCP server with its cwd set to a workspace."
        );
      }
      // Same identity resolution as the CLI so manifests are byte-identical across entry points.
      const { resolveLoopIdentity } = await import("./loop-config.mjs");
      const { member, project } = resolveLoopIdentity(repo);
      const loop = await loadOperatorLoop();
      const manifest = loop.collect({
        root: repo,
        cadence: args.cadence === "daily" ? "daily" : "weekly",
        member,
        project,
      });
      // Return the FULL manifest JSON — do NOT pass through asContent's 25k char cap, which would
      // truncate mid-JSON and break the consumer's JSON.parse (and parity with `aios loop --json`).
      return { content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }] };
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
    if (Array.isArray(spec?.enum) && !spec.enum.includes(v)) {
      errors.push(`argument ${key} must be one of: ${spec.enum.join(", ")}`);
    }
  }
  return errors;
}

/**
 * Create the message dispatcher. Returns `async dispatch(message)` → a response object,
 * or `null` for notifications (no `id`) and unknown notifications, which get no reply.
 */
export function createDispatcher({
  client,
  ctx = {},
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
          // ctx carries non-brain context (cwd) for local aios_* tools; brain tools ignore it.
          const out = await tool.handler(args, client, ctx);
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
  // Local-capable: when brain config is missing, start anyway with a stub brain client so
  // local aios_* tools work; brain_* tools then return a clear "not configured" error.
  const brainOk = !(config.missing && config.missing.length);
  const client = brainOk
    ? createBrainClient(config, deps)
    : makeUnconfiguredBrainClient(config.missing || []);
  const ctx = { cwd: deps.cwd || config.cwd || process.cwd() };
  const dispatch = createDispatcher({ client, ctx });
  const out = deps.stdout || process.stdout;
  const input = deps.stdin || process.stdin;
  const log = (m) => (deps.stderr || process.stderr).write(`${m}\n`);

  log(
    `${SERVER_NAME} v${SERVER_VERSION} → ${
      brainOk
        ? `${config.brain_url} (team ${config.team_id})`
        : "<brain not configured — local aios_* tools only>"
    } · ${TOOLS.length} tools · read-only`
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
