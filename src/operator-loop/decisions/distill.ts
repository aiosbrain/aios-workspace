// Decision distillation (AIO-192 / EE4) — derives reusable steering "mental models" from the
// decision corpus for HUMAN REVIEW (never auto-promoted). Pure + injectable: it takes a
// `CompletionFn` seam (llm.ts owns the only SDK import), so it is fully unit-testable offline with
// a fake `complete`. Three safety properties shape the code:
//   • Path-free projection: only { id, kind, question, options, choice, notes, contextTag,
//     createdAt } reaches `complete` — cwd/transcriptPath/project are stripped BEFORE any egress,
//     upholding the boundary's "projected content only" rule even for current-repo records.
//   • Scrubbed text: every FREE-TEXT field that DOES cross the boundary (question / header /
//     options / choice / notes) is run through `scrubPaths` first — an absolute filesystem path or
//     a `~/…` home path embedded in a decision's prose (which carries usernames / client dir names)
//     is replaced with a placeholder BEFORE egress, and the rendered draft is re-scanned so a
//     model echo can never smuggle one into the committed doc.
//   • Fail closed, no partial doc: the structured result is validated in the spec-eval mold and
//     every principle must cite >= minSupport record ids that EXIST in the corpus; ANY parse /
//     validation failure (or a surviving path in the rendered draft) THROWS (the CLI writes the
//     draft once, only after distill returns).

import type { Decision } from "./store.js";
import type { CompletionFn } from "../llm.js";

export const DEFAULT_MIN_SUPPORT = 3;

/** The path-free record shape handed to the model — no cwd / transcriptPath / project. */
export interface ProjectedDecision {
  id: string;
  kind: string;
  question: string;
  header: string | null;
  options: string[];
  choice: string[] | null;
  notes: string | null;
  contextTag: string | null;
  createdAt: string;
}

export interface DistilledPrinciple {
  title: string;
  principle: string;
  contexts: string[];
  evidence: string[]; // decision record ids (all verified to exist in the corpus)
}

export interface DistillOptions {
  records: Decision[];
  minSupport?: number;
  contextFilter?: string | null;
  complete: CompletionFn;
  maxTokens?: number;
}

export interface DistillResult {
  markdown: string;
  principles: DistilledPrinciple[];
  used: number; // corpus records sent to the model after filtering
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Absolute-filesystem-path patterns. A decision's PROSE (not just its stripped context fields) can
// quote a real path — `/Users/<name>/…`, `~/Projects/<client>/…`, a Windows `C:\Users\…` — which
// leaks a username or a client/engagement dir name. We redact these deterministically BEFORE the
// text crosses the LLM boundary and re-scan the rendered draft to catch any echo. Over-redaction
// (e.g. a stray `/api/v1` route) is acceptable in an admin→review DRAFT; under-redaction is not.
const PATH_PATTERNS: readonly RegExp[] = [
  /~\/[^\s"'`)\]}]+/g, // ~/foo/bar home-relative
  /\b[A-Za-z]:\\[^\s"'`)\]}]+/g, // C:\Users\... Windows
  /\/(?:[A-Za-z0-9._@+-]+\/){1,}[A-Za-z0-9._@+-]+/g, // /Users/x/... any 2+-segment POSIX path
];
export const PATH_PLACEHOLDER = "[redacted-path]";

/** Replace any absolute filesystem / home path in `text` with a placeholder. Null-safe. */
export function scrubPaths(text: string | null): string | null {
  if (text == null) return null;
  let out = text;
  for (const re of PATH_PATTERNS) out = out.replace(re, PATH_PLACEHOLDER);
  return out;
}

function scrubPathsRequired(text: string): string {
  return scrubPaths(text) as string;
}

/** True if `text` still contains a path pattern (used to fail-close the rendered draft). */
export function hasResidualPath(text: string): boolean {
  return PATH_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/**
 * Strip every path-bearing field, then SCRUB the free-text fields that remain — so no absolute
 * path in a decision's prose reaches `complete`. Keeps only what a mental-model draft needs.
 */
export function projectForDistill(records: readonly Decision[]): ProjectedDecision[] {
  return records.map((d) => ({
    id: d.id,
    kind: d.kind,
    question: scrubPathsRequired(d.question),
    header: scrubPaths(d.header),
    options: d.options.map((o) => scrubPathsRequired(o.label)),
    choice: d.choice ? d.choice.map(scrubPathsRequired) : null,
    notes: scrubPaths(d.notes),
    contextTag: d.contextTag,
    createdAt: d.createdAt,
  }));
}

const DISTILL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    principles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short name for the mental model." },
          principle: {
            type: "string",
            description: "The reusable steering rule, stated so a future agent could apply it.",
          },
          contexts: {
            type: "array",
            items: { type: "string" },
            description: "The contextTags this principle was observed in.",
          },
          evidence: {
            type: "array",
            items: { type: "string" },
            description: "Decision record ids (from the supplied corpus) that support this.",
          },
        },
        required: ["title", "principle", "evidence"],
      },
    },
  },
  required: ["principles"],
};

