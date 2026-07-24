// 1.12 evidence kinds (fact, stakeholder_mention). These ride in the same v2 stage as decisions and
// tasks and are applied under the same apply/push lock, but they are grounded-only (deterministic
// verbatim source-quote verification) rather than rubric-graded, and are deliberately excluded from
// the reviewDigest (which stays pinned to the decision/task review payload). Evidence integrity comes
// from draft-time grounding against the transcript plus the 0o600 private staging directory; the push
// side re-validates rows and tier-blocks admin/private evidence independently.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { TranscriptReviewError } from "./errors.js";
import type {
  EvidenceAccess,
  EvidenceBatch,
  FactCandidate,
  StakeholderMentionCandidate,
} from "./models.js";
import { arrayValue, literal, optionalString, record, stringValue } from "./parse.js";
import { atomicReplace } from "./stage-store.js";
import { canonicalRoot, resolveExistingWorkspaceFile } from "./workspace.js";

const EVIDENCE_ACCESS = ["admin", "team", "external"] as const;
const ROW_KEY = /^(?:fact|stakeholder)-[a-f0-9]{16}$/;

const FILES = {
  fact: {
    admin: "3-log/facts-private.md",
    team: "3-log/facts-team.md",
    external: "4-shared/facts.md",
  },
  stakeholder_mention: {
    admin: "3-log/stakeholder-mentions-private.md",
    team: "3-log/stakeholder-mentions-team.md",
    external: "4-shared/stakeholder-mentions.md",
  },
} as const;

const HEADERS = {
  fact:
    "| Row Key | Fact | Occurred At | Type | Source Path | Source Quote |\n" +
    "|---|---|---|---|---|---|\n",
  stakeholder_mention:
    "| Row Key | Name | Role | Context | Source Path | Source Quote |\n" +
    "|---|---|---|---|---|---|\n",
} as const;

const ALL_EVIDENCE_FILES = [
  ...Object.values(FILES.fact),
  ...Object.values(FILES.stakeholder_mention),
];

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function factCandidate(value: unknown, index: number): FactCandidate {
  const item = record(value, `facts[${index}]`);
  const rowKey = stringValue(item["rowKey"], `facts[${index}].rowKey`);
  if (!ROW_KEY.test(rowKey)) {
    throw new TranscriptReviewError("invalid_input", 2, `facts[${index}].rowKey is malformed`);
  }
  return {
    rowKey,
    title: stringValue(item["title"], `facts[${index}].title`),
    occurredAt: optionalString(item["occurredAt"], `facts[${index}].occurredAt`),
    factType: literal(item["factType"], ["fact", "event"] as const, `facts[${index}].factType`),
    access: literal(item["access"], EVIDENCE_ACCESS, `facts[${index}].access`),
    transcript: stringValue(item["transcript"], `facts[${index}].transcript`),
    sourceQuote: stringValue(item["sourceQuote"], `facts[${index}].sourceQuote`),
  };
}

function stakeholderCandidate(value: unknown, index: number): StakeholderMentionCandidate {
  const item = record(value, `stakeholderMentions[${index}]`);
  const rowKey = stringValue(item["rowKey"], `stakeholderMentions[${index}].rowKey`);
  if (!ROW_KEY.test(rowKey)) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `stakeholderMentions[${index}].rowKey is malformed`
    );
  }
  return {
    rowKey,
    name: stringValue(item["name"], `stakeholderMentions[${index}].name`),
    role: optionalString(item["role"], `stakeholderMentions[${index}].role`),
    context: optionalString(item["context"], `stakeholderMentions[${index}].context`),
    access: literal(item["access"], EVIDENCE_ACCESS, `stakeholderMentions[${index}].access`),
    transcript: stringValue(item["transcript"], `stakeholderMentions[${index}].transcript`),
    sourceQuote: stringValue(item["sourceQuote"], `stakeholderMentions[${index}].sourceQuote`),
  };
}

// Missing evidence arrays default to empty — pre-1.12 stages (and every decision/task-only draft)
// parse and approve unchanged.
export function parseEvidenceBatch(item: Readonly<Record<string, unknown>>): EvidenceBatch {
  const facts =
    item["facts"] === undefined
      ? []
      : arrayValue(item["facts"], "facts").map((value, index) => factCandidate(value, index));
  const stakeholderMentions =
    item["stakeholderMentions"] === undefined
      ? []
      : arrayValue(item["stakeholderMentions"], "stakeholderMentions").map((value, index) =>
          stakeholderCandidate(value, index)
        );
  return { facts, stakeholderMentions };
}

