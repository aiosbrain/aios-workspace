The trust primitive. Every claim in a brief or digest links back to the manifest signal (source path/row) it came from. This is what makes the verifier possible and what lets a human inspect "why does it say this?"

**Acceptance:**
- Each generated statement carries ≥1 evidence reference into the C1 manifest (path/row + tier).
- A claim with no evidence reference is a hard fail — it cannot be emitted to a shareable digest.
- Ledger is inspectable in the run output (cockpit + CLI): expand any line → see its sources + their tiers.
- Redactions are visible: when a claim's evidence is admin-tier, the digest shows it was withheld, not silently dropped.

This is the schema that later compounds into M2 (team aggregation cites member artifacts) and M3 (harness outputs expose verifier status). Design the reference shape with that reuse in mind, but keep it minimal for V1.