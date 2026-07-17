/**
 * The client↔server wire contract for the AIOS workspace cockpit.
 *
 * This is the single typed source of truth for the WebSocket event stream and
 * the token-gated REST surface. It MUST stay byte-compatible with
 * `gui/server/index.mjs`. Capability descriptors (`hello.capabilities` and the
 * mirrored `ConfigResponse.capabilities`, see ./runtime.ts) are additive and may
 * be omitted by older servers.
 */

import type { Capabilities } from "./runtime";

/** Anthropic-shaped token usage. Fields are optional — non-Claude runtimes may omit them. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** A runtime-supplied permission choice (ACP / OpenCode option-style permissions). */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

/* ------------------------------------------------------------------ */
/* Server → Client events                                             */
/* ------------------------------------------------------------------ */

export interface HelloEvent {
  type: "hello";
  repo: string;
  sessionId: string;
  runtime: string;
  resumed?: boolean;
  safetyNote?: string | null;
  /** Additive (v1): per-runtime capability descriptor. Absent on older servers. */
  capabilities?: Capabilities;
}
export interface DeltaEvent {
  type: "delta";
  text: string;
}
export interface AssistantDoneEvent {
  type: "assistant_done";
}
export interface ToolUseEvent {
  type: "tool_use";
  name: string;
  input: unknown;
  id: string;
}
export interface ToolResultEvent {
  type: "tool_result";
  id: string;
  text: string;
  is_error?: boolean;
}
export interface PermissionRequestEvent {
  type: "permission_request";
  id: number;
  tool: string;
  input: unknown;
  options?: PermissionOption[];
}
export interface UsageEvent {
  type: "usage";
  usage: Usage;
}
export interface ModelEvent {
  type: "model";
  model: string;
}
export interface WarningEvent {
  type: "warning";
  message: string;
}
export interface ResultEvent {
  type: "result";
  subtype?: string;
  cost_usd?: number | null;
}
export interface ErrorEvent {
  type: "error";
  message: string;
}
export interface MemoryUpdatedEvent {
  type: "memory_updated";
  id: string;
  file: string;
  count: number;
  summary: string;
}
export interface MemoryUndoneEvent {
  type: "memory_undone";
  id: string;
  ok: boolean;
}
/**
 * Additive: server confirms an in-session approval-mode switch (mirrors `ModelEvent`),
 * so the composer selector stays in sync and a stored transcript can replay the change.
 * Emitted only by upgraded servers for runtimes that advertise `capabilities.approvalModes`.
 * Never emitted under AIOS_GUI_TEST_POLICY. Older clients ignore the unknown type.
 */
export interface ApprovalModeEvent {
  type: "approval_mode";
  mode: string;
}
export interface SessionEvent {
  type: "session";
  session_id: string;
  model?: string;
}
export interface EchoUserEvent {
  type: "echo_user";
  text: string;
}
/**
 * Emitted only when AIOS_GUI_TEST_POLICY is set (deterministic test policy) so the
 * UX harness can re-derive each tool verdict from the transcript. Inert in
 * production; the client ignores it (no default-branch handler).
 */
export interface ToolPolicyEvent {
  type: "tool_policy";
  tool: string;
  command: string;
  input: unknown;
  allowed: boolean;
  reason: string;
}

export type ServerEvent =
  | HelloEvent
  | DeltaEvent
  | AssistantDoneEvent
  | ToolUseEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | UsageEvent
  | ModelEvent
  | WarningEvent
  | ResultEvent
  | ErrorEvent
  | MemoryUpdatedEvent
  | MemoryUndoneEvent
  | ApprovalModeEvent
  | SessionEvent
  | EchoUserEvent
  | ToolPolicyEvent;

/** Any stored transcript line — same shape as a live ServerEvent. */
export type TranscriptEvent = ServerEvent;

/* ------------------------------------------------------------------ */
/* Client → Server messages                                           */
/* ------------------------------------------------------------------ */

