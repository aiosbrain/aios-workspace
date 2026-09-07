import { withUpdateLock } from "./lock.mjs";
import path from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { UpdateError } from "../cli-common.mjs";
import { atomicWrite, runMigration } from "../cli.mjs";
import { VERSION_FILE } from "../toolkit-manifest.mjs";
import { entryFiles, assertDestPathSafe } from "./manifest-walk.mjs";
import { readStamp, stampBody } from "./stamp.mjs";
import {
  writeBaseStore,
  manifestDigest,
  verifiedBaseIndex,
  sha256hex,
  BASE_STORE_DIR,
} from "./base-store.mjs";
import { ensureBaseStoreTracked } from "./base-store-tracking.mjs";

const identity = (body) => String(body).replace(/^synced-at .+\n?/m, "");
const readOptional = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

/** Read-only transition planning: all destination and resume failures precede managed writes. */
export function prepareV2State(repo, options) {
  const { srcDir, sha, meta, stampSource, managedPaths, packageVersion, packageIntegrity } =
    options;
  const stampPath = path.join(repo, VERSION_FILE);
  const journalPath = `${stampPath}.migration.json`;
  const snapshotPath = `${stampPath}.last-known-good`;
  const stagedPath = `${stampPath}.staged`;
  for (const rel of [
    ".gitignore",
    BASE_STORE_DIR,
    `${BASE_STORE_DIR}/index.json`,
    VERSION_FILE,
    `${VERSION_FILE}.migration.json`,
    `${VERSION_FILE}.last-known-good`,
    `${VERSION_FILE}.staged`,
  ]) {
    assertDestPathSafe(
      repo,
      rel,
      "prepare versioned update state (materialize symlinked files first)"
    );
  }
  const byDestination = new Map();
  for (const entry of managedPaths) {
    if (!existsSync(path.join(srcDir, entry.src))) continue;
    for (const f of entryFiles(srcDir, entry)) {
      const prior = byDestination.get(f.destRel);
      if (prior && prior.srcRel !== f.srcRel)
        throw new UpdateError(
          `Ambiguous managed destination ${f.destRel}: ${prior.srcRel} and ${f.srcRel}`
        );
      byDestination.set(f.destRel, {
        destRel: f.destRel,
        srcRel: f.srcRel,
        content: readFileSync(path.join(srcDir, f.srcRel), "utf8"),
      });
    }
  }
  const files = [...byDestination.values()];
  const digest = manifestDigest(files);
  for (const f of files)
    assertDestPathSafe(repo, `${BASE_STORE_DIR}/${sha256hex(f.content)}`, "prepare merge bases");
  assertDestPathSafe(repo, `${BASE_STORE_DIR}/${digest.slice(7)}.json`, "prepare base generation");
  const before = readOptional(stampPath);
  let body = stampBody(sha, meta, stampSource, {
    packageName: "@aiosbrain/aios",
    packageVersion: packageVersion ?? meta.version,
    packageIntegrity: packageIntegrity ?? "unverified",
    manifestDigest: digest,
  });
  if (before && identity(before) === identity(body)) body = before;
  const journalText = readOptional(journalPath);
  let completedJournal = false;
  if (journalText) {
    let journal;
    try {
      journal = JSON.parse(journalText);
    } catch {
      throw new UpdateError(
        "Invalid migration journal; preserve its snapshot and recover before updating."
      );
    }
    if (
      journal.configPath !== stampPath ||
      journal.snapshotPath !== snapshotPath ||
      journal.stagedPath !== stagedPath ||
      !["discovered", "snapshotted", "staged", "validated", "committed"].includes(journal.state)
    ) {
      throw new UpdateError(
        "Migration journal belongs to another transition; preserve recovery evidence and restore the committed state."
      );
    }
    if (journal.state === "committed") {
      if (sha256hex(before ?? "") !== journal.committedSha256)
        throw new UpdateError(
          "Live stamp changed after the committed migration; refusing to discard recovery evidence."
        );
      verifiedBaseIndex(repo, readStamp(repo));
      completedJournal = true;
    } else {
      const staged = readOptional(stagedPath);
      if (staged !== null) {
        const interruptedStaging =
          journal.state === "snapshotted" && journal.stagedSha256 === undefined;
        if (
          (!interruptedStaging && sha256hex(staged) !== journal.stagedSha256) ||
          identity(staged) !== identity(body)
        )
          throw new UpdateError(
            "Pending migration targets a different toolkit state. Re-run its original toolkit or use update --rollback; recovery evidence was preserved."
          );
        body = staged;
      } else if (journal.state === "staged" || journal.state === "validated") {
        throw new UpdateError(
          "Pending migration lost its staged stamp; restore its snapshot before updating."
        );
      }
      if (
        journal.sourceSha256 !== sha256hex(before ?? "") &&
        journal.stagedSha256 !== sha256hex(before ?? "")
      )
        throw new UpdateError(
          "Live stamp changed after migration snapshot; refusing to overwrite it or discard recovery evidence."
        );
    }
  }
  return {
    repo,
    options,
    files,
    digest,
    body,
    before,
    journalText,
    completedJournal,
    stampPath,
    journalPath,
    snapshotPath,
    stagedPath,
  };
}

/** Publish immutable bases first and the stamp last; never discard a failed transition. */
export async function commitV2State(plan) {
  const {
    repo,
    options,
    files,
    digest,
    body,
    before,
    stampPath,
    journalPath,
    snapshotPath,
    stagedPath,
  } = plan;
  if (readOptional(stampPath) !== before || readOptional(journalPath) !== plan.journalText)
    throw new UpdateError(
      "Update state changed after preflight; refusing to overwrite it. Re-run after the other update finishes."
    );
  await ensureBaseStoreTracked(repo);
  const previous = readStamp(repo);
  if (previous?.format >= 2) {
    const index = verifiedBaseIndex(repo, previous);
    const generation = path.join(repo, BASE_STORE_DIR, `${previous.manifestDigest.slice(7)}.json`);
    assertDestPathSafe(repo, path.relative(repo, generation), "retain the prior base generation");
    if (!existsSync(generation))
      await atomicWrite(generation, `${JSON.stringify(index, null, 2)}\n`);
  }
  if (plan.completedJournal)
    for (const file of [journalPath, snapshotPath, stagedPath]) rmSync(file, { force: true });
  await writeBaseStore(repo, files, {
    packageVersion: options.packageVersion ?? options.meta.version,
    prune: false,
  });
  if (before === null) {
    await atomicWrite(stampPath, body);
  } else {
    await runMigration({
      configPath: stampPath,
      journalPath,
      snapshotPath,
      stagedPath,
      packageRecord: {
        name: "@aiosbrain/aios",
        version: options.packageVersion ?? options.meta.version,
      },
      stage: () => body,
      validate: (staged) => {
        if (String(staged) !== body)
          throw new UpdateError(
            "Staged stamp differs from the prepared transition; recovery evidence was preserved."
          );
      },
    });
  }
  if (readFileSync(stampPath, "utf8") !== body)
    throw new UpdateError(
      "Committed stamp differs from the prepared transition; preserve recovery evidence."
    );
  verifiedBaseIndex(repo, readStamp(repo));
  for (const file of [journalPath, snapshotPath, stagedPath]) rmSync(file, { force: true });
  return { digest };
}

export async function writeV2State(repo, options) {
  return withUpdateLock(repo, () => commitV2State(prepareV2State(repo, options)));
}
