import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TranscriptReviewError } from "./errors.js";
import { ensurePrivateDirectory, LOCK_RELATIVE } from "./workspace.js";

function isBusy(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export function withTranscriptApplyLock<T>(root: string, action: () => T): T {
  const directory = ensurePrivateDirectory(root, LOCK_RELATIVE);
  const lockPath = path.join(directory, "transcript-apply.lock");
  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, `${process.pid}\n`);
    closeSync(descriptor);
    descriptor = null;
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (created && existsSync(lockPath)) unlinkSync(lockPath);
    if (isBusy(error)) {
      throw new TranscriptReviewError(
        "busy",
        1,
        "transcript apply lock is busy; retry after the active approval completes",
        { cause: error }
      );
    }
    throw new TranscriptReviewError("operation", 1, "failed to acquire transcript apply lock", {
      cause: error,
    });
  }
  try {
    return action();
  } finally {
    unlinkSync(lockPath);
  }
}
