/**
 * review-bugbot/diff-capture.mjs — the atomic branch diff + its fingerprint that every
 * review pass, and the post-review re-check, must agree on.
 *
 * Owned invariant: `captureBranchDiff`'s fingerprint covers the tracked diff AND untracked
 * file content (hashed, or size-marked above `UNTRACKED_HASH_SIZE_CAP`), so a worktree
 * mutated mid-review is detected even when the tracked diff alone would look unchanged.
 * The PROMPT payload may drop generated noise (`PROMPT_EXCLUDED_GLOBS`, lifecycle-hook path
 * only) but the FINGERPRINTED payload never does — that split is what lets
 * `runExcludedPathGates` (scripts/review-bugbot/lockfile-gate.mjs) stand in for reviewer eyes
 * on the dropped bytes without the reviewer ever seeing an unreviewed diff pass as reviewed.
 * AIO-558: extracted verbatim from `scripts/review-bugbot.mjs` (this repo, not a rewrite) —
 * see `docs/v1-operator-loop/domains/safety-unit-extraction.md`.
 *
 * Exported:
 *   captureBranchDiff(worktree, baseSha, { includeWorktree, excludeFromPrompt })
 *   LOCAL_BUGBOT_DIFF_CAP
 *   UNTRACKED_HASH_SIZE_CAP
 *   PROMPT_EXCLUDED_GLOBS
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gitQuiet, gitRaw } from "./trusted-env.mjs";

export const LOCAL_BUGBOT_DIFF_CAP = 500_000;

/**
 * Above this size an untracked file is fingerprinted by its stat size instead of read and
 * hashed. A large untracked artifact (e.g. a stray build output or data dump) must not stall
 * the gate reading and hashing it on every run, but the fingerprint still has to invalidate
 * when the file changes — a size marker does that cheaply without ever reading the bytes.
 */
export const UNTRACKED_HASH_SIZE_CAP = 5 * 1024 * 1024;

function captureUntracked(worktree) {
  const listed = gitRaw(["ls-files", "--others", "--exclude-standard", "-z"], worktree);
  const files = listed.split("\0").filter(Boolean).sort();
  const blocks = [];
  const hashes = [];
  const withheldFiles = [];
  for (const rel of files) {
    const abs = path.join(worktree, rel);
    try {
      const size = statSync(abs).size;
      if (size > UNTRACKED_HASH_SIZE_CAP) {
        hashes.push(`${rel}\0toolarge:${size}`);
        withheldFiles.push(rel);
        blocks.push(
          `### Untracked file: ${rel}\n\n(untracked content withheld locally: ${size} bytes, too large to hash)`
        );
        continue;
      }
      const body = readFileSync(abs);
      const digest = createHash("sha256").update(body).digest("hex");
      hashes.push(`${rel}\0${digest}`);
      withheldFiles.push(rel);
      const rendered = `(untracked content withheld locally: ${body.length} bytes, sha256 ${digest})`;
      blocks.push(`### Untracked file: ${rel}\n\n${rendered}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hashes.push(`${rel}\0unreadable:${message}`);
      withheldFiles.push(rel);
      blocks.push(`### Untracked file: ${rel}\n\n(unreadable: ${message})`);
    }
  }
  return { files, blocks, fingerprintMaterial: hashes.join("\n"), withheldFiles };
}

function captureSuppressedTrackedFiles(worktree) {
  const listed = gitRaw(["ls-files", "-v", "-z"], worktree);
  return listed
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const tag = entry[0];
      return tag === "S" || /^[a-z]$/.test(tag) ? [entry.slice(2)] : [];
    })
    .sort();
}

/**
 * Generated paths whose RAW content is worthless to a reviewer but whose bulk crowds out the
 * real changeset (a lockfile churn alone can blow the diff cap). Excluded from the PROMPT
 * only, and only on the lifecycle-hook path — never from the fingerprint, and never for a
 * standalone `aios review-bugbot` or the `aios build`/`aios ship` pre-merge boundary, which
 * keep the full atomic diff. What the reviewer gets instead is a SUMMARIZED delta plus
 * fail-closed compensating gates (see `runExcludedPathGates`).
 *
 * `dist/**` is deliberately NOT here: it is gitignored and untracked in this repo, so
 * excluding it would be dead code carrying a live hard-block risk.
 */
