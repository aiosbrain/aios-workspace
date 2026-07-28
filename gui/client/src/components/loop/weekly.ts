/**
 * Weekly closeout — the grouping model behind the Operator Loop's owner brief.
 *
 * The C5 brief is a deterministic markdown document composed locally from the evidence ledger:
 * one bullet per signal, all under a single `## The honest picture` heading. Rendering that
 * verbatim is what made the tab unreadable — a real workspace produced a 725-line flat list in
 * which decisions, deliverables, meetings and emails all looked identical, and 289 of the lines
 * were mirrored commit rows. The document is honest; the presentation was not.
 *
 * This module reads the brief back into structure. It is a PARSER, not a second source of truth:
 * every group and count here is derived from the brief's own text, so what the panel shows can
 * never drift from the artifact on disk. The drafter now folds the commit mirror out at
 * generation time (see closeout.ts), but briefs written before that fix still carry it — so the
 * mirror group stays, collapsed, rather than pretending old briefs are clean.
 *
 * All pure, so it tests without a DOM or a server:
 *   • parseBriefHeader   — member, window, verifier status, per-tier signal counts
 *   • classifyBriefItem  — evidence path → group (path first; text only as a tiebreak)
 *   • parseBrief         — the whole document → header + ordered groups + next-week actions
 */

/** Item classes, in display order. Declaration order IS the order groups render in. */
export const WEEKLY_GROUPS = [
  "decision",
  "work",
  "reply",
  "meeting",
  "task",
  "brain",
  "context",
  "mirror",
  "other",
] as const;
export type WeeklyGroup = (typeof WEEKLY_GROUPS)[number];

export const GROUP_LABEL: Record<WeeklyGroup, string> = {
  decision: "Decisions",
  work: "Work",
  reply: "Needs reply",
  meeting: "Meetings",
  task: "Tasks",
  brain: "From the brain",
  context: "Context",
  mirror: "Commit mirror",
  other: "Other signals",
};

/** Why a group exists, shown inline — the audit tabs earned their explanations the same way. */
export const GROUP_HINT: Record<WeeklyGroup, string> = {
  decision: "Decisions recorded in the decision log this week.",
  work: "Deliverables and working documents touched this week.",
  reply: "Email the loop saw waiting on a reply from you.",
  meeting: "Calendar events inside the closeout window.",
  task: "Task rows that moved, or are still owed.",
  brain: "Pulled into your inbox from the Team Brain.",
  context: "Charter, role, shared and personal spine files that changed.",
  mirror: "Per-commit files mirrored from the brain. Machine feed, not a claim about your week.",
  other: "Signals that carry evidence but no recognised spine location.",
};

/**
 * Groups that open collapsed: high-volume feeds you RECEIVED, not work you owe.
 *
 * Measured against a real brief: decisions 13, work 8, needs-reply 24, meetings 17 — but
 * from-brain pulls 326 and the commit mirror 289. Expanding the last two buries the first four,
 * which is the whole defect. Collapsed still means present and counted, one click away.
 */
const COLLAPSED_BY_DEFAULT: ReadonlySet<WeeklyGroup> = new Set<WeeklyGroup>([
  "brain",
  "mirror",
  "context",
  "other",
]);

export interface WeeklyItem {
  /** Stable across re-renders: group + title. */
  key: string;
  group: WeeklyGroup;
  title: string;
  /** Evidence paths the claim cited, in the order the brief listed them. */
  evidence: string[];
  /** `Type-1` / `Type-2` when the decision log tagged it; the brief carries it inline. */
  decisionType: string | null;
}

export interface WeeklyGroupBlock {
  group: WeeklyGroup;
  label: string;
  hint: string;
  items: WeeklyItem[];
  defaultOpen: boolean;
}

export interface WeeklyHeader {
  member: string | null;
  from: string | null;
  to: string | null;
  /** `PASS` | `CORRECTED` | `FAILED` — the C3 verifier's badge, as the brief printed it. */
  verifier: string | null;
  tierCounts: Array<{ tier: string; count: number }>;
  /** Commit signals the drafter folded out, when the brief reports a fold. */
  foldedCommits: number;
}

