import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { TranscriptReviewError } from "./errors.js";
import type { ReviewableStage, TranscriptReviewStageV2 } from "./models.js";
import { ensurePrivateDirectory, STAGING_RELATIVE } from "./workspace.js";

function stageBytes(stage: TranscriptReviewStageV2): string {
  return `${JSON.stringify(stage, null, 2)}\n`;
}

function isCollision(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export function persistNewStage(root: string, stage: ReviewableStage): string {
  const directory = ensurePrivateDirectory(root, STAGING_RELATIVE);
  const timestamp = stage.createdAt.replace(/[:.]/g, "-");
  const prefix = `${timestamp}-${stage.id.slice(0, 12)}`;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const stagePath = path.join(directory, `${prefix}${suffix}.json`);
    let created = false;
    try {
      const descriptor = openSync(stagePath, "wx", 0o600);
      created = true;
      try {
        writeFileSync(descriptor, stageBytes(stage));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      chmodSync(stagePath, 0o600);
      return stagePath;
    } catch (error) {
      if (isCollision(error)) continue;
      if (created && existsSync(stagePath)) unlinkSync(stagePath);
      throw new TranscriptReviewError("operation", 1, "failed to persist transcript review stage", {
        cause: error,
      });
    }
  }
  throw new TranscriptReviewError(
    "operation",
    1,
    "transcript stage filename collision budget exhausted"
  );
}

export function atomicReplace(pathname: string, content: string, mode: number): void {
  const temporary = `${pathname}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, pathname);
    chmodSync(pathname, mode);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function replaceStage(pathname: string, stage: TranscriptReviewStageV2): void {
  atomicReplace(pathname, stageBytes(stage), 0o600);
}
