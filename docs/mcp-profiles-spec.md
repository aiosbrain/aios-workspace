---
eval_tier: deterministic
spec_gate: block
safety: true
type: issue-spec
---
# Explicit MCP connection profiles

## What / why
AIO-1190 extends the existing configuration broker and guided host installer so a selected Brain and optional workspace have explicit destinations, credentials and independent grants. Working directory must never authorize workspace access.

## Outcomes
- Explicit profile selection works in both installed server modes without credential mixing.
- Migration preserves legacy read-only installations and grants no new authority.
- Revocation, recovery and installed-artifact verification fail closed.

## Interface / integration points
Existing `scripts/cli/config-broker.mjs`, `scripts/mcp-config.mjs`, `scripts/mcp-credentials.mjs`, `scripts/mcp-workspace.mjs`, and `scripts/mcp-host-install.mjs` consume the reserved profile contract in `docs/contract/mcp-next-v1/` at Workspace commit 606afeaed5a9612a7231a96f15a8b893f22ea9a4.

## Dependencies
Depends on: AIO-1185. The additive member-authorized project destination endpoint is contract-first integration work. Publication and final mutation projection remain AIO-1196 and AIO-1193.

## Scope
**In:** explicit profiles, migration, status, setup/revoke/recovery/uninstall, installed artifact and runtime connection plumbing.
**Deferred:** bounded workspace operations and collection (AIO-1191), publishing (AIO-1192), final mutation tools, OAuth and remote writes.

## Build-with
Implementation follows neutral review record NW-20260928-TP-01, with independent exact-head review before integration. Reviewed implementation plan SHA-256: 8f029540f283709bb9a958ab28c5a5882a84d1aadb459467f4deaecf2c92b24d. Artifact decision SHA-256: 4fdb39c5547b95c9f239a541dfbe1d30946db91106e724957a68bb5a70294390.

## Tier safety
Local access, local draft, Brain action and publish grants are independent; read-only disables every mutation. Brain-only has no workspace access. Legacy reads retain server authorization. No profile changes tiers or bypasses current project membership.

## Observed baseline

1. `scripts/cli/config-broker.mjs` already reads/writes schemaVersion **2**, preserves unknown keys and rejects secret-bearing values. `credentialSources` accepts env:/keychain: references only. `connectionProfiles` is not yet a known field. This is an additive extension migration, never a v1-to-v2 migration.
2. `scripts/mcp-config.mjs` resolves legacy environment/workspace/global defaults; `scripts/mcp-credentials.mjs` securely reads the owner-only global default tuple. These compatibility paths cannot resolve an explicit profile by falling back to their normal precedence.
3. `scripts/mcp-host-install.mjs` writes one global default credential tuple and one managed `aios-brain` entry per selected host. It verifies identity via /me, transactionally commits artifacts/credential/records/host files, rejects running hosts, refuses edited entries, and preserves credentials on uninstall. `scripts/mcp-host-files.mjs` supplies strict ownership/ACL, identity/byte rechecks, native atomic replacement, backups and conditional rollback. Generic broker `atomicWrite` alone does not supply that complete transaction guarantee.
4. `scripts/mcp-host-artifact.mjs` verifies the published standalone 0.2.1 SHA-512 and exact 15-file closure. `scripts/mcp-hosts.mjs` freezes five external/nine team read memberships. New profiles cannot be pointed at 0.2.1, which has no profile support.
5. `scripts/mcp-runtime.mjs` snapshots membership at startup and passes cwd into the dispatcher. `scripts/mcp-workspace.mjs` walks cwd to a workspace and imports the installed module-relative operator-loop barrel. There is no root/profile/grant binding. The current local test explicitly asserts cwd discovery and needs replacement.
6. The standalone build has a strict static, builtin-only import closure. Pulling in all of `scripts/cli.mjs`, connector adapters, or the toolkit's dotenvx resolver would violate that boundary. The broker module itself needs only flat-yaml, atomic-file and errors, all currently builtin-only.
7. `resolveCredentialRoot` is the reusable complete-tuple primitive. Foundation `decryptDotenvKey(root,key)` is the existing single-key encrypted resolver; `resolveConnectorEnv` is unsuitable because it combines multiple roots and may use AIOS_AGENT_WORKSPACE. Linear's reference helpers are connector-owned and must not be imported directly into MCP.
8. The canonical Node test inventory is tracked-files-only. New `.test.mjs` files must be added to git before aggregate discovery can prove they run. Native installer CI currently has an explicit four-file test list and triggers that omit profile/config/runtime changes.