export interface WeeklyNextAction {
  key: string;
  tier: string | null;
  title: string;
}

export interface ParsedBrief {
  header: WeeklyHeader;
  groups: WeeklyGroupBlock[];
  nextWeek: WeeklyNextAction[];
  /** Total claim bullets parsed — proves the view accounts for the whole document. */
  itemCount: number;
}

const ITEM_RE = /^-\s+(.*)$/;
const EVIDENCE_RE = /\s*_\(evidence:\s*([^)]*)\)_\s*$/;
const DECISION_TYPE_RE = /\s*\[(Type-\d+)\]\s*/;

/**
 * Parse the brief's header block.
 *
 * Shape (see `renderBrief` in src/operator-loop/closeout.ts):
 *   # Private operator brief — <member>
 *   _<from> → <to> · verifier: <BADGE> · signals <tier>:<n>  <tier>:<n>_
 */
export function parseBriefHeader(markdown: string): WeeklyHeader {
  const member = markdown.match(/^#\s+Private operator brief\s+—\s+(.+)$/m)?.[1]?.trim() ?? null;
  const meta = markdown.match(/^_(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})\s*·\s*(.*)_$/m);
  const rest = meta?.[3] ?? "";
  const verifier = rest.match(/verifier:\s*([A-Z]+)/)?.[1] ?? null;
  const tierCounts: Array<{ tier: string; count: number }> = [];
  const signals = rest.match(/signals\s+(.*)$/)?.[1] ?? "";
  for (const m of signals.matchAll(/([a-z]+):(\d+)/g)) {
    tierCounts.push({ tier: m[1], count: Number(m[2]) });
  }
  const folded = markdown.match(/_(\d+) mirrored commit signal\(s\) folded out of this picture\._/);
  return {
    member,
    from: meta?.[1] ?? null,
    to: meta?.[2] ?? null,
    verifier,
    tierCounts,
    foldedCommits: folded ? Number(folded[1]) : 0,
  };
}

/**
 * Map a claim to its group.
 *
 * Evidence path decides, because it is structural — the workspace spine and the loop's own comms
 * store are stable locations, whereas claim TEXT is free-form prose written by whoever wrote the
 * source row. Text is consulted only for the decision tag, and only to promote (never demote) a
 * claim that already cites the decision log.
 */