export interface UserMessageMsg {
  type: "user_message";
  text: string;
  model?: string;
  /**
   * Additive: session-scoped approval mode (one of the runtime's advertised
   * `capabilities.approvalModes` ids). The server validates it against that list and
   * applies it on the NEXT send via the adapter; never persisted. Absent → unchanged.
   */
  approvalMode?: string;
}
export interface PermissionResponseMsg {
  type: "permission_response";
  id: number;
  allow?: boolean;
  optionId?: string;
}
export interface MemoryUndoMsg {
  type: "memory_undo";
  id: string;
}

export type ClientMessage = UserMessageMsg | PermissionResponseMsg | MemoryUndoMsg;

/* ------------------------------------------------------------------ */
/* REST DTOs (token-gated unless noted)                               */
/* ------------------------------------------------------------------ */

export interface ConfigResponse {
  model: string;
  personality: string | null;
  runtime: string;
  memoryReview: boolean | null;
  /** Raw allowed-model ids (the server emits `[...ALLOWED_MODELS]`, a string[]). */
  models: string[];
  /** Additive: same descriptor as `hello.capabilities`. Absent on older servers. */
  capabilities?: Capabilities;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  lastSelected: string | null;
}

export interface SessionTranscriptResponse {
  id: string;
  events: TranscriptEvent[];
}

/** One full-content chat-search hit (GET /api/sessions/search?q=). */
export interface SessionSearchResult {
  id: string;
  title: string;
  /** Plain-text, HTML-stripped, length-capped excerpt around the match. */
  snippet: string;
}
export interface SessionSearchResponse {
  results: SessionSearchResult[];
}

/* ---- personalities (Settings) ---- */

export interface Personality {
  id: string;
  name: string;
  description: string;
}
export interface PersonalitiesResponse {
  personalities: Personality[];
  current: string | null;
}

/* ---- skills library (Skills) ---- */

export type SkillTrust = "official" | "marketplace" | "community";

export interface SkillCapabilities {
  bundles_code?: boolean;
  code_files?: string[];
}

/** Where a skill's source lives (sent by the server; used to build a "View source" link). */
export interface SkillProvenance {
  upstream_repo?: string;
  upstream_commit?: string;
  vendored_at?: string;
}
export interface SkillSource {
  repo?: string;
  commit?: string;
  path_in_repo?: string;
}

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  trust: SkillTrust | string;
  capabilities?: SkillCapabilities;
  installed: boolean;
  license?: string;
  bundled?: boolean;
  /** Official skills: vendored-from provenance. */
  provenance?: SkillProvenance | null;
  /** Marketplace skills: fetched-on-install upstream source (precise path_in_repo). */
  source?: SkillSource | null;
}

export interface ReferencedSkill {
  id: string;
  name: string;
  description: string;
}

export interface SkillsResponse {
  skills: SkillEntry[];
  marketplace?: SkillEntry[];
  community?: SkillEntry[];
  referenced?: ReferencedSkill[];
  referenced_docs_url?: string;
  upstream_commit?: string;
  marketplace_upstream_commit?: string;
}

export type RiskClass = "low" | "elevated" | "high";

export interface ScanFinding {
  file: string;
  line: number;
  rule: string;
  snippet: string;
  severity: string;
}
export interface ScanCounts {
  total: number;
  high: number;
  code_files: number;
}
export interface SkillScanResponse {
  id: string;
  tier: string;
  name: string;
  riskClass: RiskClass | string;
  findings: ScanFinding[];
  counts: ScanCounts;
  bundlesCode?: boolean;
  requiresTypedConfirm: boolean;
}

/** Consent payload sent on a non-official skill install. */
export interface SkillConsent {
  accepted: boolean;
  typed?: string;
}
export interface SkillActionResponse {
  ok: boolean;
  error?: string;
  id?: string;
  installed?: boolean;
  tier?: string;
}

/* ---- connectors / integrations (Integrations) ---- */

