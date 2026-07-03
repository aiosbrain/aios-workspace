/**
 * decision-extract.mjs — reconstruct steering-decision records from a Claude session transcript.
 *
 * The factored-out, transport-agnostic equivalent of the capture hook's embedded extractor
 * (hooks/decision-capture.mjs). The hook KEEPS its own copy (EE1/EE4 posture: a hook never imports
 * a repo module, because `dist` may be unbuilt when it fires); this module serves the OFFLINE
 * `aios decisions backfill` path over already-recorded transcripts. Its `question` / `header` /
 * `options` / `choice` / `notes` construction is byte-identical to the hook so a hook-captured
 * moment and a backfilled one fold to equivalent records (a parity test proves it).
 *
 * Pure + dependency-free (node:path only): it does NO path I/O and fills only
 * `context.sessionId` + `source:"backfill"` + `createdAt` (from the transcript timestamp). The CLI
 * fills / redacts cwd / transcriptPath / project / contextTag per the origin policy.
 */

import path from "node:path";

const QUESTION_MAX = 500;
const HEADER_MAX = 200;
const NOTES_MAX = 2000;
const OPTION_LABEL_MAX = 200;
const OPTION_DESC_MAX = 1000;
const OPTIONS_MAX = 50;
const CHOICE_MAX = 50;

// eslint-disable-next-line no-control-regex -- intentional: collapse control chars in single-line fields
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]+", "g");

