// Public API of the operator-loop substrate (C1 collector + manifest, C2 evidence ledger).
// Consumed by the CLI (`aios loop`) and the MCP `aios_loop_collect` tool via the SAME core.
//
// This barrel is the Operator Loop's composition point (Constitution §4): it is the one place
// permitted to wire domains together — e.g. injecting the `comms` implementations into the `asks`
// harvester (see `defaultHarvestDeps` / `harvestAsks` below). Domains never compose each other.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadCommsConfig } from "./comms/config.js";
import { detectEvents } from "./comms/detectors.js";
import { dispatchOnEvent } from "./comms/sender.js";
import {
  harvestAsks as harvestAsksCore,
  type HarvestOptions,
  type HarvestResult,
  type HarvestDeps,
} from "./asks/harvest.js";
import { readAsks, type Ask } from "./asks/store.js";
import { readObservations, type LegacyActivityRecord } from "./inbox/observations.js";
import { assembleFromObservations, type InboxView, type Ranker } from "./inbox/cli.js";
// Composition-point wiring for the capability seam → durable I-02 journal (AIO-427). Local bindings
// (a `export … from` re-export does NOT bring a symbol into local scope) for `createDurableCapabilityJournal`.
import { appendInboxEvent, readJournalSegments, INBOX_DIR_REL } from "./inbox/journal.js";
import type { AppendCapabilityEvent } from "./inbox/capability.js";
// Composition-point wiring for the ranker seam → I-04 deterministic ranker (AIO-429).
import { loadRegistry } from "./inbox/ranker.js";
import { createInboxRanker } from "./inbox/ranker-adapter.js";
// Composition-point wiring for the outbox seam → durable I-02 journal (AIO-392).
import type { AppendOutboxEvent } from "./inbox/outbox.js";
// Composition-point wiring for the I-05 notify + recovery lane (AIO-386): the loop reads the asks
// store + the durable journal here and hands them to the pure `buildOverdueView`, so the `inbox`
// domain never value-imports the `asks` domain.
import { buildOverdueView, type OverdueView } from "./inbox/recovery.js";
import { deepLinkForAsk } from "./inbox/notify-telegram.js";
// Type-only local import so `createDurableM365VerifyJournal` can name the sink type in scope (a
// `export … from` re-export does not bring a symbol into local scope).
import type { M365VerifyJournalSink } from "./inbox/m365-verify.js";

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
  LEAK_REPORT_FILENAME,
  type CloseoutResult,
  type ShareableResult,
  type ShareableAudience,
  type LeakReportEntry,
} from "./closeout.js";
export {
  draftShareable,
  stubDraftShareable,
  makeCorrectFn,
  deriveAdminActions,
  type NextWeekAction,
  type DraftResult,
} from "./drafter.js";
export {
  projectManifest,
  withheldByTier,
  aboveAudienceStrings,
  aboveAudienceStringTiers,
} from "./project.js";
export { sweepForLeaks, hasLeak } from "./leak-sweep.js";
export {
  anthropicCompletion,
  makeAnthropicCompletion,
  runCompletion,
  hasAnthropicKey,
  DRAFTER_MODEL,
  type CompletionFn,
  type CompletionRequest,
  type CompletionOptions,
} from "./llm.js";

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

// Recording-daily connector preamble (AIO-366) — loop-core composition, independently bounded and
// fail-open. Connector adapters remain manually invokable; this only automates the owner cadence.
export {
  pullDailyConnectors,
  dailyConnectorCommands,
  DEFAULT_DAILY_CONNECTOR_TIMEOUTS,
  type DailyConnectorName,
  type DailyConnectorStatus,
  type DailyConnectorResult,
  type DailyConnectorPullResult,
  type DailyConnectorTimeouts,
  type DailyConnectorCredentials,
  type ConnectorCommand,
  type ConnectorSpawn,
  type PullDailyConnectorsOptions,
} from "./connectors.js";

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
  appendCreateDeduped,
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
export type { HarvestOptions, HarvestResult, HarvestDeps } from "./asks/harvest.js";

