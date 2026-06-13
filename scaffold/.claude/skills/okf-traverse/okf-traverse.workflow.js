/**
 * okf-traverse.workflow.js — question-driven OKF bundle traversal.
 *
 * Phases:
 *   Orient   — read root index.md + spine directory index.md files to map the bundle
 *   Fan-out  — parallel reads of documents most likely to answer the question
 *   Deepen   — follow cross-links found in fan-out docs (depth +1)
 *   Synthesize — draft answer with OKF-style citations
 *   Grade → Correct — rubric-gated self-correction (conventions #11–12)
 *
 * Key difference from weekly-synthesis: question-driven (not time-window), Orient
 * phase discovers the graph from index.md files, no brain required.
 *
 * Invoke via the Workflow tool; `args` arrives as a JSON string or object.
 */
export const meta = {
  name: 'okf-traverse',
  description: 'Question-driven OKF bundle traversal with rubric-gated cited answer.',
  phases: [
    { title: 'Orient' },
    { title: 'Fan-out' },
    { title: 'Deepen' },
    { title: 'Synthesize' },
    { title: 'Grade' },
    { title: 'Correct' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const repo = A.repoPath
if (!repo) return { workflow: 'okf-traverse', error: 'repoPath required' }
if (!A.question) return { workflow: 'okf-traverse', error: 'question required' }

const question = A.question
const maxDepth = A.maxDepth ?? 2
const budget = A.budget ?? 2
const rubricPath = `${repo}/.claude/rubrics/okf-traverse.md`
const instinctsPath = `${repo}/.claude/memory/instincts.md`

// ── Orient: discover the bundle structure via index.md files ─────────────────

phase('Orient')

const ORIENT_SCHEMA = {
  type: 'object',
  properties: {
    dirs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          description: { type: 'string' },
          key_documents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                path: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['title', 'path'],
            },
          },
        },
        required: ['name', 'path'],
      },
    },
  },
  required: ['dirs'],
}

const orientation = await agent(
  `You are orienting yourself in an OKF knowledge bundle at "${repo}".

Question you will eventually answer: "${question}"

Read the following index files (read as many as are available):
- ${repo}/index.md (root index, if it exists)
- ${repo}/00-engagement/index.md or ${repo}/00-project/index.md
- ${repo}/01-intake/index.md
- ${repo}/02-deliverables/index.md
- ${repo}/03-status/index.md
- ${repo}/04-client-surface/index.md or ${repo}/04-shared/index.md

For each directory index you can find, extract: the directory name, its path, a brief
description of what it holds, and the list of key documents linked from it (title + path).

Return a structured map of what you found. If an index.md doesn't exist for a directory,
skip it — don't hallucinate content.`,
  { label: 'orient:map-bundle', phase: 'Orient', schema: ORIENT_SCHEMA }
)

// ── Fan-out: read documents relevant to the question ─────────────────────────

phase('Fan-out')

const FANOUT_SCHEMA = {
  type: 'object',
  properties: {
    relevant_docs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          title: { type: 'string' },
          relevance_reason: { type: 'string' },
          key_excerpt: { type: 'string' },
        },
        required: ['path', 'title', 'relevance_reason'],
      },
    },
  },
  required: ['relevant_docs'],
}

const bundleMap = JSON.stringify(orientation?.dirs || [], null, 2)

const fanout = await agent(
  `You are answering the question: "${question}"

The OKF bundle at "${repo}" has this structure:
${bundleMap}

Read the documents from this bundle that are most likely to contain information
relevant to the question. You may read up to 8 documents. For each document you read:
- Record its path (relative to the bundle root)
- Record its title (from the H1 heading)
- State why it is relevant to the question
- Extract the key excerpt or data point that is most relevant

Focus on documents that directly address the question. Skip documents that are
clearly not relevant based on their title and directory.`,
  { label: 'fanout:read-relevant', phase: 'Fan-out', schema: FANOUT_SCHEMA }
)

const relevantDocs = fanout?.relevant_docs || []

// ── Deepen: follow cross-links at depth +1 ───────────────────────────────────

phase('Deepen')

