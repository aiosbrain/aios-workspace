// Shared shape for every source. A source reads one slice of the workspace and returns
// the signals it found plus a default-deny exclusion log (entries with no resolvable tier).

import type { Spine } from "../spine.js";
import type { Signal } from "../signal.js";

export interface SourceContext {
  root: string;
  spine: Spine;
  member: string;
}

export interface Exclusion {
  ref: string;
  reason: string;
}

export interface SourceResult {
  signals: Signal[];
  excluded: Exclusion[];
}

export type Source = (ctx: SourceContext) => SourceResult;