// Composition (Constitution §4): the loop injects the comms-backed deps into the asks harvester so
// the `asks` domain never value-imports `comms`. `defaultHarvestDeps` is the production wiring;
// `harvestAsks(root, opts)` is the convenience surface the CLI (`cmdAsks`) and MCP call unchanged.
export const defaultHarvestDeps: HarvestDeps = { loadCommsConfig, detectEvents, dispatchOnEvent };

export function harvestAsks(root: string, opts: HarvestOptions): Promise<HarvestResult> {
  return harvestAsksCore(root, opts, defaultHarvestDeps);
}

// Decision capture — durable learning/training corpus of human-in-the-loop prompt decisions
// (AIO-170 / EE4). Append-only local store (writer-honored lock, admin-tier, never synced); the
// dependency-free hooks/decision-capture.mjs reimplements the create-line writer + lock protocol.
export {
  DECISIONS_STORE_REL,
  DECISIONS_SCHEMA_VERSION,
  sha256 as decisionSha256,
  buildDecisionRecord,
  withLock as withDecisionLock,
  foldDecisionLines,
  readDecisions,
  appendDecision,
  appendDecisionsDeduped,
  DECISIONS_HARD_LINE_CAP,
  existingDecisionKeys,
  decisionDedupeKey,
  appendOutcome,
  type Decision,
  type DecisionRecord,
  type DecisionInput,
  type DecisionOption,
  type DecisionContext,
  type DecisionOp,
  type DedupeBatchResult,
  type FoldResult as DecisionFoldResult,
  type FoldWarning as DecisionFoldWarning,
} from "./decisions/store.js";
export {
  distill,
  projectForDistill,
  renderDraft,
  scrubPaths,
  hasResidualPath,
  PATH_PLACEHOLDER,
  DEFAULT_MIN_SUPPORT,
  type DistillOptions,
  type DistillResult,
  type DistilledPrinciple,
  type ProjectedDecision,
} from "./decisions/distill.js";

// Unified inbox — the durable `inbox-events.ndjson` journal + deterministic SQLite read-model
// rebuild (I-02 / AIO-383). Admin-tier local state under `.aios/loop/inbox/`; NEVER synced. The
// journal is canonical for the inbox lifecycle; asks.ndjson + activity.jsonl are advisory join
// inputs (so a rebuild survives the asks 7-day GC unchanged). D5 ruling: better-sqlite3 (WAL).
export {
  INBOX_DIR_REL,
  INBOX_SEGMENT_PREFIX,
  INBOX_SNAPSHOT_BASENAME,
  INBOX_SCHEMA_VERSION,
  KNOWN_SCHEMA_VERSIONS,
  SEGMENT_MAX_BYTES,
  INBOX_EVENT_KINDS,
  InboxValidationError,
  withInboxLock,
  appendInboxEvent,
  validateEventInput,
  parseEventLine,
  readJournalSegments,
  listSegments,
  rewriteSegments,
  readSnapshot as readInboxSnapshot,
  writeSnapshot as writeInboxSnapshot,
  snapshotPath as inboxSnapshotPath,
  type InboxEvent,
  type InboxEventKind,
  type AppendEventInput,
  type AppendResult,
  type AppendOptions,
  type JournalWarning,
  type JournalReadResult,
} from "./inbox/journal.js";
export {
  READ_MODEL_VERSION,
  READ_MODEL_DB_BASENAME,
  foldEvents,
  rebuildReadModel,
  readModelDigest,
  compact as compactInboxJournal,
  type ItemState,
  type Tombstone,
  type Receipt,
  type AuditLink,
  type FoldWarning as InboxFoldWarning,
  type ReadModelState,
  type RebuildOptions,
  type RebuildReport,
  type CompactOptions,
  type CompactReport,
  type SourceRead,
} from "./inbox/read-model.js";
// Enriched adapter-observation record + dual-read projection (I-06 / AIO-387). The versioned
// record carries account/tenant identity so the corrected dedup key
// `(connection/account/tenant, object_kind, native_id)` keeps two accounts observing one native
// object as two items; the legacy `activity.jsonl` stream stays byte-identical (dual emission).
export {
  OBSERVATIONS_SCHEMA_VERSION,
  OBSERVATIONS_BASENAME,
  ObservationValidationError,
  isResolvedIdentityScope,
  observationDedupKey,
  observationObjectKey,
  observationLineKey,
  buildObservation,
  parseObservationLine,
  observationsPath,
  readObservations,
  readCursor,
  appendObservations,
  writeObservation,
  legacyToObjectRef,
  projectObservations,
  type AccountTenantIdentity,
  type ObjectKind,
  type RevisionOp,
  type ObservationParticipant,
  type ObservationRevision,
  type EnrichedObservation,
  type ObservationInput,
  type ObservationReadWarning,
  type ObservationReadResult,
  type LegacyActivityRecord,
  type ProjectedItem,
  type ProjectInput,
} from "./inbox/observations.js";
// Unified inbox read-only CLI projection (I-09 / AIO-390, the G4 gate). One ranked queue over asks
// (agent-events) ∪ enriched observations ∪ legacy activity (thread-states), with a protected
// partition and a raw chronological escape hatch. Read-only + admin-tier local; NEVER synced. The
// per-item v1 ask fields pass through byte-identical to `aios asks --json` (dual-read parity).
export {
  INBOX_RANKER_VERSION_FALLBACK,
  RECENCY_WHY,
  FRESHNESS_SLO_MS,
  PARTITION_SEPARATOR,
  askToItem,
  threadToItem,
  rankItems,
  rawOrder,
  assembleInboxView,
  assembleFromObservations,
  renderInboxText,
  type InboxItem,
  type InboxBucket,
  type InboxOrigin,
  type InboxView,
  type Staleness,
  type Ranker,
  type AssembleInput,
  type RenderColors,
} from "./inbox/cli.js";

