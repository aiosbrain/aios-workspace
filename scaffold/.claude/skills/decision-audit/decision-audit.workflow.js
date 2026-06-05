/**
 * decision-audit.workflow.js — project-agnostic decision-log governance audit harness.
 *
 * Pattern: per-rule fan-out (one verifier per rule, structurally-earned coverage)
 *          → adversarial verify (kills false positives) → synthesize.
 *
 * This is a TEMPLATE, not a verbatim script. Tune RULES, paths, and rounds to the
 * engagement. Invoke via the Workflow tool with `args` (a JSON string — see parse below).
 *
 * Key cost lesson from the workflow design study (docs/workflows.md): do NOT let every
 * agent re-read the full log. Finders read it once each and return the verbatim
 * `entry_excerpt`; verifiers receive that excerpt INLINE and do not re-read. This cut
 * the original harness from ~5.5M total subagent tokens toward the hundreds-of-k range.
 */
export const meta = {
  name: 'decision-audit',
  description: 'Governance audit of a decision log: per-rule fan-out + adversarial verification.',
  phases: [
    { title: 'Index' },
    { title: 'Find' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

// Workflow delivers `args` as a JSON STRING — always parse.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const repo = A.repoPath
const decisionLog = `${repo}/${A.decisionLog || '03-status/decision-log.md'}`
const clientSurfaceLog = `${repo}/${A.clientSurfaceLog || '03-status/client-surface-log.md'}`
const runDate = A.runDate || ''
const maxRounds = A.rounds || 1 // loop-until-dry cap; 1 is enough for most logs

// Rule set is overridable via args.ruleSet. `needsClientLog` routes the orphaned-client check.
const RULES = A.ruleSet || [
  { key: 'missing-rationale', desc: 'Rationale column empty, "TBD"/"—", or merely restates the decision with no actual reason.' },
  { key: 'missing-decided-by', desc: 'Decided By column empty or unattributed.' },
  { key: 'bad-audience-tag', desc: 'Audience column empty, or not one of admin | team | client.' },
  { key: 'type-impact-mismatch', desc: 'Type column (1/2/3) inconsistent with the Impact text (e.g. a high-stakes, irreversible decision marked Type 1).' },
  { key: 'orphaned-client', desc: 'Decision with Audience = client but no corresponding entry in the client-surface-log.', needsClientLog: true },
  { key: 'stale', desc: `Decision dated >30 days before ${runDate} whose Impact implies follow-up still "pending"/"awaiting"/"at risk" with no resolution noted.` },
  { key: 'near-duplicate', desc: 'Two entries record substantially the same decision (include both entry numbers + excerpts).' },
]

const FINDINGS = {
  type: 'object',
  properties: {
    entries_examined: { type: 'integer', description: 'entries actually read end-to-end' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          entry: { type: 'integer' },
          rule: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'med', 'high'] },
          entry_excerpt: { type: 'string', description: 'verbatim text of the offending entry (so verifiers need not re-read the file)' },
        },
        required: ['entry', 'rule', 'detail', 'entry_excerpt'],
      },
    },
  },
  required: ['entries_examined', 'findings'],
}
// Batched verdicts: one verifier agent per rule reviews all that rule's candidates.
// Batching by rule (not one agent per finding) is the dominant cost lever — agent
// COUNT × per-agent context overhead is what drives token cost, not file re-reads.
const VERDICTS = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'candidate index as given' },
          real: { type: 'boolean' },
          reason: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'med', 'high'] },
        },
        required: ['index', 'real'],
      },
    },
  },
  required: ['verdicts'],
}

// ---- Index once: ground "examined all" with a real entry count ----
phase('Index')
const index = await agent(
  `Read the decision log ${decisionLog} with the Read tool. Return total_entries = number of decision rows, and entry_numbers = the list of entry numbers present.`,
  { label: 'index', phase: 'Index', schema: { type: 'object', properties: { total_entries: { type: 'integer' }, entry_numbers: { type: 'array', items: { type: 'integer' } } }, required: ['total_entries'] } },
)
const totalEntries = index.total_entries
log(`Decision log: ${totalEntries} entries`)