const DEEPEN_SCHEMA = {
  type: 'object',
  properties: {
    additional_docs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          title: { type: 'string' },
          linked_from: { type: 'string' },
          key_excerpt: { type: 'string' },
        },
        required: ['path', 'title', 'linked_from'],
      },
    },
  },
  required: ['additional_docs'],
}

const alreadyRead = relevantDocs.map(d => d.path)

const deepened = maxDepth >= 2
  ? await agent(
      `You have read these documents while answering: "${question}"

Already-read documents:
${alreadyRead.map(p => `- ${p}`).join('\n')}

Now examine the markdown links found IN those documents. For each cross-link that
points to a document you haven't read yet, follow it IF the linked document seems
relevant to the question. Read up to 4 additional documents.

For each additional document you read:
- Record its path, title, and which document linked to it
- Extract the key excerpt relevant to the question

Do not re-read documents already in the list above.`,
      { label: 'deepen:follow-links', phase: 'Deepen', schema: DEEPEN_SCHEMA }
    )
  : { additional_docs: [] }

const allDocs = [
  ...relevantDocs,
  ...(deepened?.additional_docs || []),
]

// ── Synthesize ────────────────────────────────────────────────────────────────

phase('Synthesize')

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer_markdown: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          path: { type: 'string' },
          title: { type: 'string' },
          excerpt: { type: 'string' },
        },
        required: ['id', 'path', 'title'],
      },
    },
  },
  required: ['answer_markdown', 'sources'],
}

const docsContext = allDocs.map((d, i) =>
  `[S${i + 1}] ${d.title} (${d.path || d.path})\n${d.key_excerpt || ''}`
).join('\n\n')

let draft = await agent(
  `Answer the following question using ONLY the documents you have read from the OKF bundle.

Question: "${question}"

Documents read (cite as [S#] inline):
${docsContext}

Rules:
- Every factual claim must cite at least one source using [S#] inline markers
- Do not introduce information not present in the source documents
- Distinguish facts from inferences: mark inferences with "(Inference)"
- Keep the answer under 800 words
- Use markdown formatting (headers, bullets) for clarity

Return the full answer_markdown and a sources list mapping each [S#] to its path and title.`,
  { label: 'synthesize:draft', phase: 'Synthesize', schema: ANSWER_SCHEMA }
)

// ── Grade → Correct loop ─────────────────────────────────────────────────────

phase('Grade')

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    must_fail_ids: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'string' } },
    grade_report: { type: 'string' },
  },
  required: ['pass', 'must_fail_ids', 'findings', 'grade_report'],
}

let gradeReport = ''
let passed = false

for (let attempt = 0; attempt < budget; attempt++) {
  const grade = await agent(
    `You are an independent grader. Grade this answer against the rubric.

Question: "${question}"

Answer to grade:
${draft?.answer_markdown || '(empty)'}

Sources cited:
${(draft?.sources || []).map(s => `[${s.id}] ${s.title} @ ${s.path}`).join('\n')}

Rubric file: ${rubricPath}
Read the rubric file, then grade each criterion. For must-pass criteria (Must=yes),
flag any failure. Report: pass (true/false), which must-pass IDs failed, findings, grade_report.`,
    { label: `grade:attempt-${attempt + 1}`, phase: 'Grade', schema: GRADE_SCHEMA }
  )

  gradeReport = grade?.grade_report || ''
  passed = grade?.pass ?? false

  if (passed || attempt === budget - 1) break

  phase('Correct')

  draft = await agent(
    `Revise this answer to fix the following rubric failures.

Question: "${question}"

Current answer:
${draft?.answer_markdown || ''}

Grade report:
${gradeReport}

Failures to fix: ${(grade?.must_fail_ids || []).join(', ')} — ${(grade?.findings || []).join('; ')}

Apply targeted fixes. Do not regenerate from scratch. Return the revised answer_markdown and sources.`,
    { label: `correct:attempt-${attempt + 1}`, phase: 'Correct', schema: ANSWER_SCHEMA }
  )

  phase('Grade')
}

// ── Return ────────────────────────────────────────────────────────────────────

return {
  answered: passed,
  answer_markdown: draft?.answer_markdown || '',
  sources: draft?.sources || [],
  grade_report: gradeReport,
}