/** Admin-tier LOCAL default for I-04's relationship/project registry, read by `buildInbox` to build
 *  the deterministic ranker (AIO-429). Absent/broken → fail-open (tier-only, everything unprotected)
 *  but STILL the real ranker + `RANKER_VERSION`. NEVER synced; not a sync surface. */
export const INBOX_RANKING_REGISTRY_BASENAME = "ranking-registry.json";

/** Absolute path to the admin-local default ranking registry under `.aios/loop/inbox/`. */
export function inboxRankingRegistryPath(root: string): string {
  return path.join(root, INBOX_DIR_REL, INBOX_RANKING_REGISTRY_BASENAME);
}

export { createInboxRanker, toRankInput } from "./inbox/ranker-adapter.js";

/**
 * Loop composition point (Constitution §4) for `aios inbox`: read the asks store + the enriched
 * observation log + the legacy `activity.jsonl` stream(s), then assemble the unified read-only
 * view. The `inbox` domain never value-imports the `asks` domain — that seam is composed HERE.
 * Read-only: no store is mutated. `activityPaths` mirrors the read-model's advisory join inputs.
 *
 * Ranking (AIO-429): by default this injects I-04's REAL deterministic ranker via the adapter,
 * loading the relationship/project registry from `registryPath` (explicit override) or the
 * admin-local default `.aios/loop/inbox/ranking-registry.json`. A missing/broken registry fails
 * open (tier-only, everything unprotected) without crashing but still uses the real ranker/version.
 * An explicit `ranker` still wins (the test-injection seam), and `--raw` remains ranking-free.
 */
export function buildInbox(
  root: string,
  opts: {
    now?: Date;
    sloMs?: number;
    ranker?: Ranker;
    registryPath?: string;
    asksOverride?: readonly Ask[];
    activityPaths?: string[];
    observationsPath?: string;
  } = {}
): InboxView {
  const ranker =
    opts.ranker ??
    createInboxRanker(loadRegistry(opts.registryPath ?? inboxRankingRegistryPath(root)), {
      now: opts.now,
    });
  const asks = opts.asksOverride ?? readAsks(root).asks;
  const { observations } = readObservations(root, opts.observationsPath);
  const activityPaths = opts.activityPaths ?? [
    path.join(root, "1-inbox", "comms", "activity.jsonl"),
    path.join(root, ".aios", "loop", "comms", "activity.jsonl"),
  ];
  const legacy: LegacyActivityRecord[] = [];
  for (const ap of activityPaths) {
    if (!existsSync(ap)) continue;
    let raw: string;
    try {
      raw = readFileSync(ap, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        legacy.push(JSON.parse(line) as LegacyActivityRecord);
      } catch {
        /* advisory join input — a malformed activity line is skipped, never fatal */
      }
    }
  }
  return assembleFromObservations({
    asks,
    enriched: observations,
    legacy,
    now: opts.now,
    sloMs: opts.sloMs,
    ranker,
  });
}

