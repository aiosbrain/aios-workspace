import { readFileSync } from "node:fs";
import type { AttachTranscriptEvidenceOptions } from "./contracts.js";
import { TranscriptReviewError } from "./errors.js";
import { groundEvidenceBatch, parseEvidenceBatch } from "./evidence.js";
import type { EvidenceBatch, TranscriptReviewStageV2 } from "./models.js";
import { parseTranscriptReviewStage } from "./stage-schema.js";
import { replaceStage } from "./stage-store.js";
import { resolveStageFile } from "./workspace.js";

export type AttachTranscriptEvidenceResult = {
  readonly stagePath: string;
  readonly factsAttached: number;
  readonly stakeholdersAttached: number;
  readonly factsRejected: number;
  readonly stakeholdersRejected: number;
};

function dedupeByRowKey<T extends { readonly rowKey: string }>(items: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    if (seen.has(item.rowKey)) continue;
    seen.add(item.rowKey);
    kept.push(item);
  }
  return kept;
}

// Attach grounded 1.12 evidence to a freshly drafted, still-pending v2 stage. Evidence is excluded
// from the reviewDigest, so this does not recompute or invalidate it. Ungrounded candidates (quote
// not verbatim in the transcript) are dropped fail-closed.
export function attachTranscriptEvidence(
  options: AttachTranscriptEvidenceOptions
): AttachTranscriptEvidenceResult {
  const stagePath = resolveStageFile(options.root, options.stagePath);
  const stage = parseTranscriptReviewStage(readFileSync(stagePath, "utf8"));
  if (stage.status !== "pending_review") {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `evidence can only be attached to a pending_review stage; received ${stage.status}`
    );
  }
  const incoming: EvidenceBatch = parseEvidenceBatch({
    facts: options.facts ?? [],
    stakeholderMentions: options.stakeholderMentions ?? [],
  });
  const grounded = groundEvidenceBatch(options.root, incoming);
  const facts = dedupeByRowKey(grounded.facts);
  const stakeholderMentions = dedupeByRowKey(grounded.stakeholderMentions);
  const next: TranscriptReviewStageV2 = { ...stage, facts, stakeholderMentions };
  replaceStage(stagePath, next);
  return {
    stagePath,
    factsAttached: facts.length,
    stakeholdersAttached: stakeholderMentions.length,
    factsRejected: incoming.facts.length - facts.length,
    stakeholdersRejected: incoming.stakeholderMentions.length - stakeholderMentions.length,
  };
}
