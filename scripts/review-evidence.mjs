/**
 * review-evidence.mjs — barrel for the per-PR review-evidence gate (AIO-777).
 *
 * Two halves, deliberately separated so the seam is visible:
 *   ./review-evidence/body.mjs       a recorded copy of the hub's release-gate validator
 *   ./review-evidence/selection.mjs  the per-PR layer, which is ours
 *
 * The threat model that scopes this gate lives at the top of selection.mjs; the provenance of
 * the copy, and why the parity harness is a spot check rather than drift protection, at the top
 * of body.mjs. Import from here, never from the halves.
 */
export {
  validateReviewBody,
  decodeHtmlEntities,
  normalizeForScan,
  hasGovernedSeverity,
} from "./review-evidence/body.mjs";
export {
  STATUS_CONTEXT,
  EXEMPTION_MARKER,
  EVIDENCE_MARKER,
  evaluateReviewEvidence,
  isEvidenceCandidate,
  isExemptionCandidate,
  validateExemptionBody,
} from "./review-evidence/selection.mjs";
