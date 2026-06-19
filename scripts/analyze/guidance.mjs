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

export const AXIS_GUIDE = {
  verification: {
    gloss: "does the agent check its own work?",
    meaning:
      "How often the agent proves a change worked — by running tests, a build, or a script — instead of you just reading the output and hoping.",
    why:
      "This is the single biggest thing separating 'fast but risky' from 'fast and trustworthy'. You can't safely hand the agent more work until it can show you the work is correct.",
    steps: [
      "Before you accept a change, have the agent run the tests or build and show you it passes.",
      "Give it a check it can run itself: a test command, a type-check, a lint, a smoke script — even a screenshot for UI work.",
      "For anything risky, ask \"how would you prove this works?\" and make it actually do that before moving on.",
    ],
  },
  context_hygiene: {
    gloss: "is it working from clean, focused context?",
    meaning:
      "Whether the agent has the right, relevant information in front of it — not a giant, stale conversation it has to wade through.",
    why:
      "A cluttered context makes the agent slower, more expensive, and more likely to drift off-track or contradict itself.",
    steps: [
      "Start a fresh session (/clear) when you switch to a different task.",
      "Keep a short CLAUDE.md with the project's key facts so it doesn't re-learn them every time.",
      "Point it at the specific files or folders that matter, instead of the whole repo.",
    ],
  },
  autonomy: {
    gloss: "how much you let it run on its own",
    meaning:
      "Whether you delegate whole chunks of work (and let sub-agents run in parallel) or stop to approve every single action. \"Leash\" = how much freedom you give it before it has to check in.",
    why:
      "Approving every keystroke is slow and wastes your attention; letting it run unchecked is risky. The mature move is a longer leash on low-risk work that has a safety check behind it, and a short leash only where mistakes are expensive.",
    steps: [
      "For low-risk, reversible work (editing files on a branch, running tests), let it proceed without approving each step.",
      "Hand whole pieces of work to sub-agents or run tasks in parallel, instead of supervising one action at a time.",
      "Keep the short leash only where a mistake is costly (deploys, deletes, production) — and lengthen it as your checks (the Verification axis) prove reliable.",
    ],
  },
  learning: {
    gloss: "does your setup get smarter over time?",
    meaning:
      "Whether fixes and lessons get captured — in CLAUDE.md, reusable skills, or commands — so you stop re-explaining the same things every session.",
    why:
      "Without this you re-teach the agent the same corrections forever. With it, every new session starts smarter than the last.",
    steps: [
      "When you correct the agent on something, add that rule to CLAUDE.md so it sticks next time.",
      "Turn a workflow you repeat into a reusable skill or slash-command.",
      "Build a small toolbelt (handy scripts, MCP servers) the agent can reach for instead of improvising.",
    ],
  },
  cost_governance: {
    gloss: "tokens & money spent per task",
    meaning:
      "How many fresh tokens — and dollars — each task burns. (Cheap cached context is excluded; this is the new work each task actually pays for.)",
    why:
      "A high cost-per-task usually means a bloated context or using a heavyweight model for light work. Same result, less waste.",
    steps: [
      "Keep the working context tight — fewer, more relevant files in play at once.",
      "Use a cheaper, faster model for simple tasks; save the big model for the genuinely hard ones.",
      "Watch for the agent re-reading the same large files or looping on a tool — that's pure waste.",
    ],
  },
};
