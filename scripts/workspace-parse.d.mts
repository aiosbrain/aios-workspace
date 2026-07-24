// Ambient typings so the TypeScript operator-loop collector can import the shared
// .mjs parsers under nodenext resolution. Hand-written (the .mjs is plain JS).

export type Frontmatter = Record<string, string | string[]>;

export const DECISION_SYNC_VERSION: number;

export function parseFrontmatter(content: string): {
  frontmatter: Frontmatter | null;
  body: string;
};

export function normalizeTier(tier: string): string;

export function classifyKind(rel: string, frontmatter: Frontmatter | null): string;

export interface DecisionRow {
  row_key: string;
  decided_at: string | null;
  title: string;
  rationale: string;
  decided_by: string;
  impact: string;
  tier: number | null;
  audience: string | null;
}

export function parseDecisionRows(body: string): DecisionRow[];

export function redactAdminDecisionRows(body: string): {
  body: string;
  rows: DecisionRow[];
  redacted: number;
};