export interface ConnectorSecret {
  env: string;
  label: string;
  required: boolean;
  placeholder: string;
}
export interface ConnectorInstanceField {
  env: string;
  label: string;
  placeholder?: string;
}
export interface ConnectorDocs {
  token_create_url?: string;
  instructions?: string;
}
export interface Connector {
  id: string;
  name: string;
  category?: string;
  transport: string;
  /** "token" (default) or "oauth" (one-click browser flow; token stored in the brain). */
  auth_mode?: string;
  summary: string;
  scopes?: string[];
  secrets?: ConnectorSecret[];
  docs?: ConnectorDocs;
  team_instance?: ConnectorInstanceField[];
  instance?: Record<string, string>;
  status: string;
  /** Required local secret(s) are present in the encrypted workspace vault; no values cross API. */
  credential_present?: boolean;
  /** The connector's skill/MCP runtime artifact is installed. */
  artifact_present?: boolean;
  team_enabled: boolean;
}
export interface ConnectorsResponse {
  connectors: Connector[];
}
export interface BlueprintResponse {
  ok: boolean;
  /** Raw pulled team blueprint (`.aios/blueprint.json`), or null if none. */
  blueprint?: Record<string, unknown> | null;
  connectors?: Connector[];
  note?: string | null;
}

export interface ConnectorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface ConnectorIdentity {
  label: string;
  value: string | null;
}
export interface ConnectorValidation {
  ok: boolean;
  checks: ConnectorCheck[];
  identity: ConnectorIdentity | null;
  instance: ConnectorIdentity | null;
  error?: string | null;
}
/** Response of POST /api/connectors/:id/start — the brain's Slack authorize URL. */
export interface OAuthStartResponse {
  authorize_url?: string;
  ok?: boolean;
  error?: string | null;
}
/** Response of GET /api/connectors/:id/status — whether the brain now holds the token. */
export interface OAuthStatusResponse {
  connected: boolean;
  slack_user_id?: string | null;
  workspace?: string | null;
  ok?: boolean;
  error?: string | null;
}
/** Response of POST /api/connectors/:id/store (200 ok, or 422/500 carrying `validation`/`error`). */
export interface ConnectorStoreResponse {
  ok: boolean;
  id?: string;
  status?: string;
  transport?: string;
  checks?: ConnectorCheck[];
  identity?: ConnectorIdentity | null;
  instance?: ConnectorIdentity | null;
  validation?: ConnectorValidation;
  error?: string | null;
}

/* ---- review & push (Review) ---- */

export interface ReviewItem {
  rel: string;
  kind: string | null;
  tier: string | null;
  isNew: boolean;
}
export interface ReviewBlockedItem {
  rel: string;
  reason: string;
}
export interface ReviewResponse {
  project: string;
  brain_url: string | null;
  items: {
    new?: ReviewItem[];
    modified?: ReviewItem[];
    blocked?: ReviewBlockedItem[];
    clean?: { rel: string }[];
  };
  error?: string;
}
export interface PushResponse {
  ok: boolean;
  dryRun: boolean;
  output: string;
  error: string | null;
}

/* ---- tasks (Tasks) ---- */
// Mirrors gui/server/tasks.mjs + scripts/tasks-table.d.mts byte-for-byte.

export interface TaskRow {
  row_key: string;
  title: string;
  assignee: string;
  status: string;
  sprint: string;
  due: string | null;
  pm_provider?: string;
  pm_external_id?: string;
  /** Verbatim PM cell for an unrecognized/retired provider, preserved so edits round-trip. */
  pm_raw?: string;
  pm_url?: string | null;
  parent?: string | null;
  labels?: string[];
  priority?: string | null;
}
/** Local sync-state badge for tasks.md — sourced from `aios status --json`, never the brain. */
export interface TaskPushState {
  state: "new" | "modified" | "blocked" | "clean";
  reason?: string;
}
export interface TasksResponse {
  /** null when the workspace has no tasks.md (renders an empty state). */
  rel: string | null;
  /** File-level access tier (team|external|admin), or null. */
  tier: string | null;
  rows: TaskRow[];
  pushState: TaskPushState | null;
}
/** Only the five light fields are editable; title/body are brain-canonical (server rejects them). */
export interface TaskEditRequest {
  row_key: string;
  patch: {
    status?: string;
    assignee?: string;
    priority?: string;
    labels?: string[];
    parent?: string | null;
  };
}
export interface TaskEditResponse {
  ok: boolean;
  rel: string;
  row: TaskRow;
  error?: string;
}