// Fail-closed grounding: the sourceQuote must appear verbatim in the named transcript, and a
// stakeholder's name must appear inside its own quote. Ungrounded candidates are dropped.
export function groundEvidenceBatch(root: string, batch: EvidenceBatch): EvidenceBatch {
  const contentCache = new Map<string, string>();
  const readTranscript = (rel: string): string | null => {
    if (contentCache.has(rel)) return contentCache.get(rel) ?? null;
    let content: string | null = null;
    try {
      const file = resolveExistingWorkspaceFile({ root, requested: rel, label: "transcript" });
      content = readFileSync(file, "utf8");
    } catch {
      content = null;
    }
    contentCache.set(rel, content ?? "");
    return content;
  };
  const facts = batch.facts.filter((fact) => {
    const content = readTranscript(fact.transcript);
    return content !== null && content.includes(fact.sourceQuote);
  });
  const stakeholderMentions = batch.stakeholderMentions.filter((mention) => {
    const content = readTranscript(mention.transcript);
    return (
      content !== null &&
      content.includes(mention.sourceQuote) &&
      normalizeForMatch(mention.sourceQuote).includes(normalizeForMatch(mention.name))
    );
  });
  return { facts, stakeholderMentions };
}

function escapeCell(value: string): string {
  const trimmed = String(value ?? "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim();
  return trimmed.length > 0 ? trimmed : "—";
}

function factRow(fact: FactCandidate): string {
  return `| ${[
    fact.rowKey,
    fact.title,
    fact.occurredAt ?? "—",
    fact.factType,
    fact.transcript,
    fact.sourceQuote,
  ]
    .map(escapeCell)
    .join(" | ")} |\n`;
}

function stakeholderRow(mention: StakeholderMentionCandidate): string {
  return `| ${[
    mention.rowKey,
    mention.name,
    mention.role ?? "—",
    mention.context ?? "—",
    mention.transcript,
    mention.sourceQuote,
  ]
    .map(escapeCell)
    .join(" | ")} |\n`;
}

function existingRowKeys(root: string): Set<string> {
  const keys = new Set<string>();
  for (const relative of ALL_EVIDENCE_FILES) {
    const file = path.join(root, relative);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^\|\s*((?:fact|stakeholder)-[a-f0-9]{16})\s*\|/);
      if (match?.[1]) keys.add(match[1]);
    }
  }
  return keys;
}

function appendRows(
  root: string,
  relative: string,
  kind: keyof typeof HEADERS,
  access: EvidenceAccess,
  rows: string
): void {
  const file = path.join(canonicalRoot(root), relative);
  mkdirSync(path.dirname(file), { recursive: true });
  const declaredKind = kind === "stakeholder_mention" ? "stakeholder_mention" : "fact";
  const initial = `---\nkind: ${declaredKind}\naccess: ${access}\n---\n\n${HEADERS[kind]}`;
  const current = existsSync(file) ? readFileSync(file, "utf8") : initial;
  atomicReplace(file, current + rows, 0o600);
}

// Applied inside the caller's apply lock. Idempotent: rows whose rowKey already exists in any
// evidence file are skipped, so re-approval never duplicates a row.
export function applyEvidenceBatch(
  root: string,
  batch: EvidenceBatch
): { readonly factsAdded: number; readonly stakeholdersAdded: number } {
  const known = existingRowKeys(root);
  let factsAdded = 0;
  let stakeholdersAdded = 0;
  const grouped = new Map<string, string>();
  const route = (kind: keyof typeof HEADERS, access: EvidenceAccess, row: string): void => {
    const relative = FILES[kind][access];
    grouped.set(relative, (grouped.get(relative) ?? "") + row);
  };
  for (const fact of batch.facts) {
    if (known.has(fact.rowKey)) continue;
    known.add(fact.rowKey);
    route("fact", fact.access, factRow(fact));
    factsAdded += 1;
  }
  for (const mention of batch.stakeholderMentions) {
    if (known.has(mention.rowKey)) continue;
    known.add(mention.rowKey);
    route("stakeholder_mention", mention.access, stakeholderRow(mention));
    stakeholdersAdded += 1;
  }
  for (const [relative, rows] of grouped) {
    const kind: keyof typeof HEADERS = relative.includes("stakeholder")
      ? "stakeholder_mention"
      : "fact";
    const access = (Object.entries(FILES[kind]).find(([, value]) => value === relative)?.[0] ??
      "admin") as EvidenceAccess;
    appendRows(root, relative, kind, access, rows);
  }
  return { factsAdded, stakeholdersAdded };
}
