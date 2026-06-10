/**
 * transcript-decisions.workflow.js — project-agnostic transcript → decision-log harness.
 *
 * Pattern: per-transcript fan-out extract → dedup vs the existing log →
 *          batched adversarial grounding → synthesize log-ready rows.
 *
 * This is a TEMPLATE, not a verbatim script. Invoke via the Workflow tool with `args`
 * (a JSON string — see parse below).
 *
 * Volume gate (from the workflow design study, docs/workflows.md): for a single short
 * transcript a one-pass read extracts just as completely — use the harness when you
 * have a BATCH of transcripts, or a large existing decision log where duplicate rows
 * are a real risk. Its value over single-pass is automatic dedup + per-decision
 * grounding, not raw extraction recall.
 *
 * Conventions: read shared context once and pass excerpts inline; batch verification
 * to control agent count; keep each structured output small; read-only (returns rows,
 * the caller writes them).
 */
export const meta = {
  name: 'transcript-decisions',
  description: 'Extract decisions from meeting transcripts: fan-out → dedup → adversarial grounding → synthesize → rubric gate.',
  phases: [
    { title: 'Extract' },
    { title: 'Dedup' },
    { title: 'Verify' },
    { title: 'Synthesize' },
    { title: 'Grade' },
    { title: 'Correct' },
  ],
}

// Workflow delivers `args` as a JSON STRING — always parse.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const repo = A.repoPath
const transcripts = (A.transcriptPaths || []).map(p => `${repo}/${p}`)
const decisionLog = `${repo}/${A.decisionLog || '03-status/decision-log.md'}`
const runDate = A.runDate || ''
const rubricPath = `${repo}/${A.rubricPath || '.claude/rubrics/transcript-decisions.md'}`

const DECISIONS = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          gist: { type: 'string', description: 'the decision, one sentence' },
          decided_by: { type: 'string' },
          rationale: { type: 'string' },
          type: { type: 'integer', enum: [1, 2, 3] },
          audience: { type: 'string', enum: ['admin', 'team', 'client'] },
          source_quote: { type: 'string', description: 'verbatim line(s) from the transcript grounding this' },
        },
        required: ['gist', 'decided_by', 'type', 'audience', 'source_quote'],
      },
    },
  },
  required: ['decisions'],
}
const DEDUP = {
  type: 'object',
  properties: { novel_indices: { type: 'array', items: { type: 'integer' }, description: '0-based indices NOT already in the log' } },
  required: ['novel_indices'],
}
const VERDICTS = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          grounded: { type: 'boolean', description: 'actually supported by the transcript with correct attribution?' },
          corrected_type: { type: 'integer', enum: [1, 2, 3] },
          corrected_audience: { type: 'string', enum: ['admin', 'team', 'client'] },
        },
        required: ['index', 'grounded'],
      },
    },
  },
  required: ['verdicts'],
}

if (!transcripts.length) { return { workflow: 'transcript-decisions', error: 'no transcriptPaths provided' } }

// ---- Extract: one extractor per transcript (clean context each) ----
phase('Extract')
const perTranscript = (await parallel(transcripts.map((t, i) => () =>
  agent(
    `Read the meeting transcript ${t} with the Read tool. Extract EVERY genuine decision made (what was decided, by whom, why, reversibility Type 1/2/3, audience admin|team|client). Be exhaustive — cover the whole transcript. Ground each in a verbatim source_quote. Do not invent decisions.`,
    { label: `extract:${A.transcriptPaths[i]}`, phase: 'Extract', schema: DECISIONS },
  ).then(r => (r.decisions || []).map(d => ({ ...d, transcript: A.transcriptPaths[i] }))),
))).filter(Boolean).flat()
let candidates = perTranscript
log(`Extracted ${candidates.length} candidate decisions from ${transcripts.length} transcript(s)`)
if (!candidates.length) return { workflow: 'transcript-decisions', candidates: 0, novel: 0, decisions: [] }

// ---- Dedup: one read of the existing log marks which candidates are novel ----
phase('Dedup')
const dedup = await agent(
  `Read the existing decision log ${decisionLog} with the Read tool. Here are ${candidates.length} candidate decisions extracted from transcripts (0-based):
${candidates.map((c, i) => `${i}: ${c.gist}`).join('\n')}
Return novel_indices = the indices whose decision is NOT already captured in the log (match on substance, not wording).`,
  { label: 'dedup', phase: 'Dedup', schema: DEDUP },
)
const keep = new Set(dedup.novel_indices || candidates.map((_, i) => i))
let novel = candidates.filter((_, i) => keep.has(i))
log(`${novel.length}/${candidates.length} novel after dedup`)
if (!novel.length) return { workflow: 'transcript-decisions', candidates: candidates.length, novel: 0, decisions: [] }

