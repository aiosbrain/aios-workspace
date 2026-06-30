// GitHub source — DEFERRED (resolved open-question Q2). The C1 spec lists "already-landed
// GitHub activity (AIO-32)" as a source, but AIO-32 is a brain/dashboard integration, not a
// local workspace signal source; there is no local GitHub work-event source today. This stub
// documents the seam and is intentionally NOT in the collector's active source set, so the
// acceptance criteria / rubric do not require it. A likely future local source is the
// workspace's own git history — out of scope for C1/C2.

import type { Source, SourceResult } from "./types.js";

export const githubSource: Source = (): SourceResult => {
  return { signals: [], excluded: [] };
};
