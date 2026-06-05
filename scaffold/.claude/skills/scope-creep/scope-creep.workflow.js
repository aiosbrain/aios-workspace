/**
 * scope-creep.workflow.js — project-agnostic scope-creep detection harness.
 *
 * Pattern: list deliverables → per-deliverable classify (fan-out) →
 *          batched SEVERITY-DOWNGRADE refuter → synthesize register.
 *
 * This is a TEMPLATE, not a verbatim script. Invoke via the Workflow tool with `args`
 * (a JSON string — see parse below).
 *
 * Two lessons baked in from the workflow design study (docs/workflows.md):
 *   1. The refuter RE-GRADES severity (out-of-scope → watch → in-scope) with a cited
 *      reason — it never does binary keep/drop. The test's keep/drop refuter cut false
 *      accusations (good) but also discarded GENUINE out-of-scope items (recall loss).
 *      Re-grading removes false accusations while keeping true findings on the register.
 *   2. Batch the refuter — agent COUNT is the dominant cost driver.
 *
 * NOTE: an earlier version had a single "index" agent digest the baseline+ledger into a
 * big inline scope map; that agent reliably STALLED producing the large structured output.
 * Scope docs are small, so classifiers/refuter just read them directly. Keep agents'
 * structured outputs small to avoid stalls.
 */
export const meta = {
  name: 'scope-creep',
  description: 'Detect scope creep in deliverables vs the scope baseline/ledger, with an adversarial severity-downgrade pass.',
  phases: [
    { title: 'Index' },
    { title: 'Classify' },
    { title: 'Refute' },
    { title: 'Synthesize' },
  ],
}

// Workflow delivers `args` as a JSON STRING — always parse.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const repo = A.repoPath
const scopeBaseline = `${repo}/${A.scopeBaseline || '00-engagement/scope-baseline.md'}`
const scopeLedger = `${repo}/${A.scopeLedger || '00-engagement/scope-ledger.md'}`
const deliverablesDir = `${repo}/${A.deliverablesGlob || '02-deliverables/sprint-3'}`
const runDate = A.runDate || ''

const CLASSIFY = {
  type: 'object',
  properties: {
    classification: { type: 'string', enum: ['in-scope', 'watch', 'out-of-scope'] },
    deliverable_summary: { type: 'string' },
    baseline_citation: { type: 'string', description: 'the scope-baseline/ledger section relied on, or "none found"' },
    reason: { type: 'string' },
  },
  required: ['classification', 'baseline_citation', 'reason'],
}
const REGRADE = {
  type: 'object',
  properties: {
    gradings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'flagged-item index as given' },
          classification: { type: 'string', enum: ['in-scope', 'watch', 'out-of-scope'] },
          baseline_citation: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['index', 'classification', 'reason'],
      },
    },
  },
  required: ['gradings'],
}

// ---- Index: list deliverables only (small structured output — won't stall) ----
phase('Index')
const index = await agent(
  `List the deliverable file names (basename only) in ${deliverablesDir} (use \`ls\` via Bash or read the directory). Exclude CLAUDE.md, README, and index/ledger/plan scaffolding files.`,
  { label: 'index', phase: 'Index', schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] } },
)
const files = (index.files || []).filter(f => !/^(CLAUDE|README|index)/i.test(f))
log(`${files.length} deliverables`)

// ---- Classify each deliverable (fan-out; each reads the small scope docs + its own file) ----
phase('Classify')
const classified = (await parallel(files.map(f => () =>
  agent(
    `Classify ONE deliverable for scope creep. Read the scope baseline ${scopeBaseline}, the scope ledger ${scopeLedger}, and the deliverable ${deliverablesDir}/${f} with the Read tool.
Decide:
- in-scope: covered by a scope-baseline line OR an accepted scope-ledger entry/decision (ledger coverage counts — a deliverable need not appear verbatim in the baseline).
- watch: borderline coverage, an expansion of a covered line, or a forward-looking/unratified commitment. **When coverage is genuinely ambiguous, prefer watch over out-of-scope** — watch flags it for human review without making a hard accusation.
- out-of-scope: NO baseline and NO ledger coverage at all — clearly net-new work.
Cite the specific baseline/ledger section relied on (or "none found"). Be precise.`,
    { label: `classify:${f}`, phase: 'Classify', schema: CLASSIFY },
  ).then(r => ({ ...r, file: f })),
))).filter(Boolean)