## Intended behavior and internal API

The implementation extends the current broker and installer. No new user configuration store or parallel installer is introduced. Existing unprofiled read-only installations retain their current read behavior. They acquire no root or grant from migration, upgrade, environment, selectors, host roots or defaultWorkspace. Unprofiled toolkit launches no longer advertise/execute local collection; they return explicit setup guidance for a direct stale invocation. AIO-1191 will make collection bounded; AIO-1190 must not accidentally retain the current unrestricted collector under a newly granted profile.

Add a small reusable profile module with these internal operations (names can be adjusted during implementation without changing public contracts):

- `readConnectionProfiles(options)`: read broker schemaVersion 2, validate independent extension version 1.0.0, every schema field and semantic uniqueness of profile IDs; reject unsupported/malformed versions without writes.
- `prepareProfileMigration(config, explicitlyRequestedProfiles)`: preserve unknown fields, missing optional legacy fields and exact unresolved credential references. Add extension with no inferred profiles. New requested profiles have four false grants; existing identical profiles are unchanged. Reject attempted migration escalation. Pure preparation; no secret resolution.
- `prepareProfileRegistration(input, options)`: explicit ID, mode, origin, team, project, source reference name, root/allowlists and requested individual grants. Normalize HTTPS origin; validate selected credential, /me identity and project membership; canonicalize explicit root and capture stable filesystem identity. No workspace scan, hooks, installs, Git, or arbitrary subprocess from folder attachment. Brain-only has null root/identity, empty roots and no local grants. All grants default false. Invalid or unsupported input fails before writes.
- `loadProfileBinding(profileId, options)`: resolve one profile, one named reference and its origin/team/project as one complete tuple. No fallback to a global key, alternate reference, cwd, defaultWorkspace, AIOS_AGENT_WORKSPACE or aios.yaml. A missing selected source fails without consulting alternatives. Keep secret value only in the private client construction path; errors/status expose source class only.
- `authorizeProfileCall(binding, {requestProfileId, capability, readOnly})`: re-read current config on every tools/list and every tools/call, including all existing Brain reads and status. Verify launch/request profile match, generation and destination/binding consistency, canonical root identity for workspace-mode profiles, effective grants and current Brain authorization where relevant. There is no cached-client or old-read bypass. Return a validated current binding, not a caller-editable config object. Construct/select the request client only from that complete current tuple. A changed launch generation, destination, credential-source mapping or root identity yields PROFILE_CHANGED without a network read; restart explicitly to adopt the newer profile. A missing profile yields PROFILE_NOT_FOUND. A revoked requested capability yields CAPABILITY_DENIED. tools/list returns a sanitized JSON-RPC failure when binding validation fails; tools/call returns the existing in-band isError shape with a safe code and remediation. Never expose the previous list or run its handler on failure. Cached tools/list membership never authorizes a call. `--read-only` intersects grants to disable brainActions/workspaceDraft/workspacePublish even for explicit selectors.
- `inspectProfile(...)`: conforming `StatusOutput` fields, including configured versus effective grants and explicit identityVerified false on offline/failed probe. Existing read result fields stay compatible. Human installer status can add safe actionable diagnostics outside the strict typed workspace payload.

Local authorization remains usable when Brain is offline: valid root/grant checking does not require an online identity response. Brain actions and publishing still need current server authorization. Profile validation at registration proves destination membership once but does not substitute for runtime authorization.

## Credential and dependency decisions

