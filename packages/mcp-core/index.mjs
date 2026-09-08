// Canonical read-only MCP tools. No transport, filesystem or Operator Loop imports.
const CHARACTER_LIMIT = 25_000;

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
    _meta: { "anthropic/maxResultSizeChars": 100_000 },
    async handler(args, client, ctx) {
      if (!ctx?.workspaceHandler)
        throw new Error("workspace handler is unavailable on this surface");
      return ctx.workspaceHandler(args, client, ctx);
    },
  },
];

export function validateArgs(schema, args) {
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

export * from "./capabilities.mjs";