export const PROMPT_EXCLUDED_GLOBS = ["package-lock.json", "**/package-lock.json"];
const includeExcludedSpecs = PROMPT_EXCLUDED_GLOBS.map((glob) => `:(glob)${glob}`);
const dropExcludedSpecs = PROMPT_EXCLUDED_GLOBS.map((glob) => `:(exclude,glob)${glob}`);

function captureExcludedFromPrompt(worktree, range) {
  const names = gitQuiet(["diff", "--name-only", range, "--", ...includeExcludedSpecs], worktree)
    .split("\n")
    .filter(Boolean)
    .sort();
  return names.map((file) => {
    const fileDiff = gitRaw(["diff", "--binary", range, "--", `:(literal)${file}`], worktree);
    return {
      path: file,
      bytes: Buffer.byteLength(fileDiff),
      sha256: createHash("sha256").update(fileDiff).digest("hex"),
    };
  });
}

export function captureBranchDiff(
  worktree,
  baseSha,
  { includeWorktree = false, excludeFromPrompt = false } = {}
) {
  const range = includeWorktree ? baseSha : `${baseSha}..HEAD`;
  let diffStat = gitQuiet(["diff", "--stat", range], worktree);
  const logOneline = gitQuiet(["log", "--oneline", `${baseSha}..HEAD`], worktree);
  const trackedDiff = gitQuiet(["diff", "--binary", range], worktree);
  const excluded = excludeFromPrompt ? captureExcludedFromPrompt(worktree, range) : [];
  // The prompt payload may drop generated paths; the fingerprinted payload never does.
  let promptTrackedDiff = excluded.length
    ? gitQuiet(["diff", "--binary", range, "--", ".", ...dropExcludedSpecs], worktree)
    : trackedDiff;
  let rawDiff = trackedDiff;
  let untrackedMaterial = "";
  let withheldUntrackedFiles = [];
  const suppressedTrackedFiles = includeWorktree ? captureSuppressedTrackedFiles(worktree) : [];
  if (includeWorktree) {
    const untracked = captureUntracked(worktree);
    if (untracked.files.length) {
      const suffix = `${untracked.files.length} untracked file${untracked.files.length === 1 ? "" : "s"}`;
      diffStat = diffStat ? `${diffStat}\n ${suffix}` : suffix;
      rawDiff = [rawDiff, ...untracked.blocks].filter(Boolean).join("\n\n");
      promptTrackedDiff = [promptTrackedDiff, ...untracked.blocks].filter(Boolean).join("\n\n");
      untrackedMaterial = untracked.fingerprintMaterial;
      withheldUntrackedFiles = untracked.withheldFiles;
    }
  }
  const fingerprint = createHash("sha256")
    .update(`${baseSha}\0${rawDiff}\0${untrackedMaterial}`)
    .digest("hex");
  const reviewTooLarge = promptTrackedDiff.length > LOCAL_BUGBOT_DIFF_CAP;
  let diff = promptTrackedDiff;
  if (diff.length > LOCAL_BUGBOT_DIFF_CAP) {
    const files = includeWorktree
      ? gitQuiet(["status", "--short"], worktree)
      : gitQuiet(["diff", "--name-only", range], worktree);
    diff = `(diff truncated at ${LOCAL_BUGBOT_DIFF_CAP} chars — files:\n${files})`;
  }
  return {
    diffStat,
    logOneline,
    diff,
    fingerprint,
    // A review must see the atomic changeset. Oversized diffs fail closed below.
    reviewDiff: promptTrackedDiff,
    reviewTooLarge,
    withheldUntrackedFiles,
    suppressedTrackedFiles,
    excluded,
    changedFiles: gitQuiet(["diff", "--name-only", range], worktree).split("\n").filter(Boolean),
  };
}
