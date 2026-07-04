// Timeline (AIO-203) — public API barrel. Loaded by scripts/aios.mjs from dist/timeline/index.js.

export type {
  Audience,
  TimelineRepoConfig,
  TimelinePr,
  TimelineCommit,
  TimelineRepoResult,
  TimelineData,
} from "./types.js";
export { prToSignal, commitToSignal, toSignals } from "./types.js";
export {
  TIMELINE_CONFIG_REL,
  loadTimelineConfig,
  parseTimelineConfig,
  resolveRepos,
} from "./config.js";
export type { TimelineConfig } from "./config.js";
export { execRunner, loginFromEmail, collectRepo, collectTimeline } from "./collect.js";
export type { Runner } from "./collect.js";
export { fetchBrainMembers, resolveAvatarUrl } from "./avatars.js";
export type { BrainMember, BrainOpts, AvatarSubject, FetchLike } from "./avatars.js";
export {
  extractPreviewUrl,
  resolveShotTarget,
  captureShot,
  closeShotSession,
} from "./screenshot.js";
export type { ShotTarget, CaptureResult } from "./screenshot.js";
export {
  contributorKey,
  prKey,
  tiersForAudience,
  filterForAudience,
  escapeHtml,
  initialsAvatarDataUri,
  renderTimeline,
} from "./render.js";
export type { RenderAssets } from "./render.js";