/* ---- maturity (Maturity) ---- */
// Mirrors gui/server/maturity.mjs `buildMaturityPayload` byte-for-byte.

export interface MaturityAxis {
  key: string;
  label: string;
  score: number;
  gloss: string;
}
/** One day of history: AM = placement.overall, CE = shadow band (null = uncalibrated). */
export interface MaturityDay {
  date: string;
  am: number | null;
  ce: number | null;
}
export interface AxisGuidance {
  gloss: string;
  meaning: string;
  why: string;
  steps: string[];
}
/**
 * Freshness metadata attached by the shared 30-day analysis cache behind
 * /api/maturity and /api/costs (gui/server/analysis-cache.mjs — AIO-453).
 */
export interface AnalysisCacheMeta {
  /** ISO timestamp of the analyze snapshot this payload was built from. */
  generatedAt?: string;
  /** Age of that snapshot at response time, in milliseconds. */
  ageMs?: number;
  /** True while a background refresh is running (stale-while-revalidate). */
  refreshing?: boolean;
  /** Message of the last failed refresh; null when healthy. */
  lastError?: string | null;
}
export interface MaturityResponse extends AnalysisCacheMeta {
  window: { since: string; until: string } | null;
  spine: string | null;
  overall: number | null;
  weakest: string | null;
  axes: MaturityAxis[];
  /** Cognitive Ergonomics shadow band (0–4 or null). SHADOW / local-only — never syncs. */
  ce_band: number | null;
  days: MaturityDay[];
  guidance: {
    weakest: AxisGuidance | null;
    ergonomics_tip: string;
  };
  error?: string;
}

// ── Cost panel (individual, this-workspace spend across all four providers) ──
/** One calendar day of spend; provider keys hold USD (0-filled), `date` is the label. */
export interface CostSpendDay {
  date: string;
  [provider: string]: number | string;
}
/** One calendar day of token totals across all providers. */
export interface CostTokenDay {
  date: string;
  input: number;
  output: number;
  cache_read: number;
}
/** Per-provider rollup with provenance (billing vs estimate vs session cost). */
export interface CostProviderRollup {
  provider: string;
  label: string;
  source: "billing" | "estimate" | "session";
  estimated: boolean;
  cost_usd: number;
  events: number;
}
/** Flat subscription plan (Claude Max/Pro) — real spend, not per-token. */
export interface CostPlan {
  provider: string;
  billing: string;
  plan: string;
  label: string;
  monthly_usd: number | null;
  source: string;
  note?: string;
}
export interface CostResponse extends AnalysisCacheMeta {
  window: { since: string; until: string } | null;
  providers: string[];
  by_provider: CostProviderRollup[];
  spendByDay: CostSpendDay[];
  tokensByDay: CostTokenDay[];
  totals: { cost_usd: number };
  plan: CostPlan | null;
  cursor_error: string | null;
  anthropic_error?: string | null;
  error?: string | null;
}

/* ---- operator loop (Loop) ---- */
// Wire contract for the four loop routes served by gui/server/loop.mjs.
//
// Pass-through routes emit the CLI's `--json` object VERBATIM (mirroring the compiled
// src/operator-loop types byte-for-byte):
//   • GET  /api/loop/collect   → RunManifest         (src/operator-loop/manifest.ts)
//   • GET  /api/loop/daily      → DailyOrientation    (src/operator-loop/daily.ts)
//   • GET  /api/loop/telemetry  → LoopMetrics         (src/operator-loop/telemetry.ts)
// Reshaped route (GUI-contract, like MaturityResponse — the CLI emits paths only, so the
// server reads the owner brief off disk):
//   • POST /api/loop/weekly     → WeeklyCloseoutResponse
//
// Business exit codes are surfaced as `cliExitCode` (NOT an HTTP error): weekly=1 on a
// non-shippable audience, telemetry=2 on a shipped tier leak. The panel renders the payload
// with a warning badge. A 500 (with `error`) is reserved for spawn failure / empty stdout /
// unparseable JSON. Telemetry defaults to a 14-day window when `?window` is omitted (matches
// the CLI default), so the client omits the param unless the user picks a window.