// ---- Fan-out finders + inline adversarial verify, loop-until-dry (capped) ----
const seen = new Set()
const confirmed = []
let rejected = 0
let maxExamined = 0

for (let round = 0; round < maxRounds; round++) {
  phase('Find')
  const already = [...seen].join(', ') || 'none yet'
  const found = (await parallel(RULES.map(r => () =>
    agent(
      `Scan the FULL decision log ${decisionLog} for ONE rule only.
RULE ${r.key}: ${r.desc}
${r.needsClientLog ? `Also read ${clientSurfaceLog} to check for corresponding entries.\n` : ''}Examine all ~${totalEntries} entries — do not sample or stop early. For every finding include entry_excerpt = the verbatim offending row so it can be verified without re-reading the file. Report entries_examined honestly. Skip already-found: ${already}.`,
      { label: `find:${r.key}`, phase: 'Find', schema: FINDINGS },
    ).then(res => ({ rule: r, res })),
  ))).filter(Boolean)

  const fresh = []
  for (const { rule, res } of found) {
    maxExamined = Math.max(maxExamined, res.entries_examined || 0)
    for (const f of res.findings || []) {
      const k = `${rule.key}:${f.entry}`
      if (!seen.has(k)) { seen.add(k); fresh.push({ ...f, rule: rule.key, needsClientLog: rule.needsClientLog }) }
    }
  }
  log(`Round ${round + 1}: ${fresh.length} fresh candidates`)
  if (!fresh.length) break

  // Adversarial verify — one independent skeptic per RULE-group (excerpts inline).
  // Each verifier still judges every candidate individually; batching by rule cuts
  // agent count ~10× vs one-agent-per-finding with negligible quality loss.
  phase('Verify')
  const byRule = {}
  for (const f of fresh) { (byRule[f.rule] = byRule[f.rule] || []).push(f) }
  const batches = (await parallel(Object.entries(byRule).map(([ruleKey, items]) => () =>
    agent(
      `You are an ADVERSARIAL verifier for rule "${ruleKey}". Review EACH candidate below INDEPENDENTLY and decide whether it is a REAL violation. Default real=false if uncertain or borderline. Return one verdict per candidate, keyed by its index, with a calibrated severity.
${items[0].needsClientLog ? `To confirm, read ${clientSurfaceLog} and check for corresponding entries.\n` : ''}Candidates:
${items.map((f, i) => `[${i}] entry #${f.entry} — ${f.detail}\n    Entry verbatim: """${f.entry_excerpt}"""`).join('\n\n')}`,
      { label: `verify:${ruleKey}`, phase: 'Verify', schema: VERDICTS },
    ).then(res => ({ items, res })),
  ))).filter(Boolean)

  for (const { items, res } of batches) {
    const vmap = new Map((res.verdicts || []).map(v => [v.index, v]))
    items.forEach((f, i) => {
      const v = vmap.get(i)
      if (v && v.real) confirmed.push({ entry: f.entry, rule: f.rule, detail: f.detail, severity: v.severity || f.severity || 'med' })
      else rejected++
    })
  }
}

// ---- Synthesize report ----
phase('Synthesize')
const out = await agent(
  `Produce a decision-log audit report grouped by rule, then by severity, from these CONFIRMED findings (already adversarially verified):
${JSON.stringify(confirmed)}
Audit date: ${runDate || 'unspecified'}. Log audited: ${decisionLog} (use this exact path in the header — do not guess).
Coverage: ${maxExamined}/${totalEntries} entries examined per rule. Rejected ${rejected} candidates as false positives.
Return report_markdown plus the structured findings list.`,
  { label: 'synthesize', phase: 'Synthesize', schema: { type: 'object', properties: { report_markdown: { type: 'string' }, findings: { type: 'array', items: { type: 'object', properties: { entry: { type: 'integer' }, rule: { type: 'string' }, detail: { type: 'string' }, severity: { type: 'string' } } } } }, required: ['report_markdown'] } },
)

return {
  workflow: 'decision-audit',
  total_entries: totalEntries,
  entries_examined: maxExamined,
  coverage: totalEntries ? maxExamined / totalEntries : 0,
  confirmed: confirmed.length,
  rejected,
  findings: confirmed,
  report_markdown: out.report_markdown,
}
