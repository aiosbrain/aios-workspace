import path from "node:path";
import { createHash } from "node:crypto";

export const PROFILE_VERSION = "1.0.0";
export const GRANTS = Object.freeze([
  "brainActions",
  "workspaceRead",
  "workspaceDraft",
  "workspacePublish",
]);
export const emptyGrants = () => Object.fromEntries(GRANTS.map((key) => [key, false]));
export const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export class ProfileError extends Error {
  constructor(
    code,
    message = "Connection profile is unavailable; inspect the profile and repeat explicit setup."
  ) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
  }
}
export function deny(code, message) {
  throw new ProfileError(code, message);
}
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
export function validReference(value) {
  return (
    typeof value === "string" &&
    /^(env:[A-Za-z_][A-Za-z0-9_]*|keychain:[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255})$/.test(value)
  );
}
export function profileOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      value !== url.origin
    )
      throw new Error();
    return url.origin;
  } catch {
    deny(
      "INVALID_PROFILE",
      "The profile requires a canonical HTTPS Brain origin without path or credentials."
    );
  }
}
function roots(value) {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    new Set(value).size === value.length &&
    value.every(
      (v) =>
        typeof v === "string" &&
        v.length <= 1024 &&
        !v.includes("\0") &&
        /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[\\:])(?!.*\/\/)(?!.*\/$).+$/.test(v)
    )
  );
}
export function validateProfile(profile) {
  const keys = [
    "id",
    "mode",
    "generation",
    "brainOrigin",
    "teamId",
    "projectId",
    "credentialSource",
    "root",
    "rootIdentity",
    "grants",
    "readRoots",
    "draftRoots",
  ];
  if (
    !exact(profile, keys) ||
    !PROFILE_ID.test(profile.id) ||
    !PROFILE_ID.test(profile.credentialSource) ||
    !["brain-only", "workspace"].includes(profile.mode) ||
    !Number.isInteger(profile.generation) ||
    profile.generation < 1 ||
    profile.generation > 2147483647 ||
    !["teamId", "projectId"].every(
      (key) =>
        typeof profile[key] === "string" && profile[key].length > 0 && profile[key].length <= 256
    ) ||
    !exact(profile.grants, GRANTS) ||
    !GRANTS.every((key) => typeof profile.grants[key] === "boolean") ||
    !roots(profile.readRoots) ||
    !roots(profile.draftRoots)
  )
    deny("INVALID_PROFILE");
  profileOrigin(profile.brainOrigin);
  if (profile.mode === "brain-only") {
    if (
      profile.root !== null ||
      profile.rootIdentity !== null ||
      profile.readRoots.length ||
      profile.draftRoots.length ||
      GRANTS.slice(1).some((key) => profile.grants[key])
    )
      deny("INVALID_PROFILE");
  } else if (
    typeof profile.root !== "string" ||
    profile.root.length > 4096 ||
    profile.root.includes("\0") ||
    !(
      path.posix.isAbsolute(profile.root) ||
      /^[A-Za-z]:\\/.test(profile.root) ||
      /^\\\\[^\\]+\\[^\\]+/.test(profile.root)
    ) ||
    typeof profile.rootIdentity !== "string" ||
    !profile.rootIdentity.length ||
    profile.rootIdentity.length > 256
  )
    deny("INVALID_PROFILE");
  return profile;
}
export function validateProfiles(extension) {
  if (
    !exact(extension, ["version", "profiles"]) ||
    extension.version !== PROFILE_VERSION ||
    !Array.isArray(extension.profiles) ||
    extension.profiles.length > 64
  )
    deny("INVALID_PROFILE");
  extension.profiles.forEach(validateProfile);
  if (new Set(extension.profiles.map((p) => p.id)).size !== extension.profiles.length)
    deny("INVALID_PROFILE");
  return extension;
}
export function effectiveGrants(grants, readOnly = false) {
  return Object.fromEntries(
    GRANTS.map((key) => [key, !!grants[key] && (!readOnly || key === "workspaceRead")])
  );
}
export function nextGeneration(generation) {
  if (!Number.isInteger(generation) || generation < 0 || generation >= 2147483647)
    deny(
      "PROFILE_CHANGED",
      "Profile generation is exhausted; create a different explicit profile."
    );
  return generation + 1;
}
export function profileFingerprint(profile, reference) {
  const stable = {
    ...profile,
    grants: Object.fromEntries(GRANTS.map((key) => [key, profile.grants[key]])),
    reference,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
export function prepareProfileMigration(document, requestedProfiles = []) {
  if (document.schemaVersion !== 2) deny("INVALID_PROFILE");
  const existing = document.connectionProfiles
    ? validateProfiles(document.connectionProfiles).profiles
    : [];
  const profiles = existing.map((profile) => structuredClone(profile));
  for (const requested of requestedProfiles) {
    validateProfile(requested);
    const prior = existing.find((profile) => profile.id === requested.id);
    if (prior) {
      if (profileFingerprint(prior, "") !== profileFingerprint(requested, ""))
        deny(
          "CAPABILITY_DENIED",
          "Migration cannot change an existing profile. Use explicit profile setup."
        );
    } else {
      if (GRANTS.some((key) => requested.grants[key]))
        deny("CAPABILITY_DENIED", "Migration cannot enable grants. Use explicit profile setup.");
      profiles.push(structuredClone(requested));
    }
  }
  const next = {
    ...document,
    connectionProfiles: validateProfiles({ version: PROFILE_VERSION, profiles }),
  };
  return { document: next, changed: JSON.stringify(document) !== JSON.stringify(next) };
}
