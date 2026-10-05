export interface Capabilities {
  mode: string;
  width: number;
  colorDepth: number;
  motion: boolean;
  glyphs: string;
  background: string;
  tier: string;
}
export type Status = "success" | "error" | "warning" | "info" | "pending";
export interface Option {
  value: string;
  label: string;
  hint?: string;
}
export interface Prompt {
  kind: "select" | "multiselect" | "password" | "text";
  message: string;
  options?: Option[];
  initialValue?: string;
  initialValues?: string[];
  placeholder?: string;
}
export interface ReportItem {
  rel: string;
  kind?: string;
  tier?: string;
  reason?: string;
}
export interface StatusReport {
  project: string;
  destination: string;
  fresh: ReportItem[];
  modified: ReportItem[];
  held: ReportItem[];
  clean: number;
}
export interface ProgressEvent {
  label: string;
  completed?: number;
  total?: number;
}
export type Tone = "heading" | "accent" | "info" | "success" | "warning" | "error" | "muted";
export interface AnalyzeAxis {
  label: string;
  score: number;
  scoreText: string;
  gloss: string;
  note: string | null;
}
export interface CostRow {
  label?: string;
  amount?: string;
  basis?: string;
  note?: string;
  tone?: Tone;
}
export interface AnalyzeView {
  window: { since: string; until: string };
  tools: string[];
  totals: { sessions: string; tasks: string; tokens: string };
  spine: { level: string; gloss: string; overall: number; overallText: string };
  axes: AnalyzeAxis[];
  ergonomics: { label: string; band: number | null; trend: string | null; note: string };
  trend: { days: number; am: (number | null)[]; ce: (number | null)[] } | null;
  attention: { reading: string; metrics: [string, string][] };
  contextHealth: {
    score: number;
    reading: string;
    failing: { label: string; kind: string }[];
  } | null;
  codebaseHealth: { status: string; reading: string; tip: string | null } | null;
  opportunity: { label: string; gloss: string; step: string };
  ergonomicsTip: string | null;
  hints: string[];
  cost: {
    window: { since: string; until: string };
    real: CostRow[];
    estimates: CostRow[];
    note: string | null;
    legend: string;
  } | null;
  deepDive: {
    label: string;
    score: number;
    scoreText: string;
    meaning: string;
    why: string;
    where: string;
    steps: string[];
    others: { label: string; score: number; scoreText: string; stat: string }[];
    contextHealth: { reading: string; tip: string | null } | null;
  } | null;
}
export interface ContextHealthView {
  target: string;
  mode: string;
  score: number;
  summary: string;
  checks: { id: string; label: string; kind: string; ok: boolean; detail: string }[];
}
export interface CodebaseHealthView {
  target: string;
  mode: string;
  status: string;
  summary: string;
  axes: {
    label: string;
    band: number | null;
    passed: number;
    total: number;
    evidence: string;
  }[];
  checks: {
    title: string;
    ok: boolean;
    skipped: boolean;
    evidence: string;
    required: boolean;
    detail: string;
  }[];
  nextMoves: {
    axis: string;
    metric: string;
    current: unknown;
    neededValue: unknown;
    currentBand: unknown;
    neededBand: unknown;
  }[];
}
