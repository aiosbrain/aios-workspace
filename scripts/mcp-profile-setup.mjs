import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { filePolicy, commitHostFiles } from "./mcp-host-files.mjs";
import { parseUserConfig } from "./user-config-reader.mjs";
import {
  PROFILE_ID,
  PROFILE_VERSION,
  GRANTS,
  emptyGrants,
  nextGeneration,
  validateProfile,
  profileFingerprint,
  prepareProfileMigration,
  validReference,
  deny,
} from "./mcp-profile-schema.mjs";
import { resolveCredentialReference } from "./mcp-profile-reference.mjs";
import {
  profilePaths,
  readProfileState,
  rootIdentity,
  validateProfileDestination,
} from "./mcp-profile-binding.mjs";
const serialized = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function locked(options, task) {
  const paths = profilePaths(options),
    policy = options.policy || filePolicy(options);
  policy.snapshot(paths.lock, { privateFile: true });
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(
      paths.lock,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600
    );
  } catch {
    deny("PROFILE_CHANGED", "Profile setup is already active or needs explicit recovery.");
  }
  const identity = fs.fstatSync(fd);
  try {
    policy.secure(paths.lock);
    fs.writeFileSync(fd, serialized({ pid: process.pid, id: randomUUID() }));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return await task({ ...options, allowLocked: true, policy });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    const current = fs.lstatSync(paths.lock);
    if (current.ino === identity.ino && current.dev === identity.dev) fs.unlinkSync(paths.lock);
  }
}
async function writeRecord(paths, records, options, expected) {
  const source = options.policy.snapshot(paths.records, { privateFile: true });
  if (
    expected &&
    JSON.stringify(source.bytes ? JSON.parse(source.bytes) : { version: 1, installations: [] }) !==
      JSON.stringify(expected)
  )
    deny("PROFILE_CHANGED", "Installation records changed concurrently; retry.");
  return commitHostFiles([{ source, bytes: serialized(records) }], { policy: options.policy });
}
async function commitState(state, document, { revokedIds = [], ...options }) {
  parseUserConfig(JSON.stringify(document));
  const source = options.policy.snapshot(state.paths.config, { privateFile: true });
  if (
    JSON.stringify(
      source.bytes ? parseUserConfig(source.bytes.toString()).document : { schemaVersion: 2 }
    ) !== JSON.stringify(state.document)
  )
    deny("PROFILE_CHANGED", "Profile configuration changed concurrently; retry.");
  const epoch = { ...(state.records.profileEpochs || {}) };
  for (const profile of document.connectionProfiles.profiles) {
    epoch[profile.id] = {
      generation: profile.generation,
      fingerprint: profileFingerprint(
        profile,
        document.credentialSources?.[profile.credentialSource]
      ),
      revoked:
        revokedIds.includes(profile.id) ||
        state.records.profileEpochs?.[profile.id]?.revoked === true,
    };
    if (options.reactivateId === profile.id) epoch[profile.id].revoked = false;
  }
  const transaction = {
    id: randomUUID(),
    previous: state.document,
    proposed: document,
    epochs: epoch,
  };
  const reserved = { ...state.records, profileEpochs: epoch, profileTransaction: transaction };
  // Reservations are durable and are deliberately outside the rollback transaction.
  await writeRecord(state.paths, reserved, options, state.records);
  await options.failpoint?.("reserved");
  const recordSource = options.policy.snapshot(state.paths.records, { privateFile: true });
  const finalRecords = { ...reserved };
  delete finalRecords.profileTransaction;
  await commitHostFiles(
    [
      { source, bytes: serialized(document) },
      { source: recordSource, bytes: serialized(finalRecords) },
    ],
    {
      policy: options.policy,
      afterReplace: async (file) => {
        if (file === state.paths.config) await options.failpoint?.("config-written");
      },
    }
  );
  return {
    changed: true,
    profiles: document.connectionProfiles.profiles.map((p) => ({
      id: p.id,
      generation: p.generation,
    })),
  };
}
function profileProposal(input, state) {
  if (!PROFILE_ID.test(input.id) || !PROFILE_ID.test(input.credentialSource))
    deny("INVALID_PROFILE");
  const prior = state.profiles.find((row) => row.id === input.id);
  const sources = { ...(state.document.credentialSources || {}) };
  const reference = input.reference ?? sources[input.credentialSource];
  if (!validReference(reference)) deny("PROFILE_NOT_FOUND");
  sources[input.credentialSource] = reference;
  const root = input.mode === "workspace" ? fs.realpathSync(input.root) : null;
  const grants = { ...emptyGrants(), ...(input.grants || {}) };
  const profile = validateProfile({
    id: input.id,
    mode: input.mode,
    generation: prior?.generation || 1,
    brainOrigin: input.brainOrigin,
    teamId: input.teamId,
    projectId: input.projectId,
    credentialSource: input.credentialSource,
    root,
    rootIdentity: root ? rootIdentity(root) : null,
    grants,
    readRoots: input.readRoots || [],
    draftRoots: input.draftRoots || [],
  });
  const oldFingerprint =
    prior && profileFingerprint(prior, state.document.credentialSources?.[prior.credentialSource]);
  if (
    prior &&
    (oldFingerprint !== profileFingerprint(profile, reference) ||
      state.records.profileEpochs?.[prior.id]?.revoked)
  )
    profile.generation = nextGeneration(
      Math.max(prior.generation, state.records.profileEpochs?.[prior.id]?.generation || 0)
    );
  const profiles = state.profiles
    .filter((row) => row.id !== profile.id)
    .map((row) => {
      if (
        row.credentialSource === profile.credentialSource &&
        state.document.credentialSources?.[row.credentialSource] !== reference
      )
        return {
          ...row,
          generation: nextGeneration(
            Math.max(row.generation, state.records.profileEpochs?.[row.id]?.generation || 0)
          ),
        };
      return row;
    });
  const priorIndex = state.profiles.findIndex((row) => row.id === profile.id);
  if (priorIndex >= 0) profiles.splice(priorIndex, 0, profile);
  else profiles.push(profile);
  return {
    profile,
    reference,
    document: {
      ...state.document,
      credentialSources: sources,
      connectionProfiles: { version: PROFILE_VERSION, profiles },
    },
  };
}
export async function registerProfile(input, options = {}) {
  const prepare = async (opts) => {
    const state = readProfileState(opts);
    if (state.records.profileTransaction)
      deny("PROFILE_CHANGED", "Recover the interrupted profile transaction first.");
    const proposal = profileProposal(input, state);
    const selected = resolveCredentialReference(proposal.reference, {
      ...opts,
      workspaceCredential:
        proposal.profile.root && opts.workspaceCredential
          ? (key) => opts.workspaceCredential(proposal.profile.root, key)
          : undefined,
    });
    await validateProfileDestination(proposal.profile, selected.value, opts.fetchImpl);
    if (
      JSON.stringify(state.document) === JSON.stringify(proposal.document) &&
      state.records.profileEpochs?.[input.id]
    )
      return { changed: false, profileId: input.id, generation: proposal.profile.generation };
    if (opts.dryRun)
      return {
        dry_run: true,
        profile: proposal.profile,
        credentialSourceClass: selected.sourceClass,
      };
    return commitState(state, proposal.document, { ...opts, reactivateId: input.id });
  };
  return options.dryRun ? prepare(options) : locked(options, prepare);
}
export async function migrateProfiles(options = {}) {
  const apply = async (opts) => {
    const state = readProfileState(opts);
    if (state.records.profileTransaction) deny("PROFILE_CHANGED");
    const next = prepareProfileMigration(state.document);
    if (!next.changed) return { changed: false };
    if (opts.dryRun) return { dry_run: true, changed: true };
    return commitState(state, next.document, opts);
  };
  return options.dryRun ? apply(options) : locked(options, apply);
}
export async function revokeProfile(profileId, grants = GRANTS, options = {}) {
  if (!Array.isArray(grants) || !grants.length || grants.some((key) => !GRANTS.includes(key)))
    deny("INVALID_PROFILE");
  const apply = async (opts) => {
    const state = readProfileState(opts);
    if (state.records.profileTransaction) deny("PROFILE_CHANGED");
    const prior = state.profiles.find((row) => row.id === profileId);
    if (!prior) deny("PROFILE_NOT_FOUND");
    const next = {
      ...prior,
      grants: { ...prior.grants },
      generation: nextGeneration(
        Math.max(prior.generation, state.records.profileEpochs?.[profileId]?.generation || 0)
      ),
    };
    for (const key of grants) next.grants[key] = false;
    const document = {
      ...state.document,
      connectionProfiles: {
        version: PROFILE_VERSION,
        profiles: state.profiles.map((p) => (p.id === profileId ? next : p)),
      },
    };
    if (opts.dryRun) return { dry_run: true, profile: next };
    return commitState(state, document, {
      ...opts,
      revokedIds: grants.length === GRANTS.length ? [profileId] : [],
    });
  };
  return options.dryRun ? apply(options) : locked(options, apply);
}
export async function recoverProfiles(options = {}) {
  const paths = profilePaths(options),
    policy = options.policy || filePolicy(options);
  const lock = policy.snapshot(paths.lock, { privateFile: true });
  if (lock.bytes) {
    let owner;
    try {
      owner = JSON.parse(lock.bytes).pid;
      if (!Number.isInteger(owner) || owner <= 0) throw new Error();
    } catch {
      deny("PROFILE_CHANGED");
    }
    try {
      process.kill(owner, 0);
      deny("PROFILE_CHANGED", "The profile transaction owner is still running.");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    policy.recheck(lock);
    fs.unlinkSync(paths.lock);
  }
  return locked({ ...options, policy }, async (opts) => {
    const state = readProfileState(opts),
      transaction = state.records.profileTransaction;
    if (!transaction) return { changed: false };
    const previous = transaction.previous;
    parseUserConfig(JSON.stringify(previous));
    const byId = new Map((previous.connectionProfiles?.profiles || []).map((p) => [p.id, p]));
    // Retain all reserved IDs so a failed creation cannot reuse its epoch.
    for (const p of transaction.proposed.connectionProfiles.profiles)
      if (!byId.has(p.id)) byId.set(p.id, p);
    const profiles = [...byId.values()].map((p) => ({
      ...p,
      grants: emptyGrants(),
      generation: nextGeneration(
        Math.max(p.generation, state.records.profileEpochs?.[p.id]?.generation || 0)
      ),
    }));
    const document = {
      ...previous,
      credentialSources: {
        ...(transaction.proposed.credentialSources || {}),
        ...(previous.credentialSources || {}),
      },
      connectionProfiles: { version: PROFILE_VERSION, profiles },
    };
    return commitState(state, document, { ...opts, revokedIds: profiles.map((p) => p.id) });
  });
}
