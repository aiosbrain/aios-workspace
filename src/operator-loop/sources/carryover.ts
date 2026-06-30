// Carry-over source — C7 seam. Prior-run unresolved actions (owed items not yet closed)
// surface forward into the next run so the weekly closeout is assembly, not archaeology.
// V1 ships the seam only; the continuity store is implemented in C7 (AIO-126). Until then
// it emits nothing, so daily/weekly behave correctly with no carry-over yet.

import type { Source, SourceResult } from "./types.js";

export const carryoverSource: Source = (): SourceResult => {
  return { signals: [], excluded: [] };
};
