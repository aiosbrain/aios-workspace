// Registration saves context; it never replaces the Brain's per-request authorization.
export const TOOLSETS = Object.freeze({
  brain: Object.freeze(["brain_status", "brain_query", "brain_pull_items", "brain_get_item"]),
  board: Object.freeze([
    "brain_list_projects",
    "brain_list_tasks",
    "brain_list_decisions",
    "brain_stakeholders",
  ]),
  workspace: Object.freeze(["aios_loop_collect"]),
});
export const SURFACES = Object.freeze({
  standalone: Object.freeze([...TOOLSETS.brain, ...TOOLSETS.board]),
  toolkit: Object.freeze([...TOOLSETS.brain, ...TOOLSETS.board, ...TOOLSETS.workspace]),
});
const words = (value) =>
  String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export class McpSelectorError extends Error {}

export function parseSelectors(argv = [], env = {}) {
  let toolsets;
  const tools = [];
  for (let i = 0; i < argv.length; i++) {
    const [flag, ...inline] = argv[i].split("=");
    if (flag !== "--toolsets" && flag !== "--tools")
      throw new McpSelectorError(`Unknown MCP option: ${flag}`);
    const value = inline.length ? inline.join("=") : argv[++i];
    if (!value || value.startsWith("--") || !words(value).length)
      throw new McpSelectorError(`${flag} requires a comma-separated selection`);
    if (flag === "--toolsets") toolsets = [...(toolsets || []), ...words(value)];
    else tools.push(...words(value));
  }
  if (toolsets === undefined && env.AIOS_MCP_TOOLSETS !== undefined) {
    toolsets = words(env.AIOS_MCP_TOOLSETS);
    if (!toolsets.length) throw new McpSelectorError("AIOS_MCP_TOOLSETS requires a selection");
  }
  for (const name of toolsets || []) {
    if (name !== "all" && !Object.hasOwn(TOOLSETS, name))
      throw new McpSelectorError(`Unknown MCP toolset: ${name}`);
  }
  for (const name of tools) {
    if (name !== "all" && !SURFACES.toolkit.includes(name))
      throw new McpSelectorError(`Unknown MCP tool: ${name}`);
  }
  return { toolsets, tools };
}

export function selectTools(registry, { surface = "toolkit", tier = null, selectors = {} } = {}) {
  if (!Object.hasOwn(SURFACES, surface)) throw new Error(`Unknown MCP surface: ${surface}`);
  const requested = new Set();
  if (selectors.toolsets === undefined && !selectors.tools?.length) {
    for (const name of SURFACES[surface]) requested.add(name);
  }
  for (const group of selectors.toolsets || []) {
    const names = group === "all" ? SURFACES.toolkit : TOOLSETS[group];
    if (!names) throw new Error(`Unknown MCP toolset: ${group}`);
    for (const name of names) requested.add(name);
  }
  for (const name of selectors.tools || []) {
    if (name === "all") for (const tool of SURFACES.toolkit) requested.add(tool);
    else {
      if (!SURFACES.toolkit.includes(name)) throw new Error(`Unknown MCP tool: ${name}`);
      requested.add(name);
    }
  }
  const permitted = new Set(TOOLSETS.workspace);
  if (tier === "external" || tier === "team")
    for (const name of TOOLSETS.brain) permitted.add(name);
  if (tier === "team") for (const name of TOOLSETS.board) permitted.add(name);
  return Object.freeze(
    registry.filter(
      (t) => requested.has(t.name) && SURFACES[surface].includes(t.name) && permitted.has(t.name)
    )
  );
}

export async function probeCapability(config, client, { timeoutMs = 3000, abort = () => {} } = {}) {
  if (config.missing?.length || !config.brain_url || !config.api_key) {
    return { tier: null, reason: "Brain configuration is missing" };
  }
  let timer;
  try {
    const me = await Promise.race([
      Promise.resolve().then(() => client.fetchJson("GET", "/me")),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Brain /me probe timed out after ${timeoutMs}ms`));
          abort();
        }, timeoutMs);
      }),
    ]);
    if (config.api_key.startsWith("aiosd_"))
      throw new Error("delegated tokens are unsupported by this MCP server");
    if (
      !me ||
      typeof me !== "object" ||
      Array.isArray(me) ||
      !["team", "external"].includes(me.tier) ||
      !["actor", "role", "team"].every((key) => typeof me[key] === "string" && me[key].trim())
    ) {
      throw new Error("Brain /me returned a malformed identity response");
    }
    return { tier: me.tier, reason: `${me.tier} posture` };
  } catch (error) {
    return {
      tier: null,
      reason: config.api_key.startsWith("aiosd_")
        ? "delegated tokens are unsupported by this MCP server"
        : `Brain capability unavailable: ${error?.message || String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