function singleLine(raw, max) {
  return String(raw ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
function multiline(raw, max) {
  return String(raw ?? "").slice(0, max);
}
function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// ── defensive answer extraction (mirrors the hook) ─────────────────────────────────────────────

function collectFromValue(value) {
  const labels = [];
  let notes = null;
  const visit = (x, depth) => {
    if (x == null || depth > 6) return;
    if (typeof x === "string") {
      const s = x.trim();
      if (s) labels.push(s);
      return;
    }
    if (Array.isArray(x)) {
      for (const el of x) visit(el, depth + 1);
      return;
    }
    if (typeof x === "object") {
      // deliberately NOT recursing into `options` — echoed option lists would inflate choice.
      for (const k of [
        "label",
        "answer",
        "selected",
        "selectedOption",
        "choice",
        "value",
        "option",
      ]) {
        if (k in x) visit(x[k], depth + 1);
      }
      for (const k of ["notes", "note", "other", "freeText", "free_text", "text", "comment"]) {
        if (typeof x[k] === "string" && x[k].trim() && !notes) notes = x[k].trim();
      }
    }
  };
  visit(value, 0);
  return { labels, notes };
}

function findAnswer(
  container,
  { rawQuestion, normQuestion, rawHeader, normHeader, headerUnique, index }
) {
  if (container == null) return undefined;
  if (Array.isArray(container)) {
    for (const el of container) {
      if (el && typeof el === "object" && typeof el.question === "string") {
        if (el.question === rawQuestion || singleLine(el.question, QUESTION_MAX) === normQuestion)
          return el;
      }
    }
    if (headerUnique && normHeader) {
      for (const el of container) {
        if (el && typeof el === "object" && typeof el.header === "string") {
          if (el.header === rawHeader || singleLine(el.header, HEADER_MAX) === normHeader)
            return el;
        }
      }
    }
    if (index != null && index < container.length) return container[index];
    return undefined;
  }
  if (typeof container === "object") {
    if (rawQuestion && rawQuestion in container) return container[rawQuestion];
    for (const key of Object.keys(container)) {
      if (singleLine(key, QUESTION_MAX) === normQuestion) return container[key];
    }
    if (headerUnique && rawHeader) {
      if (rawHeader in container) return container[rawHeader];
      for (const key of Object.keys(container)) {
        if (singleLine(key, HEADER_MAX) === normHeader) return container[key];
      }
    }
  }
  return undefined;
}

function normalizeOptions(rawOptions) {
  if (!Array.isArray(rawOptions)) return [];
  const out = [];
  for (const o of rawOptions.slice(0, OPTIONS_MAX)) {
    if (!o || typeof o !== "object") continue;
    const label = singleLine(o.label, OPTION_LABEL_MAX);
    if (!label) continue;
    const description =
      o.description == null ? null : multiline(o.description, OPTION_DESC_MAX) || null;
    out.push({ label, description });
  }
  return out;
}

function normalizeChoiceLabels(labels) {
  const out = [];
  for (const l of labels.slice(0, CHOICE_MAX)) {
    const s = singleLine(l, OPTION_LABEL_MAX);
    if (s) out.push(s);
  }
  return out.length ? out : null;
}

function mkInput(ctx, fields) {
  return {
    kind: "decision",
    question: "",
    header: null,
    options: [],
    choice: null,
    notes: null,
    context: { sessionId: ctx.sessionId ?? null },
    source: "backfill",
    ...(ctx.createdAt ? { createdAt: ctx.createdAt } : {}),
    ...fields,
  };
}

// ── AskUserQuestion → one DecisionInput per question (mirrors handleAskUserQuestion) ───────────

function askInputs(input, response, ctx) {
  if (!isObj(input) || !Array.isArray(input.questions)) return [];
  const responseObj =
    response && typeof response === "object" && !Array.isArray(response) ? response : null;
  const answerContainers = [
    input.answers,
    responseObj?.answers,
    Array.isArray(response) ? response : undefined,
    responseObj?.response,
    responseObj,
  ];

  const headerCounts = new Map();
  for (const q of input.questions) {
    if (q && typeof q === "object" && q.header != null) {
      const h = singleLine(q.header, HEADER_MAX);
      if (h) headerCounts.set(h, (headerCounts.get(h) ?? 0) + 1);
    }
  }

  const inputs = [];
  input.questions.forEach((q, i) => {
    if (!q || typeof q !== "object") return;
    const questionText = singleLine(q.question, QUESTION_MAX);
    if (!questionText) return;
    const header = q.header == null ? null : singleLine(q.header, HEADER_MAX) || null;
    const options = normalizeOptions(q.options);
    const headerUnique = header != null && headerCounts.get(header) === 1;

    let labels = [];
    let notes = null;
    for (const container of answerContainers) {
      const value = findAnswer(container, {
        rawQuestion: typeof q.question === "string" ? q.question : null,
        normQuestion: questionText,
        rawHeader: typeof q.header === "string" ? q.header : null,
        normHeader: header,
        headerUnique,
        index: i,
      });
      if (value === undefined) continue;
      const collected = collectFromValue(value);
      if (collected.labels.length || collected.notes) {
        labels = collected.labels;
        notes = collected.notes;
        break;
      }
    }
    if (!labels.length && typeof response === "string" && input.questions.length === 1) {
      const s = singleLine(response, OPTION_LABEL_MAX);
      if (s) labels = [s];
    }

    inputs.push(
      mkInput(ctx, {
        kind: "ask-user-question",
        question: questionText,
        header,
        options,
        choice: normalizeChoiceLabels(labels),
        notes: notes ? multiline(notes, NOTES_MAX) : null,
      })
    );
  });
  return inputs;
}

// ── ExitPlanMode → one plan-approval DecisionInput (mirrors handleExitPlanMode) ────────────────

function responseToText(response) {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response)) {
    return response
      .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof response === "object") {
    for (const k of ["text", "response", "message", "output", "result"]) {
      if (typeof response[k] === "string") return response[k];
    }
    if (Array.isArray(response.content)) return responseToText(response.content);
    if (typeof response.content === "string") return response.content;
  }
  return "";
}

function planTitle(input) {
  const plan =
    input && typeof input === "object" && typeof input.plan === "string" ? input.plan : "";
  for (const line of plan.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return singleLine(t, QUESTION_MAX - 16);
  }
  return "";
}

