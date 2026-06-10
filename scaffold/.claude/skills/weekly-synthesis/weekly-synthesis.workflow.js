/**
 * weekly-synthesis.workflow.js — rubric-gated weekly digest harness.
 *
 * Pattern: Collect (read sources + rubric ONCE, excerpts inline) → Draft →
 *          Grade (INDEPENDENT verifier vs rubric) → Correct (revise, don't
 *          regenerate) → loop until the rubric passes or budget is spent.
 *
 * This is the flagship example of skills conventions #11–13 (rubric-gated
 * self-correction): the Grade agent runs in a fresh context and receives ONLY
 * the rubric, the candidate digest, and source paths — never the Draft agent's
 * reasoning. A failed gate after budget exhaustion is a RESULT (returned with
 * the grade report) and should become a memory incident (convention #13).
 *
 * This is a TEMPLATE — tune paths/window/rubric per repo. Invoke via the
 * Workflow tool; `args` arrives as a JSON string.
 */
export const meta = {
  name: 'weekly-synthesis',
  description: 'Weekly digest (decisions, scope moves, task deltas, risks) with a rubric-gated self-correction loop.',
  phases: [
    { title: 'Collect' },
    { title: 'Draft' },
    { title: 'Grade' },
    { title: 'Correct' },
  ],
}

// Workflow delivers `args` as a JSON STRING — always parse.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const repo = A.repoPath
if (!repo) { return { workflow: 'weekly-synthesis', error: 'repoPath required' } }
const decisionLog = `${repo}/${A.decisionLog || '03-status/decision-log.md'}`
const tasksFile = `${repo}/${A.tasksFile || '03-status/tasks.md'}`
const deliverablesDir = `${repo}/${A.deliverablesDir || '02-deliverables'}`
const scopeLedger = A.scopeLedger ? `${repo}/${A.scopeLedger}` : null
const rubricPath = `${repo}/${A.rubricPath || '.claude/rubrics/weekly-synthesis.md'}`
const instinctsPath = `${repo}/${A.instinctsPath || '.claude/memory/instincts.md'}`
const windowEnd = A.windowEnd || A.runDate || ''
const windowStart = A.windowStart || ''
const windowDesc = windowStart && windowEnd
  ? `${windowStart} → ${windowEnd}`
  : `the 7 days ending ${windowEnd || 'today'}`

const COLLECTED = {
  type: 'object',
  properties: {
    decisions_in_window: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          row_key: { type: 'string' }, date: { type: 'string' },
          decision: { type: 'string' }, decided_by: { type: 'string' },
          audience: { type: 'string' },
        },
        required: ['row_key', 'decision'],
      },
    },
    task_deltas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          row_key: { type: 'string' }, title: { type: 'string' },
          status: { type: 'string' }, assignee: { type: 'string' },
        },
        required: ['row_key', 'title', 'status'],
      },
      description: 'tasks currently done, in_progress, or blocked (the digest reports deltas/blockers from these)',
    },
    deliverables: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } },
        required: ['path'],
      },
    },
    scope_moves: { type: 'array', items: { type: 'string' } },
    source_paths: { type: 'array', items: { type: 'string' }, description: 'every file actually read' },
  },
  required: ['decisions_in_window', 'task_deltas', 'source_paths'],
}

const RUBRIC = {
  type: 'object',
  properties: {
    budget: { type: 'integer' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, criterion: { type: 'string' },
          method: { type: 'string' }, must: { type: 'boolean' },
        },
        required: ['id', 'criterion', 'must'],
      },
    },
    instinct_rules: { type: 'array', items: { type: 'string' } },
  },
  required: ['budget', 'criteria'],
}

const DRAFT = {
  type: 'object',
  properties: { digest_markdown: { type: 'string' } },
  required: ['digest_markdown'],
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
          evidence: { type: 'string', description: 'what was checked and what was found' },
          fix_hint: { type: 'string', description: 'how to fix, if failing' },
        },
        required: ['id', 'pass', 'evidence'],
      },
    },
  },
  required: ['criteria'],
}

