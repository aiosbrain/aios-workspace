// Typed, confidentiality-preserving CLI errors for `aios mcp install|status|uninstall`.
//
// Untyped, the dispatcher reports every installer refusal as AIOS_E_INTERNAL "The CLI
// failed unexpectedly", hiding the one instruction the user needs ("Cursor is running…
// quit it now"). But an installer sentence is NOT safe to echo: it can embed the argv
// token that caused it (`Unknown MCP installer option: <pasted credential>`), a host id
// typed by the user, a URL fragment or a path. So nothing here ever renders
// `error.message`. A refusal is recognised only by comparing it with a sentence rebuilt
// from trusted constants (this table, the host registry, a fixed field enum), and what is
// rendered is that trusted rebuild. Anything unrecognised is returned untouched and stays
// the dispatcher's generic, redacted AIOS_E_INTERNAL.
import { AiosError } from "./cli.mjs";
import { MCP_HOSTS, MCP_SERVER_KEY, hostTargets } from "./mcp-hosts.mjs";

const HOST_LIST = MCP_HOSTS.map((host) => host.id).join(",");
const USAGE = `Run aios mcp install --host ${HOST_LIST} [--dry-run], aios mcp status [--json], or aios mcp install --host <hosts> --uninstall.`;
const RETRY =
  "Resolve the reported condition and re-run. aios mcp status --json shows each host file and its current state.";
const CONNECT =
  "Connect a Team Brain first (aios onboard), or set AIOS_BRAIN_URL and AIOS_API_KEY, then re-run.";
const NETWORK =
  "Check the network and the Brain origin, then re-run. No host configuration was changed.";
const QUIT =
  "Quit the named host completely, re-run this command, then reopen the host. The installer never stops an application for you.";

// Sentences that carry no variable part: the rendered text is this constant.
const FIXED = new Map(
  [
    ["AIOS_E_USAGE", USAGE, "--host needs a comma-separated host list"],
    ["AIOS_E_USAGE", USAGE, "status does not accept mutation options"],
    ["AIOS_E_USAGE", USAGE, "Unknown MCP host selection"],
    ["AIOS_E_USAGE", USAGE, `Use --host ${HOST_LIST} to select targets`],
    ["AIOS_E_USAGE", USAGE, "Select at least one MCP host"],
    ["AIOS_E_CREDENTIAL_MISSING", CONNECT, "Invalid default Brain credential tuple"],
    ["AIOS_E_CREDENTIAL_MISSING", CONNECT, "Unknown default Brain credential field"],
    ["AIOS_E_NETWORK", NETWORK, "MCP package download failed"],
    ["AIOS_E_NETWORK", NETWORK, "MCP package download exceeds its size limit"],
    ["AIOS_E_NETWORK", NETWORK, "Brain /me validation failed; host configuration was not changed"],
    ["AIOS_E_PROVIDER", RETRY, "Brain /me returned an unsupported identity"],
    ["AIOS_E_PROVIDER", RETRY, "MCP package integrity mismatch"],
    ["AIOS_E_PROVIDER", RETRY, "Unexpected MCP package archive entry"],
    ["AIOS_E_PROVIDER", RETRY, "Incomplete MCP package closure"],
    ["AIOS_E_PROVIDER", RETRY, "Unexpected MCP package manifest"],
    ["AIOS_E_PROVIDER", RETRY, "MCP server command could not start"],
    ...["timeout", "exit", "protocol", "membership", "invalid response or credential source"].map(
      (reason) => [
        "AIOS_E_PROVIDER",
        RETRY,
        `Recorded MCP command did not pass initialize and tools/list (${reason})`,
      ]
    ),
    [
      "AIOS_E_CONFLICT",
      QUIT,
      "A selected host started during installation; quit it before retrying",
    ],
    ["AIOS_E_CONFIG_INVALID", RETRY, "Cannot verify running hosts"],
    ["AIOS_E_CONFIG_INVALID", RETRY, "Malformed MCP installation records"],
    ["AIOS_E_CONFIG_INVALID", RETRY, "Invalid MCP installation records"],
    ["AIOS_E_CONFIG_INVALID", RETRY, "Duplicate MCP installation records"],
  ].map(([code, remediation, message]) => [message, { code, remediation, message }])
);

// Sentences prefixed by a registry host label: rebuilt per trusted host, compared exactly.
const PER_HOST = MCP_HOSTS.flatMap((host) =>
  [
    [
      "AIOS_E_CONFLICT",
      QUIT,
      `${host.label} is running. ${host.restartText} after installation; quit it now before retrying.`,
    ],
    [
      "AIOS_E_CONFLICT",
      RETRY,
      `${host.label}: refusing to overwrite an edited or unowned ${MCP_SERVER_KEY} entry`,
    ],
    ["AIOS_E_CONFLICT", RETRY, `${host.label}: installer block was edited`],
    ["AIOS_E_CONFLICT", RETRY, `${host.label}: unowned installer marker`],
    [
      "AIOS_E_CONFIG_INVALID",
      RETRY,
      `${host.label}: malformed ${host.formatAdapter.toUpperCase()} configuration`,
    ],
    ["AIOS_E_CONFIG_INVALID", RETRY, `${host.label}: invalid server map`],
    [
      "AIOS_E_CONFIG_INVALID",
      RETRY,
      `${host.label}: configuration cannot be changed without altering unrelated values`,
    ],
  ].map(([code, remediation, message]) => [message, { code, remediation, message }])
);
for (const [message, refusal] of PER_HOST) FIXED.set(message, refusal);

