# ADR 0002 — Single-binary CLI platform and compatibility contract

- **Status:** accepted
- **Date:** 2026-08-25
- **Related:** AIO-1065, parent AIO-1064; unlocks AIO-635 and AIO-1066
- **Machine contract:** `docs/architecture/cli-command-inventory.v1.json`
- **Contract test:** `test/cli-architecture-contract.test.mjs`

## Context

AIOS 0.12.0 publishes three bins (`aios`, `linear`, and `slack`), maintains a 54-command `aios`
registry, dispatches five commands into `@aiosbrain/aios-devtools`, installs a shell function, and
vendors workspace launchers plus executable connector copies. The routes do not share one startup,
configuration, credential, output, or provenance contract. A clean Linux Node image cannot run the
Python-backed Slack path; a fresh Linear install has no credential bootstrap; current credential
resolution can combine fields found in different roots; and checkout-shaped release tests have
accepted failures from the packed artifact.

These are ownership failures. Repairing individual wrappers would leave the next command free to
create another configuration root or delivery path. A versioned route inventory and a single
runtime contract are therefore prerequisites to the implementation slices.

The evidence frozen for this decision is:

- core `aiosbrain/aios-workspace` base
  `42c8cba11ade76c2950e41c2cdb6dd24f72cd9c4`, including the merged CLI-inventory
  pagination correction;
- `@aiosbrain/aios-devtools` source
  `a4b8dcbe424c42a0f492691a6d5411f324bf56ca` and package `0.3.0`;
- the 2026-08-25 adversarial CLI audit named in AIO-1065;
- OpenClaw `1af9b07e30df15fb5387a5650cc48f7033f8fc2d`, used only for the command-registry,
  lazy-loading, diagnostic, and packed-artifact boundaries described below.

## Decision

### 1. One executable and one supported runtime

`aios` is the only canonical executable. The v2 package supports and tests exactly Node major
versions 22, 24, and 26 through the manifest range `22.x || 24.x || 26.x`. The current v1 root range
`>=22` and the pinned devtools package's `>=22 <23` range are recorded evidence, not the v2 support
contract. Before v2 release, the root range must narrow and the devtools dependency must be replaced
by a version that installs without engine warnings on all three supported majors. Node is the only
runtime required by a canonical route. Python, `jq`, a global `dotenvx`, a source checkout, a linked
package, or an executable copied into a workspace may not be a runtime prerequisite.

The canonical connector routes are `aios linear …` and `aios slack …`. The published `linear` and
`slack` names remain warning-only delegates for every v2 release. They invoke the same registry
descriptor and adapter as the canonical route, contain no configuration, credential, provider, or
business logic, write the deprecation warning to stderr, and preserve the canonical command's
stdout and exit status. Their earliest removal is v3.0.0.

The separate `aios-devtools` executable is not a second user platform. Its public command surface
moves behind the existing lazy `aios build`, `aios spec`, `aios consolidate-findings`, `aios ship`,
and `aios roadmap-run` routes in v2. The devtools package may remain a pinned implementation
dependency with module exports, but it does not own a canonical bin.

### 2. The versioned inventory is the Phase-1 authority

The versioned inventory is the normative ownership and migration authority until the v2 runtime
lands. The current execution registry in `scripts/cli/registry.mjs` contains its 54 descriptor-based
commands, while `help` and `version` are pre-configuration token routes in
`scripts/cli/dispatch.mjs`. The inventory deliberately normalizes both current mechanisms plus the
planned `doctor`, `provenance`, `linear`, and `slack` routes. This is a migration fact, not a second
future authority.

In v2, every top-level command has one descriptor in the `aios` registry. A descriptor declares:

```ts
interface CommandMetadata {
  name: string;
  owner: "core.cli" | "adapter.linear" | "adapter.slack" | "adapter.devtools";
  configurationRequirement: "none" | "optional" | "user" | "workspace" | "user-or-workspace";
  credentialRequirement: "none" | "optional" | "brain" | "provider" | "brain-or-provider";
  networkBehavior: "never" | "optional" | "required";
  outputMode: "human" | "human-or-json" | "protocol";
  startupPolicy: "diagnostic" | "pre-config" | "offline" | "requires-workspace";
  implementation: { module: string; lazy: boolean };
}
```

The versioned inventory freezes those values for the current registry, the two current diagnostic
token routes, and the four planned diagnostic/connector routes. The contract test separately proves
that every current registry entry, published bin, and special diagnostic token route is present. A
new bin, registry command, compatibility route, scaffolded executable, or executable skill path is
incomplete until the same PR assigns it one future owner and a disposition in the inventory.