const SYSTEM = [
  "You distill a corpus of past human STEERING DECISIONS (questions an AI agent asked its operator,",
  "the options offered, and the choice made) into a small set of REUSABLE mental models — the",
  "operator's implicit standards, per the 'repeated 3x -> standard' rule.",
  "",
  "Rules:",
  "- Only emit a principle you can ground in AT LEAST the minimum number of DISTINCT decision ids",
  "  from the supplied corpus. Cite those ids verbatim in `evidence`.",
  "- Never invent an id. Never cite an id that is not in the corpus.",
  "- State each principle so a future agent could act on it without re-reading the transcripts.",
  "- Prefer a few high-support principles over many thin ones. If nothing repeats enough, emit none.",
  "- You are drafting for HUMAN REVIEW; do not overclaim.",
].join("\n");

function buildUser(projected: ProjectedDecision[], minSupport: number): string {
  return [
    `Minimum distinct supporting decision ids per principle: ${minSupport}.`,
    "",
    "Decision corpus (JSON):",
    JSON.stringify(projected),
  ].join("\n");
}

/** Render the validated principles to a DRAFT markdown doc (for human review, never auto-applied). */
export function renderDraft(principles: DistilledPrinciple[], meta: { used: number }): string {
  const lines: string[] = [];
  lines.push("# Decision principles — DRAFT — FOR HUMAN REVIEW");
  lines.push("");
  lines.push(
    "> Auto-distilled from the local steering-decision corpus (`aios decisions distill`). Nothing"
  );
  lines.push(
    "> here is authoritative. A human promotes accepted principles into `build-paradigm.md` or a"
  );
  lines.push("> rules file — the tool never does.");
  lines.push("");
  lines.push(`Drawn from ${meta.used} decision record(s).`);
  lines.push("");
  principles.forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.title}`);
    lines.push("");
    lines.push(p.principle);
    lines.push("");
    if (p.contexts.length) lines.push(`- **Contexts:** ${p.contexts.join(", ")}`);
    lines.push(`- **Evidence (${p.evidence.length}):** ${p.evidence.join(", ")}`);
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * Distill the corpus into reviewed-by-a-human mental models. Filters by contextTag when
 * `contextFilter` is set, projects to a path-free shape, calls `complete` for the structured
 * result, then fail-closes: throws on any parse/validation failure or an unsupported principle.
 */
export async function distill(opts: DistillOptions): Promise<DistillResult> {
  const minSupport = opts.minSupport ?? DEFAULT_MIN_SUPPORT;
  const filter = opts.contextFilter ?? null;
  const records = filter ? opts.records.filter((d) => d.contextTag === filter) : opts.records;
  if (records.length < minSupport) {
    throw new Error(
      `distill: corpus has ${records.length} record(s)` +
        (filter ? ` for context "${filter}"` : "") +
        ` — need at least ${minSupport} to distill a principle.`
    );
  }
  const projected = projectForDistill(records);
  const validIds = new Set(projected.map((p) => p.id));
  const tagById = new Map(projected.map((p) => [p.id, p.contextTag]));

  const out = await opts.complete({
    system: SYSTEM,
    user: buildUser(projected, minSupport),
    schema: DISTILL_SCHEMA,
    maxTokens: opts.maxTokens ?? 8000,
  });

  if (!isRecord(out) || !Array.isArray(out.principles)) {
    throw new Error("distill: model returned no principles array");
  }
  const principles: DistilledPrinciple[] = [];
  for (const p of out.principles) {
    if (!isRecord(p)) throw new Error("distill: a principle was not an object");
    const title = String(p.title ?? "").trim();
    const principle = String(p.principle ?? "").trim();
    if (!title || !principle) throw new Error("distill: a principle is missing title/statement");
    const evidence = Array.isArray(p.evidence)
      ? [
          ...new Set(
            p.evidence.filter((x): x is string => typeof x === "string" && validIds.has(x))
          ),
        ]
      : [];
    if (evidence.length < minSupport) {
      throw new Error(
        `distill: principle "${title}" cites ${evidence.length} valid corpus id(s) — need >= ${minSupport}.`
      );
    }
    // Contexts are DERIVED from the cited evidence records — never taken from the model (review
    // r2): a model-emitted context the citations don't support would mislead the human reviewer.
    const contexts = [
      ...new Set(evidence.map((id) => tagById.get(id)).filter((t): t is string => Boolean(t))),
    ].sort();
    principles.push({ title, principle, contexts, evidence });
  }
  if (!principles.length) throw new Error("distill: no principles survived validation");

  const markdown = renderDraft(principles, { used: records.length });
  // Defense in depth: even though egress was scrubbed, a model could echo a path it inferred. Refuse
  // to hand back a draft that still carries an absolute path — the CLI writes only what we return.
  if (hasResidualPath(markdown)) {
    throw new Error(
      "distill: rendered draft contains a residual filesystem path — refusing to emit."
    );
  }

  return { markdown, principles, used: records.length };
}
