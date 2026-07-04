// Ambient typings so the TypeScript operator-loop collector can import the AM1 maturity
// store fold under nodenext resolution. Hand-written (the .mjs is plain JS); declares only
// the read-side surface the collector consumes.

/** One folded per-session AEM snapshot (written by hooks/maturity-capture.mjs). */
export interface MaturitySession {
  session_id: string;
  tool?: string;
  project?: string;
  ended_at?: string;
  event_count?: number;
  signals?: Record<string, number>;
  counts?: Record<string, unknown>;
  tier?: string;
  captured_at?: string;
}

export const STORE_REL: string;
export const SCHEMA_VERSION: number;

export function storePath(root: string): string;

export function foldSessions(ndjsonText: string): {
  sessions: Map<string, MaturitySession>;
  warnings: number;
};

export function appendSession(root: string, session: MaturitySession): boolean;
