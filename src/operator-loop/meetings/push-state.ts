import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  RecordTranscriptPushAttemptOptions,
  RecordTranscriptPushAttemptResult,
} from "./contracts.js";
import { TranscriptReviewError } from "./errors.js";
import type { PushAttempt, ReviewDiagnostic, TranscriptReviewStageV2 } from "./models.js";
import { computeReviewDigest } from "./review-digest.js";
import { parseTranscriptReviewStage } from "./stage-schema.js";
import { replaceStage } from "./stage-store.js";
import { resolveStageFile, timestamp } from "./workspace.js";

function approvedStage(
  pathname: string
): Extract<TranscriptReviewStageV2, { readonly status: "approved" }> {
  const stage = parseTranscriptReviewStage(readFileSync(pathname, "utf8"));
  if (stage.status !== "approved") {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      "push state can be recorded only after local approval"
    );
  }
  if (computeReviewDigest(stage) !== stage.reviewDigest) {
    throw new TranscriptReviewError("integrity", 2, "reviewDigest integrity check failed");
  }
  return stage;
}

function sanitizedDiagnostics(
  values: readonly (ReviewDiagnostic | string)[] | undefined
): readonly ReviewDiagnostic[] {
  return (values ?? []).map((value) =>
    typeof value === "string"
      ? { phase: "push", message: value.replace(/\s+/g, " ").trim().slice(0, 500) || "push failed" }
      : {
          phase: value.phase.replace(/\s+/g, " ").trim().slice(0, 80) || "push",
          message: value.message.replace(/\s+/g, " ").trim().slice(0, 500) || "push failed",
        }
  );
}

function finalizeAttempt(
  attempts: readonly PushAttempt[],
  options: RecordTranscriptPushAttemptOptions,
  at: string
): readonly PushAttempt[] {
  const attemptId = options.attemptId;
  if (attemptId === undefined) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `${options.state} push state requires attemptId`
    );
  }
  let matched = false;
  const updated = attempts.map((attempt) => {
    if (attempt.id !== attemptId) return attempt;
    if (attempt.state !== "pending") {
      throw new TranscriptReviewError(
        "invalid_input",
        2,
        `push attempt ${attemptId} is already final`
      );
    }
    matched = true;
    return {
      ...attempt,
      state: options.state === "failed" ? ("failed" as const) : ("succeeded" as const),
      at,
      diagnostics: sanitizedDiagnostics(options.diagnostics),
    };
  });
  if (!matched) {
    throw new TranscriptReviewError("invalid_input", 2, `unknown push attempt: ${attemptId}`);
  }
  return updated;
}

export function recordTranscriptPushAttempt(
  options: RecordTranscriptPushAttemptOptions
): RecordTranscriptPushAttemptResult {
  const stagePath = resolveStageFile(options.root, options.stagePath);
  const stage = approvedStage(stagePath);
  const at = timestamp(options.now);
  if (options.state === "skipped") {
    const updated = {
      ...stage,
      push: { state: "skipped" as const, attempts: stage.push.attempts },
    };
    replaceStage(stagePath, updated);
    return { stage: updated };
  }
  if (options.state === "pending") {
    const attemptId = randomUUID();
    const updated = {
      ...stage,
      push: {
        state: "pending" as const,
        attempts: [
          ...stage.push.attempts,
          {
            id: attemptId,
            state: "pending" as const,
            at,
            diagnostics: sanitizedDiagnostics(options.diagnostics),
          },
        ],
      },
    };
    replaceStage(stagePath, updated);
    return { attemptId, stage: updated };
  }
  const attempts = finalizeAttempt(stage.push.attempts, options, at);
  const updated = { ...stage, push: { state: options.state, attempts } };
  replaceStage(stagePath, updated);
  return { attemptId: options.attemptId, stage: updated };
}