function planInput(input, response, ctx) {
  const title = planTitle(input);
  const question = title ? `Plan approval: ${title}` : "Plan approval";
  const text = responseToText(response).trim();

  let choice = null;
  let notes = null;
  if (text) {
    if (/rejected|doesn'?t want to proceed|not approved|denied/i.test(text)) {
      choice = ["rejected"];
      notes = text;
    } else if (
      /\bhas approved\b|\bapproved your plan\b|\bplan (?:was |is )?approved\b/i.test(text)
    ) {
      choice = ["approved"];
    } else {
      notes = text;
    }
  }

  return mkInput(ctx, {
    kind: "plan-approval",
    question: singleLine(question, QUESTION_MAX),
    choice,
    notes: notes ? multiline(notes, NOTES_MAX) : null,
  });
}

// ── session pairing + extraction ───────────────────────────────────────────────────────────────

const TARGET_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * Extract every steering decision from ONE session's ordered, already-parsed record array.
 *
 * Pairs each assistant `tool_use` (AskUserQuestion / ExitPlanMode) with the `tool_result` that
 * carries the same `tool_use_id`, anywhere later in the session. An unpaired tool_use (no result —
 * e.g. the session ended mid-question) still yields records with `choice:null` and is counted in
 * `stats.unpaired`.
 *
 * @param {object[]} records  one session's JSONL records, in order
 * @returns {{ decisions: object[], stats: { unpaired: number } }}  DecisionInput[] + stats. The
 *   explicit stats side-channel is intentional (a Round-1 review fix) — the CLI report reads
 *   stats.unpaired directly; do NOT collapse it to a bare array.
 */
export function extractDecisions(records) {
  const list = Array.isArray(records) ? records : [];

  // tool_use_id -> the tool's response. A Claude tool-result record carries the block's own
  // `content` AND (usually) a structured `toolUseResult`; prefer the latter when present, since it
  // holds the answer object the hook reads from `tool_response`. Falls back to the block content.
  const resultById = new Map();
  for (const r of list) {
    if (!isObj(r) || r.type !== "user") continue;
    const msg = r.message;
    const content = isObj(msg) && Array.isArray(msg.content) ? msg.content : [];
    for (const b of content) {
      if (b && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        resultById.set(b.tool_use_id, r.toolUseResult !== undefined ? r.toolUseResult : b.content);
      }
    }
  }

  const decisions = [];
  let unpaired = 0;
  for (const r of list) {
    if (!isObj(r) || r.type !== "assistant") continue;
    const msg = r.message;
    if (!isObj(msg) || msg.role !== "assistant") continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const ctx = {
      sessionId: typeof r.sessionId === "string" ? r.sessionId : null,
      createdAt: typeof r.timestamp === "string" ? r.timestamp : undefined,
    };
    for (const b of content) {
      if (!b || b.type !== "tool_use" || !TARGET_TOOLS.has(b.name)) continue;
      const paired = typeof b.id === "string" && resultById.has(b.id);
      const response = paired ? resultById.get(b.id) : undefined;
      const built =
        b.name === "AskUserQuestion"
          ? askInputs(b.input, response, ctx)
          : [planInput(b.input, response, ctx)];
      for (const d of built) decisions.push(d);
      if (!paired) unpaired += built.length;
    }
  }
  return { decisions, stats: { unpaired } };
}

// ── context tagging ─────────────────────────────────────────────────────────────────────────────

const ANCHOR_TAGS = {
  "john-workspace": "workspace",
  "personal-life": "personal",
};

/**
 * The situational category for a repo root: the first path segment under `$HOME/Projects`,
 * lowercased, with the two anchor renames. The filesystem is the truth — no tessera.yaml parsing.
 * A root outside `$HOME/Projects` → "unknown".
 */
export function contextTagFor(repoRoot, home) {
  const base = path.join(home, "Projects");
  const rel = path.relative(base, repoRoot);
  if (!rel || rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return "unknown";
  const first = rel.split(path.sep)[0].toLowerCase();
  if (!first) return "unknown";
  return ANCHOR_TAGS[first] ?? first;
}