All adapter implementation imports are lazy. A load or parse failure in one adapter is contained
to that adapter's commands and diagnostics; it cannot prevent unrelated commands from starting.

### 3. Diagnostic startup is configuration-independent

`aios help`, `aios version`, `aios doctor`, and `aios provenance` use `startupPolicy:
"diagnostic"`. They must start when no user or workspace config exists and when either config is
invalid. They must not import a connector runtime, resolve credentials, contact the network, or
execute a config migration.

`doctor` is read-only unless an explicit repair subcommand is supplied. `provenance --json`
reports executable path and realpath, package version, build SHA, install type
(`registry|link|checkout`), Node version, resolved config paths, adapter package versions, bin
targets and modes, runtime prerequisites, registry drift, and legacy-command shadowing. It never
reports a credential value or a secret reference's resolved value.

### 4. Configuration has two scopes

User config owns defaults and secret references. Its path is:

- `$AIOS_CONFIG_DIR/config.json` when `AIOS_CONFIG_DIR` is an absolute path;
- otherwise `$XDG_CONFIG_HOME/aios/config.json` on Linux when `XDG_CONFIG_HOME` is absolute;
- otherwise `~/.config/aios/config.json` on Linux;
- otherwise `~/Library/Application Support/aios/config.json` on macOS;
- otherwise `%APPDATA%\\aios\\config.json` on Windows.

Relative override paths are rejected. The file contains a schema version, default workspace, and
credential-source references. Plaintext provider or Brain secrets are rejected. Unknown fields
survive a read/write cycle so a newer client is not damaged by an older one.

Workspace `aios.yaml` owns non-secret team, project, repository, connector-enablement, and endpoint
settings. It may select a named user credential source but may not contain a token, password,
private key, OAuth refresh token, or provider-shaped secret. A workspace path never silently
becomes the user default merely because it is the current directory.

Writes use a same-directory temporary file, restrictive permissions, file flush, atomic rename,
and directory flush. The pre-write bytes become the last-known-good snapshot before a schema
migration. A failed validation, write, or rename leaves the live file and snapshot unchanged.

### 5. Credentials are selected as one complete source

A credential source is a named root containing every required field for one target. Resolver
precedence is: an explicitly named source, a complete process-environment source, the selected
user-config reference source, then a v2-only legacy workspace source. Slack may select a Brain
delegation source when its adapter declares that source complete. Precedence chooses among
complete sources; it never chooses fields.

If a higher-precedence root is present but incomplete, resolution stops with
`AIOS_E_CREDENTIAL_INCOMPLETE`. It does not fill the missing fields from another root. Optional
fields are read only from the selected root. Diagnostics may report the source class and reference
name, never the resolved values.

Credentials may be attached only after destination validation. Remote destinations require HTTPS.
Credential-free HTTP is allowed only for literal loopback hosts (`127.0.0.0/8`, `::1`, or
`localhost`) when the process environment contains exactly `AIOS_ALLOW_INSECURE_LOOPBACK=1`. This
flag never permits credentials, non-loopback HTTP, or a redirect away from loopback. Redirects are
revalidated before a credential is forwarded; credentials are not forwarded across origins.

### 6. Output, errors, and exit behavior are stable

Machine payloads use stdout. Diagnostics, warnings, progress, and human remediation use stderr.
In `--json` mode stdout contains exactly one JSON value and no colour, progress, or warning bytes.
Human mode may use stdout for successful command results; failures use stderr and leave stdout
empty unless the command contract explicitly documents a partial machine result.

Every error has one stable code, one cause, and one actionable remediation. JSON errors use:

```json
{
  "ok": false,
  "error": {
    "code": "AIOS_E_CREDENTIAL_MISSING",
    "message": "Linear credentials are not configured.",
    "remediation": { "command": "aios connect linear" }
  }
}
```

Core codes are `AIOS_E_USAGE`, `AIOS_E_CONFIG_MISSING`, `AIOS_E_CONFIG_INVALID`,
`AIOS_E_CREDENTIAL_MISSING`, `AIOS_E_CREDENTIAL_INCOMPLETE`, `AIOS_E_DESTINATION_UNTRUSTED`,
`AIOS_E_NETWORK`, `AIOS_E_PROVIDER`, `AIOS_E_CONFLICT`, `AIOS_E_MIGRATION`, and
`AIOS_E_INTERNAL`. Adapters may add namespaced codes without redefining a core code. Stable exit
classes are 0 success, 2 usage, 3 configuration/credential, 4 network/provider, 5
conflict/integrity/migration, and 6 internal failure.

