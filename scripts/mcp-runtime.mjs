import { verifyProfileArtifactReceipt } from "./mcp-artifact-receipt.mjs";
import { parseProfileSelector } from "./mcp-config.mjs";
import {
  loadProfileBinding,
  authorizeProfileCall,
  validateProfileDestination,
} from "./mcp-profile-binding.mjs";
import { ProfileError } from "./cli/connection-profiles.mjs";
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
  const selected = parseProfileSelector(argv);
  if (selected.artifactReceipt) verifyProfileArtifactReceipt(selected.artifactReceipt, deps);
  const selectors = parseSelectors(selected.rest, env);
  const profileOptions = {
    ...deps,
    env: selected.configDir ? { ...env, AIOS_CONFIG_DIR: selected.configDir } : env,
  };
  const binding = selected.profileId
    ? loadProfileBinding(selected.profileId, profileOptions)
    : null;
  if (binding) config = binding.config;
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
    const tools = selectTools(TOOLS, { surface, tier: capability.tier, selectors }).filter(
      (tool) => tool.name !== "aios_loop_collect"
    );
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
      ctx: { workspaceHandler },
      resolveRequest: binding
        ? async () => {
            const authorized = authorizeProfileCall(binding, {
              ...profileOptions,
              readOnly: selected.readOnly,
            });
            const current = loadProfileBinding(binding.profile.id, profileOptions);
            // A successful old startup probe is never current identity evidence.
            const identity = await validateProfileDestination(
              current.profile,
              current.config.api_key,
              doFetch
            );
            const currentClient = createBrainClient(current.config, deps);
            const currentTools = selectTools(TOOLS, {
              surface,
              tier: identity.tier,
              selectors,
            }).filter((tool) => tool.name !== "aios_loop_collect");
            return {
              client: currentClient,
              tools: currentTools,
              ctx: {
                profile: current.profile,
                effectiveGrants: authorized.effectiveGrants,
                readOnly: selected.readOnly,
                identityVerified: true,
              },
            };
          }
        : undefined,
      safeError: (error) =>
        error instanceof ProfileError
          ? `${error.code}: ${error.message}`
          : "The selected connection could not be verified. Inspect profile status and retry.",
    });
  })();
  return serveStdio(ready, deps);
}