// Unified inbox — Telegram notify lane (I-05 / AIO-386, the G3b interrupt lane). Content-free
// notification projection + deep-link + the two honest ack journal events (`delivery-attempted` /
// `human-ack`). The `tg` adapter reaches the Bot API through an injected transport (the HTTP
// boundary), so nothing here touches the network at import; `sender.ts` is a separate, untouched
// contract this lane never invokes. Admin-tier local; nothing here syncs to the Team Brain.
export {
  DEEP_LINK_SCHEME,
  DEEP_LINK_RE,
  deepLinkForAsk,
  askIdFromDeepLink,
  projectNotification,
  formatNotificationText,
  loadTelegramConfig,
  fetchTelegramTransport,
  sendNotification,
  recordHumanAck,
  createDurableNotifyJournal,
  TELEGRAM_TOKEN_ENVS,
  TELEGRAM_CHAT_ENVS,
  type NotificationProjection,
  type ProjectionInput,
  type TelegramRequest,
  type TelegramResponse,
  type TelegramTransport,
  type TelegramConfig,
  type NotifyStatus,
  type NotifyResult,
  type NotifyDeps,
  type NotifyEventInput,
} from "./inbox/notify-telegram.js";
// Unified inbox — `aios inbox --overdue` recovery view (I-05 / AIO-386, the G3b safety net). A pure
// projection over the durable asks queue ∪ the journal's notify-lane events: the OPEN, un-acked asks
// whose interrupt went unacknowledged past the escalation window. Fails safe — a silent lane never
// loses an ask. Composed with the stores at `buildOverdue` below.
export {
  DEFAULT_ESCALATION_WINDOW_MS,
  foldNotificationState,
  overdueView,
  buildOverdueView,
  renderOverdueText,
  type NotificationState,
  type OverdueItem,
  type OverdueInput,
  type OverdueView,
  type OverdueRenderColors,
} from "./inbox/recovery.js";

/**
 * Loop composition point (Constitution §4) for `aios inbox --overdue`: read the durable asks store +
 * the durable `inbox-events.ndjson` journal, then compute the recovery view. The `inbox` domain never
 * value-imports the `asks` domain — that seam is composed HERE. Read-only: no store is mutated. Fails
 * safe: a corrupt/absent journal still lists every open, un-acked, overdue ask from the asks queue.
 */
export function buildOverdue(
  root: string,
  opts: {
    now?: Date;
    escalationWindowMs?: number;
    asksOverride?: readonly Ask[];
  } = {}
): OverdueView {
  const asks = opts.asksOverride ?? readAsks(root).asks;
  const { events } = readJournalSegments(root);
  return buildOverdueView({
    asks,
    events,
    now: opts.now,
    ...(opts.escalationWindowMs !== undefined
      ? { escalationWindowMs: opts.escalationWindowMs }
      : {}),
    deepLinkForAsk,
  });
}

export {
  MACHINES,
  ATTENTION_STATES,
  ACTION_STATES,
  SOURCE_STATES,
  ATTENTION_TRANSITIONS,
  ACTION_TRANSITIONS,
  SOURCE_TRANSITIONS,
  ATTENTION_INITIAL,
  ACTION_INITIAL,
  SOURCE_INITIAL,
  applyTransition,
  initialValue,
  isKnownState,
  isLegalTransition,
  legalEdges,
  illegalEdges,
  UnknownStateError,
  IllegalTransitionError,
  OptimisticLockError,
  type MachineName,
  type MachineDef,
  type MachineValue,
  type AttentionState,
  type ActionState,
  type SourceState,
  type TransitionOptions,
} from "./inbox/state-machines.js";

