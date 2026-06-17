---
description: Run the OGR validators against a workspace (structure, frontmatter, secrets, config, rubrics)
argument-hint: [workspace-path]
---

Run the AIOS workspace validators and report results concisely.

Target = the path in $ARGUMENTS, or scaffold a throwaway sandbox first if none given
(see /scaffold-sandbox). Then run:

```bash
validation/validate-all.sh <workspace-path>
```

Report pass/fail per OGR check. The **secrets** check (OGR03) is a hard gate — if it
fails, surface the offending file and STOP; never weaken the gate to pass. If anything
else fails, show the failing check's output and propose a fix before re-running.