- Keep profiles' `credentialSource` as a map key into existing `credentialSources`. Store no API key in config.json, host JSON/TOML, installation records, backups of new metadata, argv, diagnostics or fixtures.
- Generic env:/keychain: parsing/resolution belongs under `scripts/cli/` as a focused shared helper, not a dependency on Linear/Slack adapters. If extracting existing helper code, root coordinates adapter adoption separately; this lane need not refactor unrelated connectors.
- Env lookup uses only the explicitly selected variable. Brain-only never reads workspace files or decrypts a workspace vault. Keychain lookup uses a trusted OS executable/backend and an explicit supported-platform failure; do not silently substitute PATH commands or credential files.
- For toolkit workspace mode, when the selected `env:NAME` reference is absent from the process, a scoped adapter may resolve only NAME from the explicitly bound root using the existing `decryptDotenvKey` mechanism. It must not import `resolveBrainConfig` or `resolveConnectorEnv` precedence. No full dotenvx run or unrelated-key output. Validate the root before this read. Empty/present selected input fails closed. The adapter and its dependency remain out of the standalone closure. A root or source change increments generation.
- Existing `~/.aios/credentials.json` remains a legacy compatibility input only. Migration never silently copies it into a profile, rewrites its tuple, or invents a keychain reference. A new profile requires an explicit working allowed reference. Keychain enrollment, if offered, is explicit installer work with no secret echo and rollback semantics; credential deletion/administration remains out of scope.
- Minimal standalone consumer addition is a builtin-only profile reader/guard and the needed broker/reference helpers. No Ajv runtime dependency: runtime guards can validate the frozen profile contract while tests validate equivalence against canonical Draft-07 fixtures using the toolkit's existing Ajv. No foundation export expansion is required.

## Lifecycle rules

All profile writes use the current file-policy/transaction machinery, protecting the user config with owner-only access and exact original-byte/identity preconditions. Serialize profile mutations with an owner-controlled exclusive lifecycle lock, acquired before reading the current profile and retained through final commit/recovery. Readers reject an active or unresolved lifecycle transaction without using a cached binding. Concurrent mutators fail with actionable retry guidance, never overwrite a winning update. Lock recovery must verify recorded owner/process/transaction identity; an uncertain stale lock fails closed. Preserve committed per-profile high-water generations in a versioned internal lifecycle field of the existing the user-level installation records records (no second configuration store). IDs are unique and retained after revocation; no delete/recreate command is exposed. A profile generation below its retained high-water mark is stale, even if an old config snapshot was manually restored; startup/list/call cannot execute it. A higher uncommitted or mismatching generation also fails closed until recovery. Ledger and config writes use the same transactional machinery, with crash tests at every boundary. Registration/grant updates and their host records must have one reviewed transaction ordering. Do not silently harden or take over pre-existing insecure/unowned configuration.

- Migration: preserve all prior content, backup before mutation, no-op when identical; failure/unsupported version leaves every file unchanged. No inferred identity/destination/root/profile.
- Setup: choose Team Brain or Team Brain + workspace, explicit destination/source and (workspace mode) explicit canonical root and independent read/draft roots; display destination, root, source class and requested grants before save. Noninteractive flags are explicit consent only for exactly named grants. No `--yes` shortcut grants extra rights.
- Profile update: increment generation for root, root identity, origin/team/project, credential binding (including source-map reference change), allowlist or grant changes. Identical update is a no-op. Generation overflow refuses safely. A source-map update affecting multiple profiles must increment all affected profiles atomically or be refused with explicit remediation.
- Revoke: explicit profile/grant selection, persist grant false and advance generation. Whole-profile revocation disables all four grants; preserving profile IDs avoids ABA reuse. Revoke requires no live Brain access or host restart and must be enforced by the next protected call of a running process. Do not delete credential values.
- Upgrade: preserve registered destinations/grants and legacy default records; replace only owned unchanged host entries with a profile-capable pinned command. No implicit migration of a legacy installation to write access.
- Rollback: installer failure conditionally restores its unchanged writes and reports concurrent-edit recovery. A user-requested version/config rollback cannot decrease generation or restore previously revoked grants. Retained lifecycle high-water records are not rolled back; recovery restores previous profile fields with all mutation grants disabled and a generation above every observed committed/reserved epoch, or reports an unresolved conflict and leaves calls blocked. Removing local read grants during recovery is allowed; no grant may be increased by rollback. A no-op failure before reserving an epoch leaves the original profile unchanged. Reapplying an older root/destination/grant state requires fresh explicit setup and a newer generation. Previous pinned read-only standalone installs can remain usable, but old readers cannot execute a selected profile. No old-binary fallback on profile startup failure.
- Uninstall: remove only exact owned host blocks and corresponding records; preserve edited/unowned blocks, shared profiles, legacy credentials and durable plan/receipt evidence. Uninstall is not revocation. Status explains that distinction and how to revoke separately.
- Root replacement: root device/inode (or platform-supported equivalent) mismatch fails local calls. Never rebind automatically by pathname. Explicit re-registration captures new identity and advances generation, invalidating pending consumers.

## Installer and artifact seam