// Unified Inbox — capability-handle broker (I-03 / AIO-384, G2b). Coordinator-side public API; the
// owning-runtime durable store lives beside the Claude Code adapter (capability-store.mjs). Provisional
// module home per I-01 (`src/operator-loop/inbox/`); admin-tier local state, never synced.
export {
  brokerDecision,
  notifyDeepLink,
  createInMemoryJournal,
  type ApprovalDecision,
  type DisplayProjection,
  type BrokeredDecision,
  type CapabilityEventKind,
  type CapabilityEvent,
  type AppendCapabilityEvent,
  type BrokerOptions,
  type DeepLinkAsk,
  type NotifyDeepLink,
  type NotifyDeepLinkOptions,
} from "./inbox/capability.js";

/**
 * Composition point (Constitution §4) for AIO-427: bridge the capability seam's content-free,
 * handle-keyed `CapabilityEvent` onto the durable I-02 `inbox-events.ndjson` journal. Returns an
 * `AppendCapabilityEvent` sink bound to `root` that the GUI gateway injects into `brokerDecision`,
 * `consumeAndExecute`, and `notifyDeepLink` so user-intent / pdp-decision / capability-consumption /
 * outcome / native-receipt events are durably written (and re-read / rebuilt) as canonical lifecycle
 * events. The `inbox` capability module never value-imports the journal — that seam is wired HERE.
 * Mapping: `handle → correlation_id`, `at → ts`, `data → payload`. `appendInboxEvent` validates the
 * kind against the real I-02 vocabulary and rejects an unknown kind before writing.
 *
 * NON-FATAL by contract (AIO-427 review): the sink NEVER throws. A validation error (unknown kind,
 * empty correlation id) or a filesystem/lock error from `appendInboxEvent` is caught here and reduced
 * to a CONTENT-FREE warning (the event kind + the error's class name only — never the payload/args),
 * then swallowed. This is what lets the runtime write the journal BEFORE its authoritative store line
 * without a journal fault ever stranding the store lock or crashing the gateway: the caller's store
 * write proceeds regardless, and a dropped line is recoverable by a later `rebuildReadModel`.
 */
export function createDurableCapabilityJournal(root: string): AppendCapabilityEvent {
  return (event) => {
    try {
      appendInboxEvent(root, {
        kind: event.kind,
        correlation_id: event.handle,
        payload: event.data ?? {},
        ...(event.at ? { ts: event.at } : {}),
      });
    } catch (err) {
      const name =
        err && typeof err === "object" && "name" in err ? String((err as Error).name) : "Error";
      try {
        // Content-free: kind is a fixed enum; `name` is an error class — no payload is ever logged.
        console.warn(`inbox journal: dropped a ${event?.kind ?? "?"} event (${name}); continuing`);
      } catch {
        /* never let logging itself throw */
      }
    }
  };
}

// Unified inbox — deterministic ranking in SHADOW mode (I-04 / AIO-385). Ports the hermes-aluna
// digest's zero-LLM classification rules + the entity/project importance signal + the protected
// partition. Admin-tier LOCAL only: `features`/`why`/shadow sidecar NEVER sync to the brain, and this
// module never perturbs the I-02 read-model projection (shadow = zero user-visible change).
export {
  RANKER_VERSION,
  SHADOW_LOG_BASENAME,
  EMPTY_REGISTRY,
  buildRegistry,
  loadRegistry,
  resolvePerson,
  protectedPartition,
  isNoise,
  actionability,
  importanceOf,
  isVendorish,
  rankItem,
  rankCorpus,
  shadowLogPath,
  recordShadowRanking,
  type Bucket,
  type ThreadKind,
  type SenderIdentity,
  type RankInput,
  type RankResult,
  type RegistryPerson,
  type Registry,
  type RankedRow,
  type ShadowRow,
} from "./inbox/ranker.js";

