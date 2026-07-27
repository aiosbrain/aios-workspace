---
name: compound-learnings
description: The closing step of every task — codify what was learned so the system gets better each use. Use after completing any task where the agent was corrected, a bug was found, a procedure was discovered, or friction repeated. Also on request ("capture this", "make sure we don't repeat that").
source: Kieran Klaassen (compound engineering — the fourth step); Mitchell Hashimoto (mistake → guardrail reflex); Boris Cherny (CLAUDE.md as error-ledger)
am_pattern: A1, C1
triggers:
  - lessons learned
  - compound learnings
  - postmortem
  - post-mortem
  - capture what we learned
---

"The first three steps produce a feature; the fourth produces a system that builds
features better." You are running the compound step: turn this task's lessons into
durable artifacts so no one — human or agent — pays for the same lesson twice.

## Procedure

1. **Harvest.** Scan the task you just finished for compoundable material:
   - a mistake the agent made (or almost made) that a rule could have prevented
   - a correction the human gave more than once
   - a procedure you had to figure out (how to run X, how to test Y, where Z lives)
   - a command sequence you ran more than twice
   - a bug class the checks didn't catch
2. **Choose the strongest container that fits.** Escalate up this ladder — prefer
   enforcement over advice:

   | Lesson type | Container |
   |---|---|
   | Must NEVER happen (secret, protected path, destructive op) | a **hook/guard** — guaranteed, not advisory |
   | Mechanical rule a tool can check | a **lint rule / type / CI check** |
   | Repeatable procedure with judgment in it | a **skill** (see `skill-author`) |
   | Repeated command sequence | a **script / slash-command** |
   | Convention or gotcha an agent must know | one line in **`AGENTS.md`** (error ledger, dated) |
   | Correctness fact about the code | a **test** |

3. **Write it now, in this session** — small and specific. A one-line AGENTS.md entry
   shipped today beats a perfect skill never written. Date error-ledger entries.
4. **Prune while you're there.** If an AGENTS.md line has graduated into a hook or
   formatter, delete the line. The ledger stays short or it stops being read.

## The bar

Ask: *if the same situation arises next month in a fresh session with no memory of
today, does the artifact you just wrote prevent the mistake or shortcut the work?*
If not, it's a diary entry, not a compounding step — sharpen it.
