const values = (items) => new Set(items);

export const COMMAND_OWNERS = values([
  "core.cli",
  "adapter.linear",
  "adapter.slack",
  "adapter.devtools",
]);
export const CONFIG_REQUIREMENTS = values([
  "none",
  "optional",
  "user",
  "workspace",
  "user-or-workspace",
]);
export const CREDENTIAL_REQUIREMENTS = values([
  "none",
  "optional",
  "brain",
  "provider",
  "brain-or-provider",
]);
export const NETWORK_BEHAVIORS = values(["never", "optional", "required"]);
export const OUTPUT_MODES = values(["human", "human-or-json", "protocol"]);
export const STARTUP_POLICIES = values([
  "diagnostic",
  "pre-config",
  "offline",
  "requires-workspace",
]);

const STARTUP_POLICY_BY_RESOLUTION = Object.freeze({
  diagnostic: "diagnostic",
  "pre-config": "pre-config",
  offline: "offline",
  workspace: "requires-workspace",
  "update-root": "offline",
});

function member(set, value, field) {
  if (!set.has(value)) throw new Error(`aios registry: invalid ${field} '${value}'`);
  return value;
}

function implementationFor(name, owner) {
  if (["help", "version", "doctor", "provenance"].includes(name)) {
    return `scripts/cli/${name}.mjs`;
  }
  if (owner === "adapter.devtools") {
    return `@aiosbrain/aios-devtools/${name === "spec" ? "spec-eval" : name}`;
  }
  if (owner === "adapter.linear") {
    return "scripts/connectors/linear/index.mjs";
  }
  return `scripts/cli/registry.mjs#${name}`;
}

/**
 * Construct the ADR 0002 cold contract from a readable tagged declaration:
 * `M\`name owner config credential network output startup\``.
 */
export function commandMetadata(strings, ...substitutions) {
  if (!Array.isArray(strings?.raw) || substitutions.length) {
    throw new TypeError("command metadata must use its tagged declarative form");
  }
  const fields = String(strings[0]).trim().split(/\s+/);
  if (fields.length !== 7) {
    throw new TypeError(`command metadata needs 7 fields, got ${fields.length}`);
  }
  const [
    name,
    owner,
    configurationRequirement,
    credentialRequirement,
    networkBehavior,
    outputMode,
    startupPolicy,
  ] = fields;
  const module = implementationFor(name, owner);
  const lazy = true;
  if (!module || typeof module !== "string") {
    throw new Error("aios registry: implementation.module must be a non-empty string");
  }
  if (typeof lazy !== "boolean") {
    throw new Error("aios registry: implementation.lazy must be boolean");
  }
  return Object.freeze({
    owner: member(COMMAND_OWNERS, owner, "owner"),
    configurationRequirement: member(
      CONFIG_REQUIREMENTS,
      configurationRequirement,
      "configurationRequirement"
    ),
    credentialRequirement: member(
      CREDENTIAL_REQUIREMENTS,
      credentialRequirement,
      "credentialRequirement"
    ),
    networkBehavior: member(NETWORK_BEHAVIORS, networkBehavior, "networkBehavior"),
    outputMode: member(OUTPUT_MODES, outputMode, "outputMode"),
    startupPolicy: member(STARTUP_POLICIES, startupPolicy, "startupPolicy"),
    implementation: Object.freeze({ module, lazy }),
  });
}

/** Fail during cold registry import when a descriptor is incomplete or contradictory. */
export function validateCommandDescriptor(descriptor) {
  if (!descriptor?.name || !descriptor.metadata || typeof descriptor.adapt !== "function") {
    throw new Error(`aios registry: incomplete descriptor '${descriptor?.name ?? "<unnamed>"}'`);
  }
  const { metadata } = descriptor;
  member(COMMAND_OWNERS, metadata.owner, "owner");
  member(CONFIG_REQUIREMENTS, metadata.configurationRequirement, "configurationRequirement");
  member(CREDENTIAL_REQUIREMENTS, metadata.credentialRequirement, "credentialRequirement");
  member(NETWORK_BEHAVIORS, metadata.networkBehavior, "networkBehavior");
  member(OUTPUT_MODES, metadata.outputMode, "outputMode");
  member(STARTUP_POLICIES, metadata.startupPolicy, "startupPolicy");
  const expectedStartupPolicy = STARTUP_POLICY_BY_RESOLUTION[descriptor.resolution];
  if (!expectedStartupPolicy) {
    throw new Error(
      `aios registry: invalid resolution '${descriptor.resolution}' for '${descriptor.name}'`
    );
  }
  if (metadata.startupPolicy !== expectedStartupPolicy) {
    throw new Error(
      `aios registry: resolution '${descriptor.resolution}' for '${descriptor.name}' requires ` +
        `startupPolicy '${expectedStartupPolicy}', got '${metadata.startupPolicy}'`
    );
  }
  if (!metadata.implementation?.module || metadata.implementation.lazy !== true) {
    throw new Error(`aios registry: invalid implementation metadata for '${descriptor.name}'`);
  }
  if (metadata.startupPolicy === "diagnostic" && metadata.networkBehavior !== "never") {
    throw new Error(`aios registry: diagnostic '${descriptor.name}' must be network-free`);
  }
  return Object.freeze(descriptor);
}