// Unified inbox — Reply PDP (origin-confined disclosure, I-10 / AIO-391). A NEW, SEPARATE policy
// decision point upstream of the comms sender (which stays byte-for-byte untouched): same-thread
// evidence may return to that thread's verified participants (admin-tier or not); every expansion
// is default-denied with a named promotion path. `evaluateReply` is the pure/deterministic core;
// `decideReply` journals one I-02 `pdp-decision` event via an injected sink (refs/counts only).
export {
  evaluateReply,
  decideReply,
  createMemoryJournalSink,
  REPLY_RULE_IDS,
  type ReplyVerdict,
  type ReplyRuleId,
  type ParticipantIdentity,
  type EvidenceKind,
  type EvidenceRef as ReplyEvidenceRef,
  type AttachmentRef,
  type QuotedRef,
  type Delegation,
  type ReplyChannel,
  type ReplyRequest,
  type ThreadContext,
  type PdpDecisionEvent,
  type PdpJournalSink,
  type ReplyContext,
  type PdpDecision,
} from "./inbox/reply-policy.js";

// Unified inbox — Outbox + Gmail send (I-11 / AIO-392, the G5 gate). The first real ACTION: send a
// Gmail reply through the I-10 reply PDP with an idempotent, reconcile-first outbox and native
// receipts. Pre-send checks run on the EXACT outbound bytes (recipient-set equality, header/quoted
// injection, admin-context leak markers); at-most-once actual sends per command_id. The gog send
// surface + the durable journal are INJECTED (no cross-domain value imports). Outbox records +
// receipts are admin-tier LOCAL I-02 journal state — content-free, NEVER synced. Claim scope: "the
// inbox code path is gated" at G5 (the ambient gog CLI still exists; G6b/I-15 owns cannot-bypass).
// `src/operator-loop/comms/sender.ts` stays byte-for-byte untouched.
export {
  ADMIN_CONTEXT_MARKERS,
  OutboxRejectedError,
  OutboxTimeoutError,
  OutboxSendError,
  OutboxReconcileError,
  approvedRecipientSet,
  outboundRecipientSet,
  parseOutboundMessage,
  checkPreSend,
  foldOutboxState,
  createOutbox,
  createInMemoryOutboxJournal,
  type OutboxState,
  type OutboxCommand,
  type OutboxRejectReason,
  type OutboxSendResult,
  type SentQuery,
  type OutboxSendClient,
  type OutboundMessage,
  type OutboxEventKind,
  type OutboxEvent,
  type AppendOutboxEvent,
  type SendAuthority,
  type EnqueueInput,
  type OutboxDeps,
  type Outbox,
} from "./inbox/outbox.js";
// Outbox credential wrapper (I-11 "where cheap"): assert the gog send token is gateway-private
// (0600, gateway uid) before wrapping a send client; skipped-with-reason on unsupported platforms.
export {
  assertGatewayTokenSecurity,
  type TokenSecurityResult,
  type TokenSecurityOptions,
} from "./inbox/outbox-credential.js";

/**
 * Composition point (Constitution §4) for AIO-392: bridge the outbox seam's content-free,
 * command-keyed `OutboxEvent` onto the durable I-02 `inbox-events.ndjson` journal. Returns an
 * `AppendOutboxEvent` sink bound to `root` so action-attempt / outcome / native-receipt events are
 * durably written (and re-read / rebuilt) as canonical lifecycle events. The `inbox` outbox module
 * never value-imports the journal — that seam is wired HERE. Mapping: `command_id → correlation_id`,
 * `at → ts`, `data → payload`. `appendInboxEvent` validates the kind against the real I-02
 * vocabulary and rejects an unknown kind before writing. The payload stays content-free (state /
 * reason / counts / native ids) — no body bytes, recipient addresses, or subject text ever cross.
 */
export function createDurableOutboxJournal(root: string): AppendOutboxEvent {
  return (event) => {
    appendInboxEvent(root, {
      kind: event.kind,
      correlation_id: event.command_id,
      payload: event.data ?? {},
      ...(event.at ? { ts: event.at } : {}),
    });
  };
}