Keep the current host registry and JSON/TOML format protections. Claude Desktop is macOS/Windows only; Code/Codex/Cursor use their existing supported native OS matrix. For Claude Code, distinguish the host config project directory from a workspace root: it must be explicit in guided setup/noninteractive usage, never an authorization consequence of cwd. Host-provided roots may offer untrusted suggestions only.

New commands must include `--profile <id>` and an exact artifact reference. Brain-only uses a verified profile-capable standalone package. Workspace uses a verified installed pinned toolkit entrypoint from an immutable versioned installation, never this development checkout, a workspace shim, ambient `aios`/npx, AIOS_TOOLKIT_DIR, or project-local node_modules. Node executable remains explicit. Record profile ID, mode, artifact name/version/integrity and owned block in the existing installation records with an explicit record version migration.

The current toolkit has runtime dependencies/native modules, so copying only `scripts/brain-mcp.mjs` is not an installed toolkit. The coordinator has selected the existing package preparation path: explicit guided setup fetches the exact versioned toolkit tarball through the existing trusted package resolver, verifies the registry integrity before extraction, and installs its declared dependencies under an owner-controlled version/integrity-specific directory. Reuse existing package resolver/install primitives and package-acceptance construction; do not build a new distribution system. Record tarball integrity, package name/version, installed entrypoint plus manifest/entrypoint byte hashes in the existing installation receipt. Validate owner/ACL, reject symlink roots/entrypoints and compare recorded manifest/entrypoint hashes at launch verification. the generated build provenance SHA/version is provenance metadata only, never byte-integrity proof. Toolkit preparation runs only during explicit setup and may satisfy its declared install requirements; workspace attachment/read cannot trigger npm, package scripts or workspace hooks. Failed or interrupted preparation never activates a host entry. Existing verified installations remain intact. The root pins published defaults only after AIO-1196 publication; until then profile setup using a public profile-incapable version returns truthful unavailable guidance while legacy installs keep working. Do not weaken the standalone decoder's no-dependencies/no-lifecycle-script rule to accommodate toolkit artifacts.

Concrete artifact adapter boundary: extend the existing `scripts/mcp-host-artifact.mjs` with `prepareProfileArtifact({mode, packageVersion, home, policy, dryRun, artifactInput})`, returning `{command, artifactReceipt, expectedServer, stagedChanges}`. `command` is the explicit Node plus installed entrypoint and profile args; `artifactReceipt` contains package name/version, tarball SHA-512 integrity, manifest SHA-256, entrypoint SHA-256, installation root and relative entrypoint; `expectedServer` contains frozen candidate version/supported capabilities; `stagedChanges` feeds existing `commitHostFiles` where appropriate. `artifactInput` is an internal verified-artifact test seam, not a public CLI/environment override. Dry-run may fetch/validate bytes but creates no prefix, dependency install, cache, receipt, lock or backup. Real preparation stages a toolkit install from the verified local tarball using the existing npm installation procedure, validates manifest and `resolveDistributionRoot(...).kind === "registry"`, rejects an enclosing checkout, proves required dependency resolution in the controlled prefix and only then commits the receipt/host entry. Staging cleanup is identity-checked and never removes pre-existing installations. Reuse `scripts/cli/distribution-root.mjs` for installed-root validation and the exact tarball install procedure from `test/package-acceptance/lib/journeys-lifecycle.mjs`; it is not a claim that distribution-root currently downloads packages. Registry metadata fetch/integrity checks remain in the existing artifact preparation module; do not introduce a new downloader service or package manager. Required declared install scripts execute only in this explicit verified setup step and never against the attached root.

Verification derives expected server version and permitted membership from the selected frozen candidate manifest/profile capabilities, not moving source or a simple tool count. Validate recorded initialize/tools/list/status and at least one protected call. A profile-capable server must prove the selected profile/destination; a legacy 0.2.1 success is not sufficient. Candidate acceptance can consume an exact packed candidate artifact before publication; final release pins are selected and verified by root at freeze. There must be no public unsafe integrity bypass.

## Implementation files

Existing paths (relative to Workspace; no other lane edits these without coordination):

- `scripts/cli/config-broker.mjs`
- `scripts/mcp-config.mjs`
- `scripts/mcp-credentials.mjs`
- `scripts/mcp-workspace.mjs` — only remove cwd authority and require the profile guard; bounded file/collection implementation remains AIO-1191.
- `scripts/mcp-host-command.mjs`
- `scripts/mcp-host-install.mjs`
- `scripts/mcp-host-errors.mjs`
- `test/cli-config-broker.test.mjs`
- `test/mcp-credentials.test.mjs`
- `test/mcp-host-cli.test.mjs`
- `test/mcp-host-install.test.mjs`
- `test/mcp-host-verify.test.mjs`
- `test/mcp-workspace.test.mjs`
- `docs/mcp-host-install.md` — mark new behavior unreleased until root release evidence exists.

