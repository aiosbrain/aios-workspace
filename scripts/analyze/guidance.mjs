/**
 * guidance.mjs — plain-English meaning + practical advice for each AEM axis.
 *
 * The rubric names (Verification, Context hygiene, …) are jargon on their own.
 * This is the human layer: what each axis actually means, why it matters, and
 * concrete things to do differently. Used by the report (one-line glosses) and
 * the --report deep-dive (full coaching on your weakest axis).
 *
 * Zero dependencies.
 */

/**
 * @typedef {{ kind: "chat", label: string, prompt: string }
 *   | { kind: "command", label: string, command: string }
 *   | { kind: "edit", label: string, target: string, intent: string }
 *   | { kind: "doc", label: string, path: string }} MaturityAction
 */

export const AXIS_GUIDE = {
  verification: {
    gloss: "does the agent check its own work?",
    meaning:
      "How often the agent proves a change worked — by running tests, a build, or a script — instead of you just reading the output and hoping.",
    why: "This is the single biggest thing separating 'fast but risky' from 'fast and trustworthy'. You can't safely hand the agent more work until it can show you the work is correct.",
    steps: [
      "Before you accept a change, have the agent run the tests or build and show you it passes.",
      "Give it a check it can run itself: a test command, a type-check, a lint, a smoke script — even a screenshot for UI work.",
      'For anything risky, ask "how would you prove this works?" and make it actually do that before moving on.',
    ],
    /** @type {MaturityAction[]} */
    actions: [
      {
        kind: "chat",
        label: "Design a verification check",
        prompt:
          "Inspect this project and help me define the cheapest honest check that proves my current task works. Run it and report the observed evidence.",
      },
      {
        kind: "doc",
        label: "Read the verification-first module",
        path: ".claude/skills/agentic-maturity/curriculum.md#module-verification-first-l3--l4--highest-priority-when-verification-is-weak",
      },
    ],
  },
  context_hygiene: {
    gloss: "is it working from clean, focused context?",
    meaning:
      "Whether the agent has the right, relevant information in front of it — not a giant, stale conversation it has to wade through.",
    why: "A cluttered context makes the agent slower, more expensive, and more likely to drift off-track or contradict itself.",
    steps: [
      "Start a fresh session (/clear) when you switch to a different task.",
      "Keep a short CLAUDE.md with the project's key facts so it doesn't re-learn them every time.",
      "Point it at the specific files or folders that matter, instead of the whole repo.",
    ],
    /** @type {MaturityAction[]} */
    actions: [{ kind: "command", label: "Check context health", command: "aios context-health" }],
  },
  autonomy: {
    gloss: "how much you let it run on its own",
    meaning:
      'Whether you delegate whole chunks of work (and let sub-agents run in parallel) or stop to approve every single action. "Leash" = how much freedom you give it before it has to check in.',
    why: "Approving every keystroke is slow and wastes your attention; letting it run unchecked is risky. The mature move is a longer leash on low-risk work that has a safety check behind it, and a short leash only where mistakes are expensive.",
    steps: [
      "For low-risk, reversible work (editing files on a branch, running tests), let it proceed without approving each step.",
      "Hand whole pieces of work to sub-agents or run tasks in parallel, instead of supervising one action at a time.",
      "Keep the short leash only where a mistake is costly (deploys, deletes, production) — and lengthen it as your checks (the Verification axis) prove reliable.",
    ],
    /** @type {MaturityAction[]} */
    actions: [
      {
        kind: "chat",
        label: "Calibrate the agent leash",
        prompt:
          "Classify my current task by risk and reversibility, then propose what the agent can do autonomously and which actions still need approval.",
      },
    ],
  },
  learning: {
    gloss: "does your setup get smarter over time?",
    meaning:
      "Whether fixes and lessons get captured — in CLAUDE.md, reusable skills, or commands — so you stop re-explaining the same things every session.",
    why: "Without this you re-teach the agent the same corrections forever. With it, every new session starts smarter than the last.",
    steps: [
      "Before substantial work, check which installed skill triggers match the task and invoke the ones that materially apply.",
      "Turn repeated workflows into reusable skills, then verify that later sessions discover and reuse them.",
      "Add a project rule to CLAUDE.md only when repeated corrections show it belongs there and no existing skill already covers it.",
    ],
    /** @type {MaturityAction[]} */
    actions: [
      {
        kind: "chat",
        label: "Review skill reuse",
        prompt:
          "Review recent repeated work and corrections. Identify which installed skills were eligible, which were invoked, and what should become or update a reusable skill. Recommend a CLAUDE.md rule only when evidence shows a repeated project-wide constraint that no skill already covers.",
      },
      {
        kind: "edit",
        label: "Update a reusable skill",
        target: ".claude/skills/",
        intent:
          "After the skill-reuse review identifies a repeated workflow, update the matching reusable skill or create a narrowly scoped one.",
      },
    ],
  },
  cost_governance: {
    gloss: "tokens & money spent per task",
    meaning:
      "How many fresh tokens — and dollars — each task burns. (Cheap cached context is excluded; this is the new work each task actually pays for.)",
    why: "A high cost-per-task usually means a bloated context or using a heavyweight model for light work. Same result, less waste.",
    steps: [
      "Keep the working context tight — fewer, more relevant files in play at once.",
      "Use a cheaper, faster model for simple tasks; save the big model for the genuinely hard ones.",
      "Watch for the agent re-reading the same large files or looping on a tool — that's pure waste.",
    ],
    /** @type {MaturityAction[]} */
    actions: [
      {
        kind: "command",
        label: "Review billing-window cost",
        command: "aios analyze --since billing",
      },
    ],
  },
};

