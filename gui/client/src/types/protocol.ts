/**
 * The client↔server wire contract for the AIOS workspace cockpit.
 *
 * This is the single typed source of truth for the WebSocket event stream and
 * the token-gated REST surface. It MUST stay byte-compatible with
 * `gui/server/index.mjs`; the only in-scope additive change is `hello.capabilities`
 * (see ./runtime.ts), which older servers may omit.
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
export interface SessionEvent {
  type: "session";
  session_id: string;
  model?: string;
}
export interface EchoUserEvent {
  type: "echo_user";
  text: string;
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
  | SessionEvent
  | EchoUserEvent;

/** Any stored transcript line — same shape as a live ServerEvent. */
export type TranscriptEvent = ServerEvent;

/* ------------------------------------------------------------------ */
/* Client → Server messages                                           */
/* ------------------------------------------------------------------ */

export interface UserMessageMsg {
  type: "user_message";
  text: string;
  model?: string;
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
  models: { id: string; label: string }[];
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
  summary: string;
  scopes?: string[];
  secrets?: ConnectorSecret[];
  docs?: ConnectorDocs;
  team_instance?: ConnectorInstanceField[];
  instance?: Record<string, string>;
  status: string;
  team_enabled: boolean;
}
export interface ConnectorsResponse {
  connectors: Connector[];
}
export interface BlueprintResponse {
  ok: boolean;
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