// Unified inbox — m365 connect-and-verify (I-12 / AIO-393). The SECOND channel wired at the honest
// claim level: auth → read → one policy-mediated send on a TEST tenant, reported at exactly the level
// proven. CREDENTIAL-FREE: every Graph call rides the injected `GraphTransport` seam (fixtures ship;
// a live transport is the labelled needs-tenant residual). A fixture run never claims "connected and
// verified"; only a live, all-green run does. Admin-tier local; the one journal event is content-free.
export {
  M365_REQUIRED_SCOPES,
  M365_CHECK_SCOPE,
  M365_DIAGNOSTICS,
  M365_CONFIG_REL,
  verifyM365,
  validateToken,
  normalizeScopes,
  missingScopes,
  classifyGraphError,
  normalizeMessage,
  m365IdentityKey,
  paginateMessages,
  needsTenantReport,
  recordVerifyReport,
  createMemoryVerifyJournal,
  createFixtureTransport,
  loadM365Config,
  parseM365Config,
  type M365Scope,
  type M365DiagnosticCode,
  type M365TenantConfig,
  type AccessToken,
  type GraphMessage,
  type GraphPage,
  type GraphError,
  type GraphResult,
  type GraphTransport,
  type OutboundTestMessage,
  type SendReceipt,
  type ListMessagesOptions,
  type CheckStatus,
  type CheckResult,
  type VerifyMode,
  type VerifyStatus,
  type VerifyClaim,
  type VerifyReport,
  type VerifyOptions,
  type TokenValidation,
  type GraphErrorClass,
  type NormalizedM365Message,
  type PaginateResult,
  type PaginateOptions,
  type FixtureScenario,
  type M365VerifyEvent,
  type M365VerifyJournalSink,
} from "./inbox/m365-verify.js";

/**
 * Composition point (Constitution §4) for I-12: bridge the m365 verify seam's content-free
 * `M365VerifyEvent` onto the durable I-02 `inbox-events.ndjson` journal. Returns a sink bound to
 * `root`. Only a real `live` verify run should be durably journalled — a fixture/needs-tenant run
 * observed no tenant and writes nothing. Mapping mirrors `createDurableCapabilityJournal`.
 */
export function createDurableM365VerifyJournal(root: string): M365VerifyJournalSink {
  return {
    record(event) {
      appendInboxEvent(root, {
        kind: event.kind,
        correlation_id: event.correlation_id,
        payload: event.data,
        ...(event.ts ? { ts: event.ts } : {}),
      });
    },
  };
}

// Unified inbox — cold-start entity seeding (I-08 / AIO-389, review-only stretch). Deterministic,
// read-only suggestion generation over the enriched observation history; the SOLE writer of the
// registry/entity files is `merge`, which is reversible byte-for-byte via `unmerge`. Admin-tier
// LOCAL state under `.aios/loop/inbox/` (registry.json, entities/, seed-events.ndjson) — NEVER
// synced; promotion to a shareable tier is a separate deliberate `access:`-retagging act.
export {
  SEED_REGISTRY_BASENAME,
  SEED_ENTITIES_DIR,
  SEED_JOURNAL_BASENAME,
  SEED_JOURNAL_VERSION,
  MIN_SUPPORT_EVENTS,
  CONFIDENCE_WEIGHTS,
  FREQUENCY_SATURATION,
  THREAD_BREADTH_SATURATION,
  RECENCY_TAU_DAYS,
  SeedValidationError,
  registryPath as seedRegistryPath,
  seedJournalPath,
  entitiesDir as seedEntitiesDir,
  entitySlug,
  observationsToHistory,
  knownIdentities,
  generateSuggestions,
  tierForConfidence,
  readSeedJournal,
  foldSeedStatus,
  readSuggestions,
  merge as mergeSuggestion,
  reject as rejectSuggestion,
  unmerge as unmergeSuggestion,
  evaluateSuggestions,
  summarizeStatuses,
  listEntityFiles,
  type SeedKind,
  type SeedStatus,
  type SeedHistoryEvent,
  type ConfidenceBreakdown,
  type SeedSuggestion,
  type SeedProposedEntry,
  type SeedJournalEvent,
  type GenerateOptions,
  type MergeResult,
  type RejectResult,
  type UnmergeResult,
  type SeedEvaluation,
} from "./inbox/seeding.js";

// Attention mode — deep-work / orchestration toggle for the local notification ping (AIO-168).
export {
  NOTIF_CHANNEL_KEY,
  NOTIF_DISABLED_VALUE,
  defaultModePaths,
  modeStatus,
  enterDeepWork,
  enterOrchestration,
  type AttentionMode,
  type ModePaths,
  type ModeStatus,
  type ModeChange,
} from "./mode.js";
