#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLE_SCHEMA_VERSION = 1;
export const PAYLOAD_FILES = Object.freeze([
  "coverage-baseline-candidate.json",
  "coverage-summary.json",
  "lcov.info",
]);
function compareStrings(left, right) {
  return left.localeCompare(right, "en");
}

const BUNDLE_FILES = Object.freeze([...PAYLOAD_FILES, "manifest.json"].sort(compareStrings));
const IDENTITY_KEYS = Object.freeze(["repository", "runId", "sha"]);

function fail(message) {
  throw new Error(`coverage-bundle: ${message}`);
}

function sortedKeys(value) {
  return Object.keys(value).sort(compareStrings);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = sortedKeys(value);
  const wanted = [...expected].sort(compareStrings);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function validateIdentity(identity, label = "identity") {
  assertExactKeys(identity, IDENTITY_KEYS, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository)) {
    fail(`${label}.repository must use owner/repository syntax`);
  }
  if (!/^[0-9a-f]{40}$/.test(identity.sha)) {
    fail(`${label}.sha must be a lowercase 40-character hexadecimal commit SHA`);
  }
  if (!/^[1-9]\d*$/.test(identity.runId)) {
    fail(`${label}.runId must be a positive decimal string`);
  }
  return identity;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRegularFile(file, label) {
  let descriptor;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) fail(`${label} must be a regular file`);
    return readFileSync(descriptor);
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${label} must not be a symlink`);
    if (error?.code === "ENOENT") fail(`${label} is missing`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function inspectDirectory(directory, expectedEntries, label) {
  let root;
  try {
    root = lstatSync(directory);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} is missing: ${directory}`);
    throw error;
  }
  if (root.isSymbolicLink()) fail(`${label} must not be a symlink`);
  if (!root.isDirectory()) fail(`${label} must be a directory`);

  const entries = readdirSync(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort(compareStrings);
  const wanted = [...expectedEntries].sort(compareStrings);
  if (names.length !== wanted.length || names.some((name, index) => name !== wanted[index])) {
    const missing = wanted.filter((name) => !names.includes(name));
    const unexpected = names.filter((name) => !wanted.includes(name));
    fail(
      `${label} has an invalid file set` +
        (missing.length ? `; missing: ${missing.join(", ")}` : "") +
        (unexpected.length ? `; unexpected: ${unexpected.join(", ")}` : "")
    );
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail(`${label}/${entry.name} must not be a symlink`);
    if (!entry.isFile()) fail(`${label}/${entry.name} must be a regular file`);
  }
}

