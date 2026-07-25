---
description: Explicitly publish a final SPEC_READY candidate to one AIO Linear issue
argument-hint: AIO-<n> <candidate> --eval-artifact <json> --expected-remote-sha <sha256>
---

Use `linear-publish-spec` and invoke:

```bash
aios spec publish $ARGUMENTS
```

Confirm the exact issue, candidate, evaluation artifact, repository SHA, and approved remote hash.
The artifact must come from `aios spec eval <candidate> --publishable --json` on a clean tree.
Stop on stale source, an ambiguous response, or byte-verification mismatch. Never change issue state
or retry an ambiguous mutation.