const flagged = classified.filter(c => c.classification !== 'in-scope')
log(`${flagged.length}/${files.length} flagged (pre-refutation)`)

// ---- Batched adversarial RE-GRADE (severity-downgrade, not keep/drop) ----
let finalFlags = []
if (flagged.length) {
  phase('Refute')
  const regrade = await agent(
    `You are an adversarial reviewer guarding against FALSE scope-creep accusations — a false accusation against contracted work is the costly error. Read the scope baseline ${scopeBaseline} and scope ledger ${scopeLedger} with the Read tool. Then, for EACH flagged deliverable below, re-grade to the LOWEST DEFENSIBLE severity:
- in-scope  → genuinely covered by a baseline line OR an accepted ledger entry/decision (remove the flag)
- watch     → borderline coverage, an expansion of a covered line, or a forward-looking/unratified commitment. **When coverage is genuinely ambiguous, prefer watch over out-of-scope** — it flags for review without a hard accusation.
- out-of-scope → NO baseline and NO ledger coverage at all
Clear to in-scope anything with real coverage. But do NOT downgrade a genuinely uncovered deliverable just to be safe — preserve true out-of-scope findings. Cite the baseline/ledger section for each.

FLAGGED DELIVERABLES:
${flagged.map((c, i) => `[${i}] ${c.file} — classifier said ${c.classification} (cite: ${c.baseline_citation})\n    summary: ${c.deliverable_summary || ''}\n    reason: ${c.reason}`).join('\n\n')}`,
    { label: 'refute:regrade', phase: 'Refute', schema: REGRADE },
  )
  const gmap = new Map((regrade.gradings || []).map(g => [g.index, g]))
  finalFlags = flagged.map((c, i) => {
    const g = gmap.get(i)
    return g ? { file: c.file, classification: g.classification, baseline_citation: g.baseline_citation || c.baseline_citation, reason: g.reason, deliverable_summary: c.deliverable_summary }
             : { file: c.file, classification: c.classification, baseline_citation: c.baseline_citation, reason: c.reason, deliverable_summary: c.deliverable_summary }
  }).filter(c => c.classification !== 'in-scope') // downgraded-to-in-scope = accusation removed
}
const outOfScope = finalFlags.filter(c => c.classification === 'out-of-scope')
const watch = finalFlags.filter(c => c.classification === 'watch')
log(`After re-grade: ${outOfScope.length} out-of-scope, ${watch.length} watch (${flagged.length - finalFlags.length} downgraded to in-scope)`)

// ---- Synthesize register ----
phase('Synthesize')
const out = await agent(
  `Produce a scope-creep register grouped by severity (out-of-scope first, then watch) from these adversarially re-graded flags:
${JSON.stringify(finalFlags)}
Audit date: ${runDate || 'unspecified'}. Deliverables reviewed: ${files.length} in ${deliverablesDir}.
Return register_markdown plus the structured flags list.`,
  { label: 'synthesize', phase: 'Synthesize', schema: { type: 'object', properties: { register_markdown: { type: 'string' }, flags: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, classification: { type: 'string' }, baseline_citation: { type: 'string' }, reason: { type: 'string' } } } } }, required: ['register_markdown'] } },
)

return {
  workflow: 'scope-creep',
  total_deliverables: files.length,
  flagged_pre_refute: flagged.length,
  out_of_scope: outOfScope.length,
  watch: watch.length,
  downgraded_to_in_scope: flagged.length - finalFlags.length,
  flags: finalFlags,
  register_markdown: out.register_markdown,
}