function parseJsonPayload(bytes, name) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${name} must contain valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must contain a JSON object`);
  }
  if (name === "coverage-summary.json" && (!value.total || typeof value.total !== "object")) {
    fail(`${name} must contain a total object`);
  }
  if (
    name === "coverage-baseline-candidate.json" &&
    (!value.minimum || typeof value.minimum !== "object")
  ) {
    fail(`${name} must contain a minimum object`);
  }
}

function validatePayload(name, bytes) {
  if (bytes.length === 0) fail(`${name} must not be empty`);
  if (name.endsWith(".json")) parseJsonPayload(bytes, name);
  if (name === "lcov.info" && (!/^SF:.+/m.test(bytes) || !/^end_of_record$/m.test(bytes))) {
    fail("lcov.info must contain at least one complete LCOV record");
  }
}

function validateManifest(bytes, expectedIdentity) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("manifest.json must contain valid JSON");
  }
  assertExactKeys(manifest, ["files", "repository", "runId", "schemaVersion", "sha"], "manifest");
  if (manifest.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    fail(`manifest.schemaVersion must equal ${BUNDLE_SCHEMA_VERSION}`);
  }
  validateIdentity(
    { repository: manifest.repository, sha: manifest.sha, runId: manifest.runId },
    "manifest identity"
  );
  for (const key of IDENTITY_KEYS) {
    if (manifest[key] !== expectedIdentity[key]) {
      fail(`manifest ${key} does not match the requested identity`);
    }
  }
  assertExactKeys(manifest.files, PAYLOAD_FILES, "manifest.files");
  for (const name of PAYLOAD_FILES) {
    const metadata = manifest.files[name];
    assertExactKeys(metadata, ["bytes", "sha256"], `manifest.files.${name}`);
    if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1) {
      fail(`manifest.files.${name}.bytes must be a positive safe integer`);
    }
    if (!/^[0-9a-f]{64}$/.test(metadata.sha256)) {
      fail(`manifest.files.${name}.sha256 must be a lowercase SHA-256 digest`);
    }
  }
  return manifest;
}

function ensureAbsent(target, label) {
  try {
    lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`${label} already exists: ${target}`);
}

function ensureParentDirectory(target, label) {
  const parent = path.dirname(path.resolve(target));
  const status = lstatSync(parent);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    fail(`${label} parent must be an existing non-symlinked directory`);
  }
  return parent;
}

function readSourcePayloads(source) {
  const root = lstatSync(source);
  if (root.isSymbolicLink()) fail("source must not be a symlink");
  if (!root.isDirectory()) fail("source must be a directory");
  return Object.fromEntries(
    PAYLOAD_FILES.map((name) => {
      const bytes = readRegularFile(path.join(source, name), `source/${name}`);
      validatePayload(name, bytes);
      return [name, bytes];
    })
  );
}

export function validateBundle(bundle, expectedIdentity) {
  validateIdentity(expectedIdentity, "requested identity");
  inspectDirectory(bundle, BUNDLE_FILES, "bundle");
  const manifestBytes = readRegularFile(path.join(bundle, "manifest.json"), "bundle/manifest.json");
  const manifest = validateManifest(manifestBytes, expectedIdentity);
  const payloads = {};
  for (const name of PAYLOAD_FILES) {
    const bytes = readRegularFile(path.join(bundle, name), `bundle/${name}`);
    validatePayload(name, bytes);
    const metadata = manifest.files[name];
    if (bytes.length !== metadata.bytes) fail(`${name} byte length does not match manifest`);
    if (sha256(bytes) !== metadata.sha256) fail(`${name} digest does not match manifest`);
    payloads[name] = bytes;
  }
  return { manifest, manifestBytes, payloads };
}

export function packBundle({ source, out, repository, sha, runId }) {
  const identity = validateIdentity({ repository, sha, runId }, "requested identity");
  ensureAbsent(out, "bundle output");
  const parent = ensureParentDirectory(out, "bundle output");
  const payloads = readSourcePayloads(source);
  const manifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    ...identity,
    files: Object.fromEntries(
      PAYLOAD_FILES.map((name) => [
        name,
        { bytes: payloads[name].length, sha256: sha256(payloads[name]) },
      ])
    ),
  };
  const staging = mkdtempSync(path.join(parent, `.${path.basename(out)}.pack-`));
  try {
    for (const name of PAYLOAD_FILES) writeFileSync(path.join(staging, name), payloads[name]);
    writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    validateBundle(staging, identity);
    renameSync(staging, out);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

export function installBundle(
  { bundle, dest, repository, sha, runId },
  { afterStage = () => {} } = {}
) {
  const identity = validateIdentity({ repository, sha, runId }, "requested identity");
  ensureAbsent(dest, "scanner destination");
  const parent = ensureParentDirectory(dest, "scanner destination");
  const validated = validateBundle(bundle, identity);
  const staging = mkdtempSync(path.join(parent, `.${path.basename(dest)}.install-`));
  try {
    for (const name of PAYLOAD_FILES) {
      writeFileSync(path.join(staging, name), validated.payloads[name]);
    }
    writeFileSync(path.join(staging, "manifest.json"), validated.manifestBytes);
    validateBundle(staging, identity);
    afterStage(staging);
    renameSync(staging, dest);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return validated.manifest;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!new Set(["pack", "install"]).has(command)) {
    fail("usage: coverage-bundle.mjs <pack|install> [options]");
  }
  const allowed =
    command === "pack"
      ? new Set(["source", "out", "repository", "sha", "run-id"])
      : new Set(["bundle", "dest", "repository", "sha", "run-id"]);
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      fail(`option ${flag ?? "(missing)"} requires a value`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) fail(`unexpected option: ${flag}`);
    if (name in values) fail(`duplicate option: ${flag}`);
    values[name] = value;
  }
  for (const name of allowed) if (!(name in values)) fail(`missing required option: --${name}`);
  return { command, values };
}

function main(argv) {
  const { command, values } = parseArgs(argv);
  const identity = {
    repository: values.repository,
    sha: values.sha,
    runId: values["run-id"],
  };
  if (command === "pack") {
    packBundle({ source: values.source, out: values.out, ...identity });
    console.log(
      `coverage-bundle: packed ${identity.repository}@${identity.sha} run ${identity.runId}`
    );
  } else {
    installBundle({ bundle: values.bundle, dest: values.dest, ...identity });
    console.log(
      `coverage-bundle: installed ${identity.repository}@${identity.sha} run ${identity.runId}`
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