// ---- Collect: read sources once + load the rubric (convention #3) ----
phase('Collect')
const [collected, rubric] = await parallel([
  () => agent(
    `Collect the inputs for a weekly team digest covering ${windowDesc}. Using the Read tool:
1. Read ${decisionLog} — return every decision row dated within the window (row_key = the # column).
2. Read ${tasksFile} — return all task rows with status done, in_progress, or blocked.
3. List ${deliverablesDir} (Glob/Read) — return deliverable paths with their frontmatter status where cheap to read.
${scopeLedger ? `4. Read ${scopeLedger} — return scope changes within the window, one line each.` : ''}
Return small structured excerpts, NOT file dumps, and list every source path you read.`,
    { label: 'collect', phase: 'Collect', schema: COLLECTED },
  ),
  () => agent(
    `Read the rubric file ${rubricPath} with the Read tool. Parse its frontmatter \`budget:\` integer and its criteria table (columns: ID | Criterion | Check method | Must). Also read ${instinctsPath} if it exists and return any distilled rules found there as instinct_rules (empty array if none).`,
    { label: 'rubric', phase: 'Collect', schema: RUBRIC },
  ),
])
if (!collected) { return { workflow: 'weekly-synthesis', error: 'collect failed' } }
const budget = A.budget ?? rubric?.budget ?? 3
const criteria = rubric?.criteria || []
log(`Collected ${collected.decisions_in_window.length} decisions, ${collected.task_deltas.length} task rows; rubric: ${criteria.length} criteria, budget ${budget}`)

// ---- Draft ----
phase('Draft')
const draftRes = await agent(
  `Write a weekly team digest in markdown covering ${windowDesc}. Sections: **Decisions** (every decision below, grouped by significance), **Scope** (moves, or "no changes"), **Tasks** (newly done; currently blocked, with assignees), **Risks** (grounded inferences from the data — mark inferences as such). Cite the source file path for every material claim, inline like (03-status/decision-log.md). Target ≤ 600 words.
${(rubric?.instinct_rules || []).length ? `Distilled team instincts to respect:\n${rubric.instinct_rules.map(r => `- ${r}`).join('\n')}\n` : ''}
Data (already collected from the repo — do not re-read sources):
DECISIONS: ${JSON.stringify(collected.decisions_in_window)}
TASKS: ${JSON.stringify(collected.task_deltas)}
DELIVERABLES: ${JSON.stringify(collected.deliverables || [])}
SCOPE: ${JSON.stringify(collected.scope_moves || [])}
SOURCES: ${JSON.stringify(collected.source_paths)}`,
  { label: 'draft', phase: 'Draft', schema: DRAFT },
)
let digest = draftRes?.digest_markdown || ''

// ---- Grade → Correct loop (conventions #11–12) ----
let gradeReport = null
let loopsUsed = 0
let passed = false

for (let round = 0; round <= budget; round++) {
  phase('Grade')
  const grade = await agent(
    // INDEPENDENT verifier: rubric + candidate + source paths only — no producer reasoning.
    `You are an independent verifier. Grade the candidate digest below against each rubric criterion. For grounding-read/count-vs-index checks, USE THE READ TOOL on the source files — do not take the digest's word for anything. For tier-scan, scan the digest text itself. Report honest evidence per criterion; a vague pass is worse than a clear fail.
RUBRIC CRITERIA: ${JSON.stringify(criteria)}
${(rubric?.instinct_rules || []).length ? `SUPPLEMENTARY INSTINCTS (treat violations as fix_hints, not failures): ${JSON.stringify(rubric.instinct_rules)}` : ''}
SOURCE FILES: ${JSON.stringify(collected.source_paths)}
CANDIDATE DIGEST:
"""
${digest}
"""`,
    { label: `grade:r${round}`, phase: 'Grade', schema: GRADE },
  )
  gradeReport = grade?.criteria || []
  const mustFails = gradeReport.filter(g => !g.pass && (criteria.find(c => c.id === g.id)?.must))
  const advisory = gradeReport.filter(g => !g.pass && !(criteria.find(c => c.id === g.id)?.must))
  log(`Grade round ${round}: ${mustFails.length} must-fail(s), ${advisory.length} advisory`)

  if (!mustFails.length) { passed = true; break }
  if (round === budget) break // budget exhausted — return the failure honestly

  phase('Correct')
  loopsUsed++
  const corrected = await agent(
    // Correct, don't regenerate (convention #12): revise the existing digest.
    `Revise this digest to fix ONLY the failing rubric criteria below. Keep everything that passed intact — do not rewrite from scratch. Use the Read tool on the source files if a fix needs grounding.
FAILING CRITERIA: ${JSON.stringify(mustFails.map(f => ({ id: f.id, criterion: criteria.find(c => c.id === f.id)?.criterion, evidence: f.evidence, fix_hint: f.fix_hint })))}
SOURCE FILES: ${JSON.stringify(collected.source_paths)}
DIGEST TO REVISE:
"""
${digest}
"""`,
    { label: `correct:r${round}`, phase: 'Correct', schema: DRAFT },
  )
  if (corrected?.digest_markdown) digest = corrected.digest_markdown
}

return {
  workflow: 'weekly-synthesis',
  window: windowDesc,
  passed,
  loops_used: loopsUsed,
  budget,
  grade_report: gradeReport,
  digest_markdown: digest,
  // convention #13: if passed=false, the caller should record a memory incident.
}
