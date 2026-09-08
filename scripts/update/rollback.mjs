import path from "node:path";
import { readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { c, UpdateError, gitEnv } from "../cli-common.mjs";
import { atomicWrite, resolveUserConfigPath, resolveDistributionRoot } from "../cli.mjs";
import { VERSION_FILE } from "../toolkit-manifest.mjs";
import { readStamp } from "./stamp.mjs";
import { assertDestPathSafe } from "./manifest-walk.mjs";
import { npmInstallation, npmReinstallArgs } from "./npm-installation.mjs";
import { withUpdateLock } from "./lock.mjs";
import { ensureBaseStoreTracked } from "./base-store-tracking.mjs";

export const ROLLBACK_FILE = ".aios/rollback.json";
const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const quote = (arg) => `'${String(arg).replaceAll("'", "'\\''")}'`;
const display = (argv) => argv.map(quote).join(" ");
const field = (body, key) => body?.match(new RegExp(`^${key} (.+)$`, "m"))?.[1] ?? null;

function parseRecord(repo) {
  assertDestPathSafe(repo, ROLLBACK_FILE, "read rollback record");
  const text = read(path.join(repo, ROLLBACK_FILE));
  if (text === null)
    throw new UpdateError(
      `no rollback record at ${ROLLBACK_FILE} — nothing recorded a prior package for this workspace.`
    );
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new UpdateError(
      "Invalid rollback record; recover the exact prior state from your workspace history."
    );
  }
  const cfg = resolveUserConfigPath({});
  if (
    record.schemaVersion !== 1 ||
    record.stampPath !== VERSION_FILE ||
    !(record.stampSnapshot === null || typeof record.stampSnapshot === "string") ||
    !(record.configSnapshot === null || typeof record.configSnapshot === "string") ||
    (record.configPath !== null && record.configPath !== cfg)
  ) {
    throw new UpdateError(
      "Rollback record has invalid state paths or snapshot types; refusing to restore it."
    );
  }
  const sha = record.stampSnapshot?.split("\n")[0];
  const version = field(record.stampSnapshot, "toolkit-version");
  const source = field(record.stampSnapshot, "source");
  if (
    record.stampSnapshot !== null &&
    ((record.installType === "checkout" && !/^[0-9a-f]{40}$/.test(sha ?? "")) ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version ?? ""))
  ) {
    throw new UpdateError(
      "Rollback snapshot does not identify an exact prior package version (and commit for a checkout)."
    );
  }
  const expected =
    record.installType === "checkout"
      ? `checkout:${sha}`
      : record.stampSnapshot
        ? `@aiosbrain/aios@${version}`
        : null;
  if (record.previousPackage !== expected)
    throw new UpdateError("Rollback package identity disagrees with its stamp snapshot.");
  return { record, sha, version, source };
}

function reinstallCommand({ record, sha, version, source }) {
  if (!record.stampSnapshot) return null;
  if (record.installType === "checkout") {
    if (!source || !path.isAbsolute(source) || resolveDistributionRoot(source)?.kind !== "checkout")
      return null;
    return ["git", "-C", source, "checkout", sha];
  }
  const stored = record.installation;
  if (!stored || !source || !path.isAbsolute(source)) return null;
  try {
    if (stored.root !== realpathSync(source)) return null;
  } catch {
    return null;
  }
  const actual = npmInstallation(stored.root);
  if (!actual || actual.method !== stored.method || actual.prefix !== stored.prefix) return null;
  return ["npm", ...npmReinstallArgs(actual, version)];
}

/** Capture once before workspace mutation; retries preserve the original recovery record. */
export async function recordRollbackIfUpgrading(repo) {
  const stamp = readStamp(repo);
  if (stamp?.format >= 2) return null;
  assertDestPathSafe(repo, ROLLBACK_FILE, "record rollback state");
  const recordPath = path.join(repo, ROLLBACK_FILE);
  if (existsSync(recordPath)) {
    const { record } = parseRecord(repo);
    if (record.stampSnapshot !== (stamp?.raw ?? null))
      throw new UpdateError(
        "An earlier rollback record belongs to another workspace state; recover it before starting a new migration."
      );
    return record;
  }
  // Recovery can contain user credentials; establish private-state ignore rules even if apply later conflicts.
  await ensureBaseStoreTracked(repo);
  const source = stamp?.source;
  const checkout =
    source && path.isAbsolute(source) && resolveDistributionRoot(source)?.kind === "checkout";
  const configPath = resolveUserConfigPath({});
  const record = {
    schemaVersion: 1,
    previousPackage: stamp
      ? checkout
        ? `checkout:${stamp.baseSha}`
        : `@aiosbrain/aios@${stamp.toolkitVersion}`
      : null,
    integrity: "unverified",
    installType: checkout ? "checkout" : "registry",
    installation: checkout ? null : npmInstallation(source),
    stampPath: VERSION_FILE,
    stampSnapshot: stamp?.raw ?? null,
    configPath,
    configSnapshot: read(configPath),
    recordedAt: new Date().toISOString(),
  };
  await atomicWrite(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Restore only fixed, validated destinations; executable commands are derived, never trusted JSON. */
export async function rollbackFromRecord(repo, { interactive = process.stdin.isTTY } = {}) {
  return withUpdateLock(repo, async () => {
    const parsed = parseRecord(repo);
    const { record } = parsed;
    assertDestPathSafe(repo, VERSION_FILE, "restore version stamp");
    for (const suffix of [".migration.json", ".last-known-good", ".staged"])
      assertDestPathSafe(repo, `${VERSION_FILE}${suffix}`, "clear completed rollback journal");
    if (record.configPath && read(record.configPath) !== record.configSnapshot) {
      throw new UpdateError(
        "User configuration changed after the migration snapshot. Preserve and reconcile those changes before rollback; no snapshots were restored."
      );
    }
    const beforeStamp = read(path.join(repo, VERSION_FILE));
    const command = reinstallCommand(parsed);
    if (command) console.log(`  reinstall the prior package with:\n    ${display(command)}`);
    else if (record.previousPackage)
      console.log(
        `  restore ${record.previousPackage} at its recorded source manually; no installation target could be verified.`
      );
    if (interactive && command) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      let answer;
      try {
        answer = (await rl.question("  run this exact command now? [y/N] ")).trim().toLowerCase();
      } finally {
        rl.close();
      }
      if (["y", "yes"].includes(answer)) {
        const [cmd, ...args] = command;
        const res = spawnSync(cmd, args, { stdio: "inherit", env: gitEnv() });
        if ((res.status ?? 1) !== 0)
          throw new UpdateError(
            "Prior-package reinstall failed; snapshots were not restored. Run the displayed command successfully before retrying."
          );
      }
    }
    if (
      read(path.join(repo, VERSION_FILE)) !== beforeStamp ||
      (record.configPath && read(record.configPath) !== record.configSnapshot)
    ) {
      throw new UpdateError(
        "Workspace or user configuration changed while rollback was awaiting confirmation; snapshots were not restored."
      );
    }
    if (record.stampSnapshot === null) rmSync(path.join(repo, VERSION_FILE), { force: true });
    else await atomicWrite(path.join(repo, VERSION_FILE), record.stampSnapshot);
    if (record.configPath && record.configSnapshot !== null)
      await atomicWrite(record.configPath, record.configSnapshot);
    for (const suffix of [".migration.json", ".last-known-good", ".staged"])
      rmSync(path.join(repo, `${VERSION_FILE}${suffix}`), { force: true });
    console.log(c.green("  restored the pre-upgrade stamp/config snapshots."));
    return { previousPackage: record.previousPackage };
  });
}
