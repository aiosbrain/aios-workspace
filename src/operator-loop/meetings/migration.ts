import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MigrateTranscriptStageV1Options } from "./contracts.js";
import { TranscriptReviewError } from "./errors.js";
import { evaluateReview } from "./evaluation.js";
import { finalizeReview } from "./finalize.js";
import type { DraftTranscriptReviewResult } from "./models.js";
import { parseLegacyTranscriptStageV1 } from "./stage-schema.js";
import {
  canonicalRoot,
  readLiveLogs,
  readTranscripts,
  resolveStageFile,
  timestamp,
} from "./workspace.js";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function migrateTranscriptStageV1(
  options: MigrateTranscriptStageV1Options
): Promise<DraftTranscriptReviewResult> {
  const sourcePath = resolveStageFile(options.root, options.stagePath);
  const sourceBytes = readFileSync(sourcePath);
  const sourceDigest = digest(sourceBytes);
  const legacy = parseLegacyTranscriptStageV1(sourceBytes.toString("utf8"));
  const rubricBudget = options.rubricBudget ?? 1;
  const transcripts = readTranscripts(options.root, legacy.transcripts);
  const evaluation = await evaluateReview({
    runPhase: options.runPhase,
    transcripts,
    liveLogs: readLiveLogs(options.root),
    rubricBudget,
    initialCandidates: { decisions: legacy.decisions, tasks: legacy.tasks },
  });
  if (digest(readFileSync(sourcePath)) !== sourceDigest) {
    throw new TranscriptReviewError(
      "integrity",
      2,
      "legacy v1 stage digest changed during regrade; no v2 stage was created"
    );
  }
  return finalizeReview({
    root: options.root,
    evaluation,
    transcripts,
    rubricBudget,
    createdAt: timestamp(options.now),
    migration: {
      sourcePath: path.relative(canonicalRoot(options.root), sourcePath),
      sourceDigest,
      sourceVersion: 1,
    },
  });
}
