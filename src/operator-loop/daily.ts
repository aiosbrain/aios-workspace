import { readAsks, type Ask } from "./asks/store.js";
import { readSnapshot, writeSnapshot, type ChangeType, type SnapshotStore } from "./changes.js";
import { collect } from "./collector.js";
import { buildDailyOrientation } from "./daily-classifier.js";
import { DAILY_SCOPE, STALE_CARRYOVER_DAYS } from "./daily-helpers.js";
import type { Audience } from "./ledger.js";
import type { RunManifest } from "./manifest.js";
import type { EvidenceRef, Tier } from "./signal.js";
import type { Exclusion } from "./sources/types.js";
import type { TagTotal } from "./time/runtime.js";

export { buildDailyOrientation, DAILY_SCOPE, STALE_CARRYOVER_DAYS };

export interface TranscriptReviewCounts {
  readonly pendingStages: number;
  readonly decisions: number;
  readonly tasks: number;
  readonly failedRubric: number;
  readonly gradingErrors: number;
  readonly unreadableStages: number;
}

export interface DailyItem {
  kind: string;
  summary: string;
  tier: Tier;
  ref: EvidenceRef;
  due?: string | null;
  stale?: number;
  changeType?: ChangeType;
}

export interface DailyOrientation {
  member: string;
  window: { cadence: "daily"; from: string; to: string };
  generatedAt: string;
  audience: Audience;
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
  excluded: Exclusion[];
  transcriptReview?: TranscriptReviewCounts;
}

export interface BuildDailyOptions {
  manifest: RunManifest;
  prior: SnapshotStore | null;
  audience?: Audience;
  staleDays?: number;
  asks?: readonly Ask[];
  transcriptReview?: TranscriptReviewCounts;
}

export interface RunDailyOptions {
  root: string;
  now?: Date;
  member?: string;
  audience?: Audience;
  staleDays?: number;
  record?: boolean;
  transcriptReview?: TranscriptReviewCounts;
}

export function runDaily(opts: RunDailyOptions): DailyOrientation {
  const audience: Audience = opts.audience ?? "owner";
  const prior = readSnapshot(opts.root, DAILY_SCOPE);
  const manifest = collect({
    root: opts.root,
    cadence: "daily",
    member: opts.member,
    now: opts.now,
    window: false,
  });
  let asks: readonly Ask[] = [];
  try {
    asks = readAsks(opts.root).asks;
  } catch {
    asks = [];
  }
  const { orientation, nextSnapshot } = buildDailyOrientation({
    manifest,
    prior,
    audience,
    staleDays: opts.staleDays,
    asks,
    transcriptReview: opts.transcriptReview,
  });
  if (audience === "owner" && opts.record !== false) {
    writeSnapshot(opts.root, nextSnapshot);
  }
  return orientation;
}
