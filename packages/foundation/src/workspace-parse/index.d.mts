// Ambient typings so the TypeScript operator-loop collector can import the shared
// .mjs parsers under nodenext resolution. Hand-written (the .mjs is plain JS).

export type Frontmatter = Record<string, string | string[]>;

export function parseFrontmatter(content: string): {
  frontmatter: Frontmatter | null;
  body: string;
};

export function normalizeTier(tier: string): string;

export function classifyKind(rel: string, frontmatter: Frontmatter | null): string;
export function isCanonicalEvidencePath(kind: unknown, rel: string): boolean;
export function validEvidenceDeclaration(
  rel: string,
  declaredKind: unknown,
  declaredAccess: unknown
): boolean;
export function evidencePayloadContent(
  kind: string,
  frontmatter: Frontmatter,
  body: string
): { frontmatter: Frontmatter; body: string };

export interface FactRow {
  row_key: string;
  title: string;
  occurred_at?: string;
  fact_type: "fact" | "event";
  source_path: string;
  source_quote: string;
}

export interface StakeholderMentionRow {
  row_key: string;
  name: string;
  role?: string;
  context?: string;
  source_path: string;
  source_quote: string;
}

export function parseFactRows(body: string): FactRow[];
export function parseStakeholderMentionRows(body: string): StakeholderMentionRow[];
export function parseEvidenceRows(
  kind: string,
  body: string
): FactRow[] | StakeholderMentionRow[] | DecisionRow[] | undefined;
export function validateItemPayload(input: unknown): { success: boolean };

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

export interface DecisionTableSchema {
  isDecision: boolean;
  valid: boolean;
  columnCount: number;
  header: string[];
  headerIndex: number;
  encoded: boolean;
  decisionIdx: number;
  audienceIdx: number;
  columns: Record<keyof DecisionRow, number>;
}
export type DecisionTableLine =
  | { index: number; kind: "other" }
  | { index: number; kind: "separator"; schema: DecisionTableSchema | null }
  | { index: number; kind: "header"; cells: string[]; schema: DecisionTableSchema }
  | { index: number; kind: "row"; cells: string[]; schema: DecisionTableSchema; row: DecisionRow | null; endsTable?: boolean };
export function classifyDecisionTableLines(body: string, fallbackAudience?: string | null): DecisionTableLine[];
export function parseDecisionRows(body: string): DecisionRow[];

export const DECISION_CELL_MARKER: string;
export function encodeTableCell(value: unknown): string;
export function decodeTableCell(value: string): string;
