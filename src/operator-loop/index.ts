// Public API of the operator-loop substrate (C1 collector + manifest, C2 evidence ledger).
// Consumed by the CLI (`aios loop`) and the MCP `aios_loop_collect` tool via the SAME core.

export { collect, type CollectOptions } from "./collector.js";
export { buildManifest, type RunManifest, type BuildManifestInput } from "./manifest.js";
export { resolveSpine, type Spine } from "./spine.js";
export { DAILY, WEEKLY, windowFor, type WindowConfig } from "./config.js";
export { resolveTier, type Signal, type EvidenceRef, type Tier, type Cadence } from "./signal.js";
export type { Source, SourceContext, SourceResult, Exclusion } from "./sources/types.js";

// C2 — evidence ledger
export {
  visibleTiers,
  assertGrounded,
  redactForTier,
  type Audience,
  type LedgerEntry,
  type EvidenceLedger,
  type RedactionResult,
  type RedactedEntry,
  type WithheldSummary,
} from "./ledger.js";

// C3 — verifier (rubric-gated, bounded correction)
export {
  verifyLedger,
  runVerification,
  budgetFor,
  type VerifierStatus,
  type VerifierCheck,
  type VerifierFinding,
  type VerifierResult,
  type VerifyLedgerInput,
  type RunVerificationInput,
  type CorrectFn,
  type SupportCheckFn,
  type SemanticCheckFn,
} from "./verifier.js";

// Inspection
export { explainManifest, type ExplainView, type ExplainLine } from "./explain.js";
