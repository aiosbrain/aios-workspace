import { createBrainClient } from "./brain-client.mjs";
import {
  TOOLS,
  parseSelectors,
  probeCapability,
  selectTools,
} from "../packages/mcp-core/index.mjs";
import { createDispatcher, serveStdio } from "./mcp-stdio.mjs";

export function startMcp(
  config,
  { serverInfo, surface = "toolkit", workspaceHandler, argv = [], env = process.env, ...deps } = {}
) {
  const selectors = parseSelectors(argv, env);
  const log = (message) => (deps.stderr || process.stderr).write(`${message}\n`);
  const controller = new AbortController();
  const doFetch = deps.fetch || globalThis.fetch;
  const ready = (async () => {
    let client;
    let capability;
    try {
      if (!config.missing?.length && config.brain_url && config.api_key) {
        client = createBrainClient(config, deps);
        const probeClient = createBrainClient(config, {
          fetch: (url, options) => doFetch(url, { ...options, signal: controller.signal }),
        });
        capability = await probeCapability(config, probeClient, {
          abort: () => controller.abort(),
        });
      } else capability = await probeCapability(config, null);
    } catch (error) {
      capability = { tier: null, reason: `Brain configuration invalid: ${error.message}` };
    }
    const tools = selectTools(TOOLS, { surface, tier: capability.tier, selectors });
    // A failed request may contain credentials in an upstream error: never print the key.
    const reason = config.api_key
      ? capability.reason.replaceAll(config.api_key, "[redacted]")
      : capability.reason;
    log(
      `${serverInfo.name} v${serverInfo.version}: ${reason}; ${tools.length} read-only tools; availability fixed until restart`
    );
    return createDispatcher({
      client,
      tools,
      serverInfo,
      ctx: { cwd: deps.cwd || config.cwd || process.cwd(), workspaceHandler },
    });
  })();
  return serveStdio(ready, deps);
}
