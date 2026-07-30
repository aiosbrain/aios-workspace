function cleanOptional(value) {
  const text = String(value ?? "").trim();
  return text && text !== "—" ? text : undefined;
}

export function factCandidateToMarkdownRow(candidate) {
  return {
    row_key: String(candidate.rowKey ?? "").trim(),
    title: String(candidate.title ?? "").trim(),
    occurred_at: cleanOptional(candidate.occurredAt),
    fact_type: candidate.factType === "event" ? "event" : "fact",
    source_path: String(candidate.transcript ?? "").trim(),
    source_quote: String(candidate.sourceQuote ?? "").trim(),
  };
}

export function stakeholderCandidateToMarkdownRow(candidate) {
  return {
    row_key: String(candidate.rowKey ?? "").trim(),
    name: String(candidate.name ?? "").trim(),
    role: cleanOptional(candidate.role),
    context: cleanOptional(candidate.context),
    source_path: String(candidate.transcript ?? "").trim(),
    source_quote: String(candidate.sourceQuote ?? "").trim(),
  };
}

export function parsedFactMarkdownToWire(row) {
  return {
    row_key: row.rowKey,
    title: row.title,
    ...(row.occurredAt ? { occurred_at: row.occurredAt } : {}),
    fact_type: row.factType,
    source_path: row.sourcePath,
    source_quote: row.sourceQuote,
  };
}

export function parsedStakeholderMarkdownToWire(row) {
  return {
    row_key: row.rowKey,
    name: row.name,
    ...(row.role ? { role: row.role } : {}),
    ...(row.context ? { context: row.context } : {}),
    source_path: row.sourcePath,
    source_quote: row.sourceQuote,
  };
}
