---
name: evolve
description: Analyze recent Codex session history, actual skill-loading evidence, resolver usage, installed skill catalogs, and accumulated Claude instincts to identify repeated friction, missed skill-routing opportunities, and reusable workflow improvements. Use when asked what skills are being used, which skills are being missed, whether skill diversity or routing is healthy, what to create or improve from recent work, or how to compound session learnings. Generate or modify skills only when explicitly requested.
---

# Evolve

Mine local session evidence, distinguish recurring procedures from one-off tasks, and recommend the smallest useful improvements to skills and routing.

## Analyze

1. Run the bundled extractor from each project being audited:

   ```bash
   python3 scripts/analyze_history.py --days 21 --max-sessions 30 --include-instincts
   ```

   Resolve the script relative to this `SKILL.md`. Use `--max-sessions 200` when the user asks for a full-window audit rather than a recent sample. Use `--all-projects` only for genuinely global patterns.

2. Read the extractor's distinct evidence layers separately:

   - prompts and lexical correction candidates show task demand and possible friction;
   - skill instruction reads and explicit declarations show likely use, not guaranteed completion;
   - resolver and entrypoint reads show whether routing guidance was consulted;
   - catalog sources and parity gaps show whether a runtime could discover the same skills.

   Never equate a skill file read with successful execution. Treat it as an upper-bound adoption signal.

3. Inspect the installed catalog before proposing anything. Compare project-local `.claude/skills`, project-local `.agents/skills`, and available global roots. Do not recommend a new skill when an existing skill can be tightened, exposed to another runtime, or composed with another.

4. Match tasks to skills semantically. Use descriptions, triggers, corrections, and workflow evidence. Do not infer a missed skill from word frequency or name overlap alone. Judge routing with:

   - **coverage** — eligible tasks that used the relevant specialist skill;
   - **precision** — loaded skills that materially matched the task;
   - **routing compliance** — sessions that consulted the applicable resolver or entrypoint;
   - **outcome** — whether confirmed corrections or repeated failures followed a missed or weak route.

   Diversity is diagnostic context, not a goal. A narrow engineering week can correctly use a narrow set of skills.

5. Cluster evidence semantically. Give extra weight to:

   - the same workflow appearing in at least two sessions;
   - explicit user corrections or reversals;
   - fragile sequences with gates, ordering, cleanup, or external-state checks;
   - repeated repository-specific discovery that could live in a reference;
   - deterministic steps repeatedly rewritten as shell or Python;
   - specialist skills that exist but are systematically undiscoverable or skipped.

6. Reject weak candidates:

   - a one-off project task;
   - generic engineering advice Codex already knows;
   - a broad “do everything” skill;
   - behavior already enforced by `AGENTS.md`, CI, hooks, or an installed skill;
   - a candidate supported only by frequency, catalog presence, or a single file read;
   - a “diversity enforcer” that rewards unnecessary skill loading.

7. Rank candidates using this rubric:

   | Factor | Score |
   |---|---:|
   | Repeated across distinct sessions | 0–3 |
   | Correction or failure prevention value | 0–3 |
   | Deterministic/reusable procedure | 0–2 |
   | Not covered by existing automation | 0–2 |

   Recommend creation at 7+, recommend improving an existing skill at 5–6, and keep lower scores as observations. Prefer improving an overlapping existing skill even when the evidence score is higher.

## Report

Lead with the conclusion. Include:

- the audited window, project scope, and sample cap;
- routing coverage and skill-use evidence, clearly labeled as heuristic;
- the most-used relevant skills and the strongest missed matches;
- catalog or runtime-discovery gaps that explain missed routing;
- the smallest documentation, generator, validation, or skill change that fixes each gap.

For each recommended skill candidate provide:

- proposed lowercase hyphenated name;
- evidence from distinct sessions, paraphrased rather than quoted at length;
- score and why a skill is the right abstraction;
- trigger examples;
- minimal contents: `SKILL.md`, and only scripts, references, or assets that earn their cost;
- overlap with installed skills and the boundary between them.

Include a “do not create” section for tempting but redundant candidates. Treat session history as sensitive: summarize it, redact secrets, and avoid reproducing personal or unrelated content.

## Generate

Do not create or modify candidate skills during analysis unless the user explicitly requests it.

When generation is requested:

1. Use the `skill-creator` skill.
2. Ask for a destination only when the user supplied no preference and the default personal skill directory would be inappropriate.
3. Initialize new skills with the skill-creator scripts; update existing skills in place.
4. Keep instructions concise and imperative. Put detailed project contracts in one-level-deep references.
5. Test bundled scripts, run `quick_validate.py`, and forward-test nontrivial changes on realistic raw session fixtures or real project-scoped history.
6. Report created or updated paths and distinguish local installation, committed source, and Team Brain publication.

Do not generate Claude commands or Claude agent frontmatter. Codex skills are the primary reusable unit; describe orchestration roles inside a skill when needed.

## Extractor options

- `--all-projects` audits global patterns.
- `--json` returns machine-readable usage, routing, catalog, and prompt metadata.
- `--include-prompts` includes redacted prompt excerpts when semantic matching genuinely requires them; default output hides prompt text.
- `--full-text` disables prompt truncation and implies `--include-prompts`; use only when exact wording is necessary.
- `--max-sessions 200` widens the default recent sample.
- `--skill-root PATH` adds a catalog root that is not discovered automatically; repeat as needed.