### 7. Connectors conform to one lazy boundary

Linear and Slack are built-in adapters, not externally discovered plugins:

```ts
interface Connector {
  configure(input: ConfigureInput): Promise<ConfigResult>;
  status(context: ConnectorContext): Promise<StatusResult>;
  doctor(context: ConnectorContext): Promise<Diagnostic[]>;
  execute(command: ConnectorCommand, context: ConnectorContext): Promise<CommandResult>;
}
```

Cold metadata—name, version, required configuration, credential fields, capabilities, and loader
specifier—lives in the core registry and is safe to inspect without importing runtime code.
`configure` owns interactive and non-interactive bootstrap, `status` reports readiness without
revealing secrets, `doctor` is read-only, and `execute` is the only provider-operation boundary.

The Linear adapter preserves pagination, description integrity and readback, hierarchy,
relations, priority, project, member, and mutation semantics. The Slack adapter preserves whoami,
resolve, read, send, DM, reaction, and file flows in Node. Provider writes return stable identity
and perform readback where the provider supports it.

### 8. Inventory dispositions and release boundaries

Every current route has exactly one disposition:

- `keep`: the route remains canonical under its named future owner;
- `delegate`: the route remains temporarily but contains only a warning and delegation;
- `migrate`: consumers/configuration move to the named replacement at the stated boundary;
- `delete`: the route disappears at the stated boundary after its replacement is available.

Every non-`keep` route names a replacement, release boundary, removal boundary, rollback, and
repository evidence. `linear` and `slack` delegates exist throughout v2 and may be removed no
earlier than v3. Skills become routing instructions and may not retain executable connector
clients. Scaffold/update paths install or point to the canonical package; they may not create a
second implementation owner.

### 9. Upgrade and rollback are paired transitions

The v2 migration state machine is `discovered -> snapshotted -> staged -> validated -> committed`.
Only `committed` changes the active config version. Re-running from any state converges to the same
bytes. An interruption before commit leaves v1 active; an interruption after commit finds a valid
v2 file and performs no additional mutation.

Before changing package or config state, update records the exact installed package version,
integrity/provenance evidence, active config paths, and last-known-good config snapshot. Rollback
during v2 reinstalls that exact verified package and atomically restores the snapshot. It does not
attempt a reverse field-by-field migration. Legacy delegates remain available for the entire v2
rollback window. Later migration implementation must prove atomicity, interruption recovery, and
byte-stable idempotence against the packed artifact.

### 10. Borrowed and excluded OpenClaw boundaries

AIOS adopts OpenClaw's central command registry, cold metadata with lazy runtime loading,
configuration-independent diagnostics, and immutable packed-artifact validation boundaries. It
does not adopt external plugin discovery, a marketplace, runtime hook activation, multiple command
registries, or a plugin state database. Two built-in adapters do not justify those mechanisms.

## Consequences

- AIO-635 and AIO-1066 may implement against this contract without choosing new ownership,
  compatibility, config, credential, or output rules.
- Phase 1 changes documentation, inventory, and contract tests only; it does not implement the v2
  runtime, migrate connectors, publish npm packages, or modify aios-devtools.
- Until v2 lands, the inventory describes both current routes and their locked future state. A
  current defect is evidence for migration, not permission to silently claim the route already
  conforms.
- Any future route not represented in the inventory fails the contract test. An intentional
  architecture change requires a superseding ADR, inventory version, migration boundary, and
  updated test in the same PR.

## Verification contract

`node --test test/cli-architecture-contract.test.mjs` proves that every published bin and every
registered top-level command is inventoried; every executable in the named skill, descriptor,
scaffold, shell-function, and update seams is referenced by the inventory; every entry has one
future owner and valid disposition; adapter runtime imports are deferred; compatibility entries
contain replacement, removal, rollback, and evidence; the canonical connector routes are
`aios linear` and `aios slack`; diagnostic startup is isolated; and no implementation-blocking
placeholder remains.

Phase 1 cannot behavior-test modules that do not exist. The inventory therefore carries a
machine-checked `implementationProofs` list. Each proof is mandatory before the v2 release and
names the owner and required tests for the Node/devtools engine range, config resolution,
credential-source isolation, destination and redirect validation, output/error behavior, and
atomic/idempotent migration. Deferral means “required before v2,” not optional or unspecified.