Additional existing surfaces exclusively delegated to this lane by coordinator (root retains final composition/integration and public pins):

- `scripts/brain-mcp.mjs`, `scripts/mcp-runtime.mjs`, `scripts/mcp-stdio.mjs` — minimal profile parse/binding/list/call bridge.
- `packages/mcp-core/capabilities.mjs` — profile/read-only selection and hide unsupported local collection; existing tools only.
- `packages/mcp/bin/aios-brain-mcp.mjs` — selected-profile entrypoint before legacy resolution.
- `packages/mcp-build/build.mjs` — explicit builtin-only closure additions.
- `scripts/mcp-host-artifact.mjs` — extend preparation via existing package resolver; root owns frozen public version/integrity constants.
- `test/package-acceptance/pack.mjs`, `test/package-acceptance/lib/context.mjs` — extend current exact-tarball evidence and installed dependency isolation.
- `test/mcp-capabilities.test.mjs`, `test/mcp-package.test.mjs`, `test/mcp-host-atomic.test.mjs`, `scripts/brain-mcp.test.mjs` — executable bridge, package and transaction regressions.

New bounded modules/tests:

- `scripts/cli/connection-profiles.mjs` — schema semantics and pure migration/update generation.
- `scripts/cli/credential-reference.mjs` — builtin-only selected-reference logic.
- `scripts/mcp-profile-binding.mjs` — read-only resolution/authorization/status reusable by runtime and later operations.
- New file: `scripts/mcp-profile-setup.mjs` — registration/update/revoke orchestration with existing transaction primitives.
- `scripts/mcp-profile-workspace-credentials.mjs` — toolkit-only scoped encrypted-key adapter, excluded from standalone.
- `test/mcp-profile-migration.test.mjs`
- `test/mcp-profile-binding.test.mjs`
- `test/mcp-profile-lifecycle.test.mjs`
- `test/package-acceptance/lib/journeys-mcp-profiles.mjs` — isolated installed candidate journey; root wires it into shared runner.

## Integration dependencies

1. Runtime bridge/artifact implementation is now delegated exclusively to this lane as above; root integrates it after review. No new action/workspace operations or final AIO-1193 projection. `packages/mcp-core/index.mjs` remains root-owned if common registry composition becomes necessary.
2. CLI routing/help: `scripts/cli/{registry,usage}.mjs` route `aios mcp profile <register|status|revoke|migrate>` (or an agreed equivalent), profile selectors and explicit host config target. Root decides final command spelling consistently with operations.json; no competing registry edits.
3. Root owns package version/default pins, manifests/locks and frozen `scripts/mcp-hosts.mjs` public artifact facts. This lane extends artifact helpers and build closure against the root-approved exact local candidate tuple. Root supplies the candidate pin/expected membership to acceptance and final public defaults only at release freeze. No concurrent edits to delegated files.
4. CI/inventory: `.github/workflows/mcp-host-install.yml` include new files in triggers and native test list; package acceptance runner invokes profile journey on Linux/macOS/Windows and Node 22/24/26. Shared size/coverage baselines are root-owned; no gate relaxation.
5. Shared docs/schema/mirrors are root-owned. No schema change is presumed; if implementation reveals a gap (e.g. root identity platform support), record exact gap and seek coordinated contract review rather than inventing a new persisted public field.
6. Brain destination validation seam is resolved and root-owned contract-first: authenticated `GET /api/v1/projects/{project_id}` returns exactly `{project_id, team_id}` after the existing `visibleProjectsWithError` membership oracle confirms the selected UUID. Missing/inaccessible is uniform 404; oracle/database failure is retryable 503. Setup requires exact returned project/team match with the profile and /me's authenticated team before writes. External-posture member keys work only for currently granted projects; no board-role shortcut or grant creation. Existing project list response is unchanged. Profile lane consumes the coordinator's reviewed contract/companion commit before implementation tests against this seam.

## Acceptance criteria

Focused tests must be executable behaviors, using real disposable files and sentinel credentials, not only copies of the implementation's predicates. New named scenarios:

- `migration-preserves-unknown-and-absent-fields`, `migration-no-cwd-defaultworkspace-inference`, `migration-no-grant-escalation`, `migration-identical-noop`, `unsupported-extension-no-writes`, `duplicate-profile-id-denied`.
- `selected-source-missing-no-fallback`, `two-roots-two-brains-isolated`, `ambient-key-origin-ignored-for-profile`, `scoped-decrypt-only-selected-key`, `brain-only-never-reads-vault`, `status-and-errors-redact-sentinels`.
- `canonical-root-captured`, `invalid-root-denied`, `root-replacement-denied`, `host-root-suggestion-no-grant`, `changed-source-reference-invalidates-all-bound-generations`.
- `each-grant-independent`, `readonly-overrides-explicit-tool-name`, `cached-tool-call-after-revoke-denied`, `tools-list-after-revoke-denied`, `old-read-and-status-after-source-change-denied`, `removed-profile-no-cached-client`, `offline-local-authorization-independent`, `profile-cross-selection-denied`, `generation-overflow-denied`, `rollback-cannot-resurrect-grant-or-generation`.
- `setup-rejects-wrong-team-or-invisible-project-before-write`, `dry-run-no-files-dirs-backups`, `upgrade-owned-only`, `stale-profile-command-refused`, `uninstall-preserves-shared-and-edited`, `mid-transaction-failure-restores-unchanged`, `concurrent-config-edit-preserved`, `concurrent-profile-mutators-no-lost-update`, `crash-after-epoch-reservation-denies-old-config`, `restored-backup-below-high-water-denied`, `revoked-id-reuse-cannot-resurrect-plans`.
- `legacy-five-nine-reads-unchanged`, `legacy-upgrade-no-local-or-write-grants`, `unbound-collector-denied-without-file-read`.

Run focused Node tests under development Node 22, then complete `npm test`, lint/format, contract fixture/conformance and required security/provenance gates in the implementation worktree. Verify `npm run test:node:list` includes the new tracked tests; native installer workflow must actually run lifecycle cases. Keep existing atomic replacement/race tests intact. No local test was executed for this read-only specification task.

Installed-artifact acceptance extends `test/package-acceptance/pack.mjs` and `test/package-acceptance/lib/context.mjs`: pack once behind existing clean-surface barriers, retain the exact tarball SHA-256, package version/name, file inventory, dependency metadata and candidate SHA; every cell re-verifies digest before installation. Add the candidate standalone pack tuple to the same artifact/evidence route, with independent manifest/inventory validation. Cells never repack. Extend installed dependency probes to prove every required runtime dependency resolves within the installation prefix, no npm-link/source-checkout escape, and native loadability on each supported OS/Node cell. Feed verified candidate bytes through the existing test artifact route only; never a production skip-integrity flag or replacement command/verifier. Installed-artifact acceptance must install these exact artifacts into an isolated prefix/home outside source checkouts; clear toolkit override env; do not inject an alternate server command/verifier. Use two synthetic HTTPS Brain origins and two explicit roots with different sentinel values. Exercise setup for both modes and every supported host format, run the exact recorded command from a third unrelated cwd, inspect status and tools, then mutate grants through the actual profile CLI while the subprocess remains live and prove denial before its next protected call. Confirm source checkout paths cannot appear in installed commands/import resolution and no real-user host/config bytes changed. Include native ownership/ACL and root-replacement tests. Assert stable five/nine legacy reads, no leaked sentinel and no arbitrary workspace hook/install/commit execution. Use a locally trusted test HTTPS certificate, not a production HTTP-origin exception.

AIO-1190 does not implement AIO-1191 bounded list/read/write/collect or AIO-1192 publishing. Its reusable guard and generation invalidation are directly testable now; the later real-operation plan/call integration tests remain dependency gates. Do not claim workspace mode complete merely because a profile exists or an inert tool advertises it.

Manual evidence: clean setup of both connection choices in a real host; record native OS, host name/version, toolkit/MCP exact artifact versions/digests, selected identity/destination visible inside the host, grant choices, restart/trust behavior, and revocation before the next protected call. Retain concrete evidence for AIO-1195's all-four-host journeys. Automated JSON/TOML/subprocess validation is not host UI acceptance. User-only trust/keychain consent may require the owner; no need to request product-scope approval already granted. This read-only task has neither changed real host settings nor claimed manual acceptance.