// Sentences ending in a user-influenced token. The token is never rendered: it is looked
// up in a trusted enum, and an unknown token collapses to the generic wording.
const CREDENTIAL_FIELDS = ["brain_url", "api_key", "team_id", "member"];
const TOKEN = [
  [
    "Unknown MCP installer option: ",
    () => ["AIOS_E_USAGE", USAGE, "Unknown MCP installer option."],
  ],
  [
    "Unsupported MCP host: ",
    (token) => {
      const host = MCP_HOSTS.find((row) => row.id === token);
      return [
        "AIOS_E_USAGE",
        USAGE,
        host
          ? `${host.label} is not supported on this platform.`
          : "Unsupported MCP host selection.",
      ];
    },
  ],
  [
    "Invalid credential field: ",
    (token) => [
      "AIOS_E_CREDENTIAL_MISSING",
      CONNECT,
      CREDENTIAL_FIELDS.includes(token)
        ? `Brain credential field is missing or invalid: ${token}.`
        : "A Brain credential field is missing or invalid.",
    ],
  ],
  // normalizeBrainOrigin quotes parts of the rejected URL; say only that it was rejected.
  [
    "Brain URL ",
    () => ["AIOS_E_CREDENTIAL_MISSING", CONNECT, "The Brain URL is not an accepted Brain origin."],
  ],
];

// Sentences ending in a path. The path is never rendered; it is resolved to the trusted
// registry label of the host that owns it, or to the installer's own state directory.
const PATHS = [
  ["AIOS_E_CONFLICT", "Concurrent edit: ", "was edited while the installer ran"],
  [
    "AIOS_E_CONFLICT",
    "Concurrent edit at atomic replacement: ",
    "was edited while the installer ran",
  ],
  ["AIOS_E_CONFLICT", "File changed while opening: ", "was edited while the installer ran"],
  ["AIOS_E_CONFLICT", "File changed while reading: ", "was edited while the installer ran"],
  ["AIOS_E_CONFLICT", "Directory changed: ", "changed while the installer ran"],
  ["AIOS_E_CONFLICT", "MCP package file was edited: ", "holds an edited MCP package file"],
  ["AIOS_E_CONFIG_INVALID", "Foreign ownership: ", "is owned by another principal"],
  [
    "AIOS_E_CONFIG_INVALID",
    "Unsafe ownership or permissions: ",
    "has unsafe ownership or permissions",
  ],
  ["AIOS_E_CONFIG_INVALID", "Unsafe directory: ", "is not a real directory"],
  ["AIOS_E_CONFIG_INVALID", "Not a regular unlinked file: ", "is not a regular, unlinked file"],
  ["AIOS_E_CONFIG_INVALID", "Configuration file is too large: ", "is too large"],
  [
    "AIOS_E_CONFIG_INVALID",
    "Private configuration directory is writable by another principal: ",
    "is writable by another principal",
  ],
];

function subject(file, options) {
  let targets = [];
  try {
    targets = hostTargets(options).filter((host) => host.file);
  } catch {
    /* An unresolvable registry only costs the label. */
  }
  const under = (dir) => file === dir || file.startsWith(`${dir}/`) || file.startsWith(`${dir}\\`);
  const host = targets.find(
    (row) => file === row.file || under(row.file.replace(/[\\/][^\\/]+$/, ""))
  );
  return host ? `The ${host.label} configuration location` : "An installer-managed location";
}

function classify(error, options) {
  if (error?.constructor !== Error || typeof error.message !== "string") return null;
  if (error.code !== undefined && !String(error.code).startsWith("AIOS_MCP_")) return null;
  const message = error.message;
  if (FIXED.has(message)) return FIXED.get(message);
  for (const [prefix, render] of TOKEN)
    if (message.startsWith(prefix)) {
      const [code, remediation, safe] = render(message.slice(prefix.length));
      return { code, remediation, message: safe };
    }
  for (const [code, prefix, clause] of PATHS)
    if (message.startsWith(prefix))
      return {
        code,
        remediation: RETRY,
        message: `${subject(message.slice(prefix.length), options)} ${clause}.`,
      };
  // A failed transaction wraps its cause; only a recognised cause is rendered.
  if (message.startsWith("MCP installation failed: ")) {
    const cause = classify(error.cause, options);
    if (!cause) return null;
    return {
      ...cause,
      message: `MCP installation failed: ${cause.message.replace(/\.$/, "")}. ${
        message.includes("; rollback conflicts (preserved): ")
          ? "Some files changed during rollback and were preserved with their recovery copies."
          : "Tracked writes were rolled back."
      }`,
    };
  }
  return null;
}

export function typedInstallerError(error, options = {}) {
  if (error instanceof AiosError) return error;
  const refusal = classify(error, options);
  // No `cause`: a typed error must not carry the unsafe original into any later renderer.
  return refusal ? new AiosError(refusal.code, refusal.message, refusal.remediation) : error;
}
