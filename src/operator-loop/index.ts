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

// C5 — weekly closeout (drafter + two-artifact orchestrator). Public surface only:
// `runVerificationWithLedger` is intentionally NOT exported (trusted-internal; closeout.ts
// imports it directly so the non-audience-safe corrected ledger can't be reached via the barrel).
export {
  runCloseout,
  runShareable,
  type CloseoutResult,
  type ShareableResult,
  type ShareableAudience,
} from "./closeout.js";
export {
  draftShareable,
  stubDraftShareable,
  makeCorrectFn,
  deriveAdminActions,
  type NextWeekAction,
  type DraftResult,
} from "./drafter.js";
export { projectManifest, withheldByTier, aboveAudienceStrings } from "./project.js";
export { sweepForLeaks, hasLeak } from "./leak-sweep.js";
export { anthropicCompletion, hasAnthropicKey, DRAFTER_MODEL, type CompletionFn } from "./llm.js";

// C7 — habit + continuity
export {
  CONTINUITY_ACTIONS_REL,
  isOpenContinuityAction,
  isOpenStatus,
  readContinuityActions,
  type ContinuityAction,
  type ContinuityActionSource,
  type ContinuityReadResult,
} from "./continuity.js";

// C6 — approval-gated writeback (deterministic promotion of verified C5 artifacts; no LLM).
export {
  planWriteback,
  promotability,
  audienceForTier,
  resolveTierOrDefault,
  stampFrontmatter,
  deriveRowKey,
  actionToRow,
  type WritebackTarget,
  type ShareAudience,
  type SkipCode,
  type Skip,
  type TaskRow,
  type FileWrite,
  type TaskWrite,
  type WritebackPlan,
  type ShareableOnDisk,
  type PlanWritebackInput,
} from "./writeback.js";

// Artifact change-tracking primitive (reusable across cadences; C4 is the first consumer)
export {
  artifactKey,
  fingerprint,
  canonicalJson,
  diffSignals,
  readSnapshot,
  writeSnapshot,
  snapshotRel,
  type ChangeType,
  type SnapshotEntry,
  type SnapshotStore,
  type SignalChange,
} from "./changes.js";

// C4 — daily light loop (changed / blocked / owed today)
export {
  buildDailyOrientation,
  runDaily,
  DAILY_SCOPE,
  STALE_CARRYOVER_DAYS,
  type DailyItem,
  type DailyOrientation,
  type BuildDailyOptions,
  type RunDailyOptions,
} from "./daily.js";

// C8 — loop telemetry + dogfood instrumentation (local-only, admin-tier)
export {
  TELEMETRY_EVENTS_REL,
  TELEMETRY_ENV,
  TELEMETRY_VERSION,
  THRESHOLDS,
  telemetryEnabled,
  recordEvent,
  readEvents,
  computeMetrics,
  type TelemetryKind,
  type TelemetryEvent,
  type TelemetryEventInput,
  type ParseReason,
  type ParseWarning,
  type ReadResult,
  type Warning,
  type MetricResult,
  type LoopMetrics,
  type ComputeOptions,
} from "./telemetry.js";

// Time tracking — native agent-session runtime (AIO-139)
export {
  TIME_CONFIG_REL,
  DEFAULT_IDLE_GAP_MIN,
  defaultTimeConfig,
  loadTimeConfig,
  parseTimeConfig,
  scopeRepo,
  type TimeConfig,
  type RepoRule,
  type RepoTier,
  type UnknownRepoDefault,
  type ScopeResult,
} from "./time/config.js";
export {
  parseJsonl,
  eventsFromRecords,
  readSessionEvents,
  defaultProjectsDir,
  type SessionEvent,
  type Actor,
  type ReadOptions,
} from "./time/session-log.js";
export {
  deriveBlocks,
  tagBlock,
  runtimeByTag,
  formatHours,
  TAGS,
  type WorkBlock,
  type Tag,
  type DeriveOptions,
  type TagTotal,
} from "./time/runtime.js";
export {
  requireSpineLog,
  storeRel,
  readStore,
  upsertRows,
  writeStore,
  renderStore,
  rowsEqual,
  TIME_LOG_BASENAME,
  type StoreRow,
  type StoreReadResult,
} from "./time/store.js";
export { capture, type CaptureOptions, type CaptureSummary } from "./time/capture.js";
export { reconcile, type ReconcileOptions, type ReconcileResult } from "./time/reconcile.js";

// Communication — unified notification layer (AIO-140).
// Inbound: `commsSource` normalizes Slack/email/calendar activity into `comms` C1 signals.
// Outbound: detectors → typed events → the tier-gated `dispatchOnEvent` sender.
export {
  COMMS_CONFIG_REL,
  DEFAULT_LOOKBACK_HOURS,
  COMMS_ACTIVITY_BASENAME,
  defaultCommsConfig,
  loadCommsConfig,
  parseCommsConfig,
  resolveChannelTier,
  type CommsConfig,
  type SenderConfig,
  type SlackConfig,
} from "./comms/config.js";
export {
  dispatchOnEvent,
  canChannelReceive,
  formatEvent,
  type NotificationEvent,
  type SendFn,
  type DispatchDeps,
  type DispatchResult,
  type RejectReason,
  type NoopReason,
} from "./comms/sender.js";
export { detectEvents, DEFAULT_STALE_INBOX_DAYS } from "./comms/detectors.js";
export type { SendEventFn } from "./comms/sender.js";

// Asks queue — non-blocking escalation queue (AIO-167). Append-only local store (writer-honored
// lock), inbox transport on the comms sender, and the `aios asks harvest` production caller.
export {
  ASKS_STORE_REL,
  ASKS_SCHEMA_VERSION,
  RESOLVED_GC_DAYS,
  OPEN_SOFT_CAP,
  OPEN_STALE_DAYS,
  sha256,
  buildRecord,
  withLock,
  foldLines,
  readAsks,
  hasOpenDuplicate,
  appendCreate,
  appendOp,
  detectOrphans,
  compact,
  type Ask,
  type AskRecord,
  type AskInput,
  type AskSeverity,
  type AskStatus,
  type AskOp,
  type FoldResult,
  type FoldWarning,
} from "./asks/store.js";
export { createInboxTransport, type InboxTransportOptions } from "./asks/transport.js";
export { harvestAsks, type HarvestOptions, type HarvestResult } from "./asks/harvest.js";
