import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { LiveLogs } from "./contracts.js";
import { TranscriptReviewError } from "./errors.js";
import { parseLiveLog } from "./markdown.js";
import type { PreparedTranscript } from "./models.js";

export const STAGING_RELATIVE = ".aios/staging/transcript-decisions";
export const LOCK_RELATIVE = ".aios/locks";

function contained(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch (error) {
    throw new TranscriptReviewError("operation", 1, `workspace root is unreadable: ${root}`, {
      cause: error,
    });
  }
}

export type WorkspaceFileRequest = {
  readonly root: string;
  readonly requested: string;
  readonly label: string;
  readonly missingExit?: 1 | 2;
};

export function resolveExistingWorkspaceFile(request: WorkspaceFileRequest): string {
  const missingExit = request.missingExit ?? 1;
  const canonical = canonicalRoot(request.root);
  const suppliedRoot = path.resolve(request.root);
  const lexical = path.resolve(suppliedRoot, request.requested);
  if (!contained(suppliedRoot, lexical) && !contained(canonical, lexical)) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `path escapes workspace: ${request.requested}`
    );
  }
  let resolved: string;
  try {
    resolved = realpathSync(lexical);
  } catch (error) {
    throw new TranscriptReviewError(
      missingExit === 1 ? "operation" : "invalid_input",
      missingExit,
      `${request.label} not found or unreadable: ${request.requested}`,
      { cause: error }
    );
  }
  if (!contained(canonical, resolved)) {
    throw new TranscriptReviewError(
      "integrity",
      2,
      `path escapes workspace through a symlink: ${request.requested}`
    );
  }
  const metadata = lstatSync(lexical);
  if (metadata.isSymbolicLink() || !statSync(resolved).isFile()) {
    throw new TranscriptReviewError(
      "integrity",
      2,
      `${request.label} must be a regular non-symlink file`
    );
  }
  return resolved;
}

export function resolveStageFile(root: string, requested: string): string {
  const canonical = canonicalRoot(root);
  const staging = path.resolve(canonical, STAGING_RELATIVE);
  const resolved = resolveExistingWorkspaceFile({
    root,
    requested,
    label: "stage file",
    missingExit: 2,
  });
  let canonicalStaging: string;
  try {
    canonicalStaging = realpathSync(staging);
  } catch (error) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      "transcript staging directory is unreadable",
      {
        cause: error,
      }
    );
  }
  if (!contained(canonical, canonicalStaging)) {
    throw new TranscriptReviewError(
      "integrity",
      2,
      "transcript staging directory escapes workspace"
    );
  }
  if (!contained(canonicalStaging, resolved)) {
    throw new TranscriptReviewError(
      "integrity",
      2,
      `stage file must be inside ${STAGING_RELATIVE} without an escaping symlink`
    );
  }
  return resolved;
}

export function ensurePrivateDirectory(root: string, relative: string): string {
  const canonical = canonicalRoot(root);
  const target = path.resolve(canonical, relative);
  if (!contained(canonical, target)) {
    throw new TranscriptReviewError(
      "integrity",
      2,
      `private directory escapes workspace: ${relative}`
    );
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const resolved = realpathSync(target);
  if (!contained(canonical, resolved)) {
    throw new TranscriptReviewError(
      "integrity",
      2,
      `private directory is an escaping symlink: ${relative}`
    );
  }
  return resolved;
}

export function readTranscripts(
  root: string,
  paths: readonly string[]
): readonly PreparedTranscript[] {
  if (paths.length === 0) {
    throw new TranscriptReviewError("invalid_input", 2, "pass at least one transcript path");
  }
  return paths.map((transcriptPath) => {
    const file = resolveExistingWorkspaceFile({
      root,
      requested: transcriptPath,
      label: "transcript",
    });
    const bytes = readFileSync(file);
    const content = bytes.toString("utf8");
    return {
      path: path.relative(canonicalRoot(root), file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      chars: content.length,
      content,
    };
  });
}

export function readLiveLogs(root: string): LiveLogs {
  const decisionFile = resolveExistingWorkspaceFile({
    root,
    requested: "3-log/decision-log.md",
    label: "decision log",
  });
  const taskFile = resolveExistingWorkspaceFile({
    root,
    requested: "3-log/tasks-team.md",
    label: "task log",
  });
  return {
    decisions: parseLiveLog(readFileSync(decisionFile, "utf8"), "decisions", decisionFile),
    tasks: parseLiveLog(readFileSync(taskFile, "utf8"), "tasks", taskFile),
  };
}

export function timestamp(source: string | (() => string) | undefined): string {
  const value = typeof source === "function" ? source() : (source ?? new Date().toISOString());
  if (Number.isNaN(Date.parse(value))) {
    throw new TranscriptReviewError("invalid_input", 2, `invalid timestamp: ${value}`);
  }
  return value;
}