export type LoopTier = "admin" | "team" | "external";
export type LoopCadence = "daily" | "weekly";

export interface LoopEvidenceRef {
  path: string;
  row?: string;
  tier: LoopTier;
}
export interface LoopSignal {
  kind: string;
  source: string;
  tier: LoopTier;
  occurredAt: string;
  ref: LoopEvidenceRef;
  summary: string;
  payload?: Record<string, unknown>;
}
export interface LoopExclusion {
  ref: string;
  reason: string;
}

/** C1 collect — the run manifest, emitted verbatim by `aios loop collect --json`. */
export interface RunManifest {
  member: string;
  project: string;
  window: { cadence: LoopCadence; from: string; to: string };
  windowed: boolean;
  generatedAt: string;
  signals: LoopSignal[];
  excluded: LoopExclusion[];
  error?: string;
}

/** One row in a daily section. */
export interface DailyItem {
  kind: string;
  summary: string;
  tier: LoopTier;
  ref: LoopEvidenceRef;
  due?: string | null;
  stale?: number;
  changeType?: "added" | "modified";
}
export interface TagTotal {
  tag: string;
  durationMin: number;
}
/** C4 actions-first orientation, emitted verbatim by `aios loop daily --json`. */
export interface DailyOrientation {
  member: string;
  window: { cadence: "daily"; from: string; to: string };
  generatedAt: string;
  audience: "owner" | "team" | "external";
  attention: DailyItem[];
  queuedAsks: DailyItem[];
  changed: DailyItem[];
  blocked: DailyItem[];
  owedToday: DailyItem[];
  calendar: DailyItem[];
  commsNeedingReply: DailyItem[];
  ranByTag: TagTotal[];
  counts: {
    attention: number;
    queuedAsks: number;
    changed: number;
    blocked: number;
    owedToday: number;
    calendar: number;
    commsNeedingReply: number;
    withheld: number;
    excluded: number;
  };
  excluded: LoopExclusion[];
  error?: string;
}

/** C8 telemetry — one exit-criteria metric. */
export interface MetricResult {
  label: string;
  value: number | null;
  unit: string;
  threshold: string;
  met: boolean | null;
  sampleSize: number;
  note?: string;
}
/** C8 loop metrics, emitted verbatim by `aios loop telemetry --json`; `cliExitCode === 2`
 *  signals a shipped tier leak. */
export interface LoopMetrics {
  tierLeakCount: MetricResult;
  weeklyWallClock: MetricResult;
  verifierShippableRate: MetricResult;
  nextWeekActionAcceptance: MetricResult;
  dailyRunFrequency: MetricResult;
  consecutiveCleanWeeklies: MetricResult;
  breakdown: {
    weeklyRuns: number;
    dailyRuns: number;
    verifier: { pass: number; corrected: number; failed: number };
    leakWithheldTotal: number;
    dataQuality: {
      corruptLines: number;
      unknownVersionLines: number;
      missingFieldLines: number;
      unattributableGaps: number;
      degradedRunIds: string[];
    };
  };
  warnings: { phase: string; reason: string; line?: number; runId?: string }[];
  window: { from: string; to: string; days: number | null };
  cliExitCode?: number;
  error?: string;
}

/** C5 weekly closeout — RESHAPED by gui/server/loop.mjs `buildWeeklyCloseoutPayload`. The CLI
 *  emits `briefPath` only (audience-safe); the server reads the owner-only brief + actions off
 *  disk. `cliExitCode === 1` means a non-shippable audience (brief still shown). */
export interface WeeklyAudienceBlock {
  audience: string;
  status: string;
  shippable: boolean;
  digestPath: string | null;
  unshippablePath: string | null;
}
export interface WeeklyCloseoutResponse {
  runStamp: string;
  cadence: "weekly";
  briefMarkdown: string;
  ownerNextWeekActions: unknown[];
  audiences: WeeklyAudienceBlock[];
  cliExitCode?: number;
  error?: string;
}