// ---- Verify: batched adversarial grounding (reads the transcripts once) ----
phase('Verify')
const v = await agent(
  `Adversarially verify each extracted decision against the transcripts. Read these transcript(s) with the Read tool first:
${transcripts.map(t => `- ${t}`).join('\n')}
Then for each candidate, set grounded=true if the transcript genuinely contains this decision (the quote appears and expresses an actual decision/commitment with roughly the stated attribution). Set grounded=false ONLY if the quote cannot be found in the transcript, or it is not actually a decision (mere discussion/aside). Provide corrected_type/corrected_audience where the extractor got them wrong.
Candidates:
${novel.map((c, i) => `[${i}] (${c.transcript}) "${c.gist}" — by ${c.decided_by}, Type ${c.type}, ${c.audience}\n    quote: """${c.source_quote}"""`).join('\n\n')}`,
  { label: 'verify', phase: 'Verify', schema: VERDICTS },
)
const vmap = new Map((v.verdicts || []).map(x => [x.index, x]))
const verified = novel
  .map((c, i) => ({ c, x: vmap.get(i) }))
  .filter(({ x }) => x && x.grounded)
  .map(({ c, x }) => ({ ...c, type: x.corrected_type || c.type, audience: x.corrected_audience || c.audience }))
log(`${verified.length} survived adversarial grounding`)

// ---- Synthesize: log-ready rows ----
phase('Synthesize')
const out = await agent(
  `Format these verified, novel decisions into decision-log table rows with columns: Date | Decision | Rationale | Decided By | Impact | Type | Audience. Use ${runDate || 'the meeting date'} for Date. Return rows_markdown plus the structured decisions list (unchanged in substance).
Decisions: ${JSON.stringify(verified.map(d => ({ gist: d.gist, rationale: d.rationale, decided_by: d.decided_by, type: d.type, audience: d.audience, source_quote: d.source_quote })))}`,
  { label: 'synthesize', phase: 'Synthesize', schema: { type: 'object', properties: { rows_markdown: { type: 'string' }, decisions: DECISIONS.properties.decisions }, required: ['rows_markdown'] } },
)

// ---- Grade → Correct: rubric gate on the synthesized rows (conventions #11–12) ----
// The Verify phase grounded individual candidates; this gates the FINAL output
// (formatting fidelity, dedup, attribution) with an independent verifier context.
let rowsMarkdown = out.rows_markdown
let gradeReport = null
let loopsUsed = 0
let passed = false

const RUBRIC = {
  type: 'object',
  properties: {
    budget: { type: 'integer' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, criterion: { type: 'string' }, must: { type: 'boolean' } },
        required: ['id', 'criterion', 'must'],
      },
    },
  },
  required: ['budget', 'criteria'],
}
const GRADE = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, pass: { type: 'boolean' },
          evidence: { type: 'string' }, fix_hint: { type: 'string' },
        },
        required: ['id', 'pass', 'evidence'],
      },
    },
  },
  required: ['criteria'],
}

phase('Grade')
const rubric = await agent(
  `Read the rubric file ${rubricPath} with the Read tool. Return its frontmatter budget integer and its criteria table rows (ID, Criterion, Must yes/no). If the file does not exist, return budget 0 and an empty criteria list.`,
  { label: 'rubric', phase: 'Grade', schema: RUBRIC },
)
const budget = A.budget ?? rubric?.budget ?? 2
const criteria = rubric?.criteria || []

if (!criteria.length) {
  passed = true // no rubric in this repo — gate is a no-op, output ships as-is
} else {
  for (let round = 0; round <= budget; round++) {
    const grade = await agent(
      `You are an independent verifier. Grade the candidate decision-log rows against each rubric criterion. Use the Read tool to check sources — the transcripts (${transcripts.join(', ')}), the existing log (${decisionLog}) for duplicates, and the log's table header for column fidelity. Do not take the candidate's word for anything.
RUBRIC CRITERIA: ${JSON.stringify(criteria)}
CANDIDATE ROWS:
"""
${rowsMarkdown}
"""
STRUCTURED DECISIONS (for quote checks): ${JSON.stringify(verified.map(d => ({ gist: d.gist, transcript: d.transcript, source_quote: d.source_quote })))}`,
      { label: `grade:r${round}`, phase: 'Grade', schema: GRADE },
    )
    gradeReport = grade?.criteria || []
    const mustFails = gradeReport.filter(g => !g.pass && (criteria.find(c => c.id === g.id)?.must))
    log(`Grade round ${round}: ${mustFails.length} must-fail(s)`)
    if (!mustFails.length) { passed = true; break }
    if (round === budget) break

    phase('Correct')
    loopsUsed++
    const corrected = await agent(
      `Revise these decision-log rows to fix ONLY the failing rubric criteria. Keep passing rows intact. Use the Read tool on sources if a fix needs grounding.
FAILING: ${JSON.stringify(mustFails.map(f => ({ id: f.id, criterion: criteria.find(c => c.id === f.id)?.criterion, evidence: f.evidence, fix_hint: f.fix_hint })))}
ROWS TO REVISE:
"""
${rowsMarkdown}
"""`,
      { label: `correct:r${round}`, phase: 'Correct', schema: { type: 'object', properties: { rows_markdown: { type: 'string' } }, required: ['rows_markdown'] } },
    )
    if (corrected?.rows_markdown) rowsMarkdown = corrected.rows_markdown
    phase('Grade')
  }
}

return {
  workflow: 'transcript-decisions',
  transcripts: A.transcriptPaths,
  candidates: candidates.length,
  novel: novel.length,
  verified: verified.length,
  passed,
  loops_used: loopsUsed,
  grade_report: gradeReport,
  decisions: verified.map(d => ({ gist: d.gist, decided_by: d.decided_by, type: d.type, audience: d.audience, transcript: d.transcript })),
  rows_markdown: rowsMarkdown,
}