// Context Engineering Health — SHADOW coaching entry (matches the AXIS_GUIDE
// gloss/why/try structure, but keyed by score band since it's a single 0-4
// number rather than a per-signal axis). NOT an AEM axis; used only by the
// --report deep dive when the context-health score is <= 2.
export const CONTEXT_HEALTH_GUIDE = {
  gloss: "is your workspace's context itself in good shape?",
  meaning:
    "Whether the scaffolding around your agent — toolkit version, frontmatter/tier coverage, doc links — is current and intact, not whether any one session went well.",
  why: "A low score means the agent is working from a stale or broken map: an out-of-date toolkit, gaps in access-tier coverage, or dead links. Those compound quietly — they don't show up as a single bad session, they show up as friction and misplaced content everywhere.",
  steps: [
    "Run `aios context-health` to see the full check list and which ones are failing.",
    "Fix hard drift first — hard-kind check failures block real progress; soft misses are lower priority.",
    "If `versions_behind` is the culprit, run `aios update` to pull the latest toolkit-managed files.",
  ],
};

/**
 * One practical Context Health nudge, keyed off the 0-4 score band. Returns ""
 * for a healthy score (caller only calls this when score <= 2).
 */
export function contextHealthTip(score) {
  if (score <= 1) {
    return "Start with `aios context-health` for the check list, fix hard drift first, then `aios update` if you're behind on the toolkit.";
  }
  if (score === 2) {
    return "A few things need attention — `aios context-health` shows exactly which checks are failing.";
  }
  return "";
}

// Codebase Health — SHADOW coaching entry (AIO-605). Keyed by the scorer's
// status band. NOT an AEM axis; used by the analyze report's shadow card only.
export const CODEBASE_HEALTH_GUIDE = {
  gloss: "is the code itself structurally healthy?",
  meaning:
    "A composed reading over the repo's own deterministic gates — size/seam ratchet debt, test rigor, lint/type debt, docs drift, and invariant compliance — not a judgment of any one session.",
  why: "Structural debt compounds quietly: oversized modules, grandfathered couplings, and drifting docs make every future agent task slower and riskier, even while individual PRs stay green.",
  steps: [
    "Run `aios codebase-health` for the full per-axis check list and the next band moves.",
    "Shrink ratchet debt first — extracting a grandfathered file or coupling lowers the ceiling permanently.",
    "Keep the invariant gates green; a failing enumerated gate caps the whole reading.",
  ],
};

/**
 * One practical Codebase Health nudge, keyed off the scorer's status
 * (healthy | degraded | critical). Returns "" for a healthy reading.
 */
export function codebaseHealthTip(status) {
  if (status === "critical") {
    return "Structural health is critical — run `aios codebase-health` and fix the failing invariant gates before anything else.";
  }
  if (status === "degraded") {
    return "Structural debt is accumulating — `aios codebase-health` shows the next band moves (ratchet debt is the usual lever).";
  }
  return "";
}

/**
 * One practical Cognitive Ergonomics nudge, keyed off the attention reading
 * (AIO-190 Phase A — SHADOW, not a maturity verdict). Prefix-matched against
 * attentionReading()'s full sentences (aem.mjs) so it works on live output and
 * on shorthand inputs. Returns "" for the no-activity / unknown reading, so the
 * caller simply omits the line.
 */
export function ergonomicsTip(reading) {
  const r = String(reading || "");
  if (r.startsWith("orchestration-heavy"))
    return "You're running hot on parallelism — batch your agent check-ins and ring-fence one or two long focus blocks so orchestration doesn't shred the day.";
  if (r.startsWith("deep-work"))
    return "Focus is holding — protect the blocks that are working and let low-risk agent work run without pulling your attention back each step.";
  if (r.startsWith("mixed"))
    return "Some focus, some churn — notice what yanks you out of a block and try to close that loop before starting the next task.";
  return "";
}
