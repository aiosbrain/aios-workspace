// Ambient typings for the shared AM1 read-side fold (see maturity-fold.mjs). Hand-written
// so the TypeScript operator-loop collector reuses the SAME fold the brief (AM2) and the
// weekly report (AM6) use — never a re-implementation.

import type { MaturitySession } from "./maturity-store.mjs";

export const STORE_SIZE_CAP: number;

export function projectSlug(cwd: string): string;

/** Fold same-project session records → the ratio signals placement() consumes. */
export function foldSignals(recent: MaturitySession[]): Record<string, number>;
