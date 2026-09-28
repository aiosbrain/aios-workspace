import { lstatSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseUserConfig, resolveUserConfigPath } from "./cli/config-broker.mjs";
import {
  ProfileError,
  deny,
  effectiveGrants,
  profileFingerprint,
  validateProfiles,
} from "./cli/connection-profiles.mjs";
import {
  parseCredentialReference,
  resolveCredentialReference,
} from "./cli/credential-reference.mjs";
import { readPrivateDocument } from "./mcp-credentials.mjs";

export function profilePaths(options = {}) {
  const home = options.home ?? os.homedir();
  return {
    config: resolveUserConfigPath(options),
    records: path.join(home, ".aios", "mcp-installations.json"),
    lock: path.join(home, ".aios", "mcp-profile.lock"),
  };
}
export function rootIdentity(root) {
  try {
    if (!path.isAbsolute(root) || realpathSync(root) !== root) deny("PROFILE_CHANGED");
    for (let at = root; ; at = path.dirname(at)) {
      const stat = lstatSync(at, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) deny("PROFILE_CHANGED");
      if (at === root) {
        if (!stat.ino || !stat.dev) deny("PROFILE_CHANGED");
      }
      if (at === path.dirname(at)) break;
    }
    const stat = lstatSync(root, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch {
    deny(
      "PROFILE_CHANGED",
      "The registered workspace root changed or is unavailable. Repeat explicit setup."
    );
  }
}
export function readProfileState(options = {}) {
  const paths = profilePaths(options);
  try {
    if (existsSync(paths.lock) && !options.allowLocked)
      deny(
        "PROFILE_CHANGED",
        "Profile setup or recovery is in progress. Retry after it completes."
      );
    const raw = readPrivateDocument(paths.config, { ...options, optional: true });
    const document = raw ? parseUserConfig(JSON.stringify(raw)).document : { schemaVersion: 2 };
    const records = readPrivateDocument(paths.records, { ...options, optional: true }) ?? {
      version: 1,
      installations: [],
    };
    if (records.version !== 1 || !Array.isArray(records.installations)) deny("INVALID_PROFILE");
    if (records.profileTransaction && !options.allowLocked)
      deny("PROFILE_CHANGED", "Profile recovery is required before connections can resume.");
    const profiles = document.connectionProfiles
      ? validateProfiles(document.connectionProfiles).profiles
      : [];
    return { paths, document, records, profiles };
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    deny(
      "INVALID_PROFILE",
      "Private profile configuration is unavailable or unsafe. Inspect ownership and repeat setup."
    );
  }
}
export function inspectProfileBinding(profileId, options = {}) {
  const state = readProfileState(options);
  const profile = state.profiles.find((row) => row.id === profileId);
  if (!profile) deny("PROFILE_NOT_FOUND");
  const reference = state.document.credentialSources?.[profile.credentialSource];
  const parsed = parseCredentialReference(reference);
  const epoch = state.records.profileEpochs?.[profileId];
  const fingerprint = profileFingerprint(profile, reference);
  if (
    !epoch ||
    epoch.generation !== profile.generation ||
    epoch.fingerprint !== fingerprint ||
    epoch.revoked
  )
    deny(
      "PROFILE_CHANGED",
      "Profile authority changed. Repeat setup or restart after reviewing the current profile."
    );
  if (profile.mode === "workspace" && rootIdentity(profile.root) !== profile.rootIdentity)
    deny("PROFILE_CHANGED");
  return { profile, reference, sourceClass: parsed.kind, fingerprint, state };
}
export function loadProfileBinding(profileId, options = {}) {
  const current = inspectProfileBinding(profileId, options);
  const credential = resolveCredentialReference(current.reference, {
    ...options,
    workspaceCredential:
      current.profile.mode === "workspace"
        ? options.workspaceCredential &&
          ((key) => options.workspaceCredential(current.profile.root, key))
        : undefined,
  });
  return {
    ...current,
    config: {
      brain_url: current.profile.brainOrigin,
      team_id: current.profile.teamId,
      project_id: current.profile.projectId,
      api_key: credential.value,
      credential_source: credential.sourceClass,
      missing: [],
    },
  };
}
export function authorizeProfileCall(
  binding,
  { requestProfileId = binding.profile.id, capability, readOnly = false, ...options } = {}
) {
  if (requestProfileId !== binding.profile.id) deny("PROFILE_CHANGED");
  const current = inspectProfileBinding(requestProfileId, options);
  if (current.fingerprint !== binding.fingerprint)
    deny(
      "PROFILE_CHANGED",
      "The selected profile changed. Restart the server after reviewing its destination and grants."
    );
  const grants = effectiveGrants(current.profile.grants, readOnly);
  if (capability && !grants[capability])
    deny("CAPABILITY_DENIED", "This operation is not granted for the selected profile.");
  return { ...current, effectiveGrants: grants };
}
export async function validateProfileDestination(profile, credential, fetchImpl = fetch) {
  if (credential.startsWith("aiosd_"))
    deny("AUTH_REVOKED", "Delegated credentials cannot register a member connection profile.");
  try {
    const request = (url) =>
      fetchImpl(url, {
        headers: { Authorization: `Bearer ${credential}` },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    const identityResponse = await request(`${profile.brainOrigin}/api/v1/me`);
    if (!identityResponse.ok) deny("AUTH_REVOKED");
    const identity = await identityResponse.json();
    if (
      !["team", "external"].includes(identity.tier) ||
      !identity.actor ||
      identity.team !== profile.teamId
    )
      deny("AUTH_REVOKED");
    const response = await request(
      `${profile.brainOrigin}/api/v1/projects/${encodeURIComponent(profile.projectId)}`
    );
    if (response.status === 503)
      deny("UNAVAILABLE", "Brain destination verification is temporarily unavailable.");
    if (!response.ok) deny("AUTH_REVOKED", "The selected project could not be verified.");
    const project = await response.json();
    if (project.project_id !== profile.projectId || project.team_id !== profile.teamId)
      deny("AUTH_REVOKED");
    return { actor: identity.actor, team: identity.team, tier: identity.tier };
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    deny("UNAVAILABLE", "Brain destination verification is temporarily unavailable.");
  }
}
export async function inspectProfile(profileId, { readOnly = false, ...options } = {}) {
  const current = inspectProfileBinding(profileId, options);
  let identityVerified = false;
  try {
    const binding = loadProfileBinding(profileId, options);
    await validateProfileDestination(binding.profile, binding.config.api_key, options.fetchImpl);
    identityVerified = true;
  } catch {
    /* Offline configuration inspection never reports cached verification. */
  }
  const p = current.profile;
  return {
    ok: true,
    profileId: p.id,
    mode: p.mode,
    root: p.root,
    brainOrigin: p.brainOrigin,
    teamId: p.teamId,
    projectId: p.projectId,
    credentialSourceClass: current.sourceClass,
    generation: p.generation,
    grants: p.grants,
    effectiveGrants: effectiveGrants(p.grants, readOnly),
    readOnly,
    identityVerified,
  };
}
