// Spine resolver — maps the workspace's numbered folder spine, supporting BOTH the current
// layout (0-context/1-inbox/2-work/3-log) and the legacy one (00-engagement/01-intake/
// 02-deliverables/03-status). Mirrors the spine-agnostic contract of classifyKind so the
// collector reads either shape. Returns the actual existing directory name per slot, or null.

import { existsSync } from "node:fs";
import path from "node:path";

export interface Spine {
  root: string;
  context: string | null; // 0-context  | 00-engagement | 00-context
  inbox: string | null; // 1-inbox    | 01-intake
  work: string | null; // 2-work     | 02-deliverables
  log: string | null; // 3-log      | 03-status
}

const CANDIDATES = {
  context: ["0-context", "00-engagement", "00-context"],
  inbox: ["1-inbox", "01-intake"],
  work: ["2-work", "02-deliverables"],
  log: ["3-log", "03-status"],
} as const;

function firstExisting(root: string, names: readonly string[]): string | null {
  for (const n of names) {
    if (existsSync(path.join(root, n))) return n;
  }
  return null;
}

export function resolveSpine(root: string): Spine {
  return {
    root,
    context: firstExisting(root, CANDIDATES.context),
    inbox: firstExisting(root, CANDIDATES.inbox),
    work: firstExisting(root, CANDIDATES.work),
    log: firstExisting(root, CANDIDATES.log),
  };
}