export function classifyBriefItem(evidence: readonly string[], title: string): WeeklyGroup {
  const paths = evidence.map((p) => p.trim()).filter(Boolean);
  const has = (pred: (p: string) => boolean) => paths.some(pred);

  // Provenance is settled BEFORE shape. Everything under from-brain/ was pulled from the Team
  // Brain, so a mirrored copy of somebody else's `decision-log.md` is a brain artefact, not a
  // decision this operator took this week — filename-first ordering put those in Decisions beside
  // John's own, which is exactly the conflation this group split exists to prevent. The commit
  // mirror is split out of the brain group first because volume alone makes it a separate class.
  if (has((p) => /from-brain\/commits__/.test(p) || /\/commits\//.test(p))) return "mirror";
  if (has((p) => /from-brain\//.test(p))) return "brain";
  if (has((p) => /decision-log/.test(p))) return "decision";
  if (has((p) => /loop\/comms\/email\//.test(p))) return "reply";
  if (has((p) => /loop\/comms\/calendar\//.test(p))) return "meeting";
  if (has((p) => /(^|\/)tasks(-[a-z]+)?\.md$/.test(p))) return "task";
  if (has((p) => /(^|\/)2-work\//.test(p))) return "work";
  if (has((p) => /(^|\/)1-inbox\//.test(p))) return "brain";
  if (has((p) => /(^|\/)(0-context|3-log|4-shared|5-personal|6-business)\//.test(p)))
    return "context";
  // A [Type-N] tag is the decision log's own marker; trust it when no path matched.
  if (DECISION_TYPE_RE.test(title)) return "decision";
  return "other";
}

/**
 * True for a bullet that carries no information: horizontal rules the drafter emitted for
 * untitled sources, bare filenames, and empty stubs. Dropping these is the one place this parser
 * discards content — everything else is regrouped, never hidden.
 */
function isNoise(title: string, evidence: readonly string[]): boolean {
  const t = title.trim();
  if (!t || /^-{2,}$/.test(t)) return true;
  // A bare "@AGENTS.md"-style fragment with no evidence tells the operator nothing.
  return evidence.length === 0 && t.length <= 2;
}

function parseItemLine(line: string): { title: string; evidence: string[] } | null {
  const m = line.match(ITEM_RE);
  if (!m) return null;
  let body = m[1];
  const ev = body.match(EVIDENCE_RE);
  const evidence = ev
    ? ev[1]
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  if (ev) body = body.slice(0, ev.index).trimEnd();
  return { title: body.trim(), evidence };
}

/** Strip the markdown emphasis the decision rows carry so titles read as plain text. */
export function plainTitle(raw: string): string {
  return raw
    .replace(DECISION_TYPE_RE, " ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Split the document into its `##` sections, keyed by heading text. */
function sectionsOf(markdown: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = "";
  for (const line of markdown.split("\n")) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      current = h[1].trim();
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    if (current) out.get(current)?.push(line);
  }
  return out;
}

/** Parse `## Next week`: `- [tier] title — rationale`, or the empty-state sentence. */
function parseNextWeek(lines: readonly string[]): WeeklyNextAction[] {
  const out: WeeklyNextAction[] = [];
  for (const line of lines) {
    const parsed = parseItemLine(line);
    if (!parsed || !parsed.title) continue;
    const tiered = parsed.title.match(/^\[([a-z]+)\]\s*(.*)$/);
    const title = plainTitle(tiered ? tiered[2] : parsed.title);
    if (!title) continue;
    out.push({ key: `next:${out.length}:${title}`, tier: tiered?.[1] ?? null, title });
  }
  return out;
}

/** Parse a whole owner brief into the structure the panel renders. */
export function parseBrief(markdown: string): ParsedBrief {
  const header = parseBriefHeader(markdown);
  const sections = sectionsOf(markdown);

  const byGroup = new Map<WeeklyGroup, WeeklyItem[]>();
  const seen = new Set<string>();
  let itemCount = 0;

  for (const line of sections.get("The honest picture") ?? []) {
    const parsed = parseItemLine(line);
    if (!parsed || isNoise(parsed.title, parsed.evidence)) continue;
    const group = classifyBriefItem(parsed.evidence, parsed.title);
    const decisionType = parsed.title.match(DECISION_TYPE_RE)?.[1] ?? null;
    const title = plainTitle(parsed.title);
    if (!title) continue;
    const key = `${group}:${title}`;
    // The ledger can cite the same claim from two sources; one row is the honest presentation.
    if (seen.has(key)) continue;
    seen.add(key);
    itemCount++;
    const list = byGroup.get(group) ?? [];
    list.push({ key, group, title, evidence: parsed.evidence, decisionType });
    byGroup.set(group, list);
  }

  const groups: WeeklyGroupBlock[] = WEEKLY_GROUPS.filter(
    (g) => (byGroup.get(g)?.length ?? 0) > 0
  ).map((group) => ({
    group,
    label: GROUP_LABEL[group],
    hint: GROUP_HINT[group],
    items: byGroup.get(group) ?? [],
    defaultOpen: !COLLAPSED_BY_DEFAULT.has(group),
  }));

  return {
    header,
    groups,
    nextWeek: parseNextWeek(sections.get("Next week") ?? []),
    itemCount,
  };
}

/**
 * The prompt handed to the chat agent when the operator picks "Ask" on a brief row. Carries the
 * evidence refs so the agent opens the source instead of guessing — same contract as the Today
 * queue's `askPromptFor`.
 */
export function askPromptForItem(item: WeeklyItem): string {
  const where = item.evidence.length ? item.evidence.join(", ") : "(no evidence ref)";
  return `From my weekly closeout (${GROUP_LABEL[item.group].toLowerCase()}): "${item.title}"\nEvidence: ${where}\n\nGive me the context on this and what you'd suggest I do about it.`;
}
