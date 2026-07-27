# Transcript extraction contract v1 release evidence

Recorded: 2026-07-24 (re-verified same day, release-plumbing pass, AIO-494)

## Shared Brain API 1.12 contract

- JSON Schema SHA-256:
  `c380f811d20c0cfc0879c2b2d8299000b8f0eddfe0601581974c702f60415a28`
- Canonical fixture SHA-256:
  `9862e47581b9bdd68ecfd7aa92216011a6b56bc9dc7abaee3bd5e301240bfbea`
- Generated contract `contentHash`:
  `b9974f1381e490888b1063f57e34a22bd63c4b88009fe6a8bc4cf03e3cd9701b`
- Workspace and Team Brain schema/fixture copies are byte-identical (`cmp` exit 0), re-verified
  2026-07-24: `docs/contract/item-payload-1.12{.schema,-fixtures}.json` in this repo against
  `aios-team-brain-worktrees/feat-transcript-contract-v1/test/fixtures/contract/item-payload-1.12{.schema,-fixtures}.json`.
- Brain-side work is checkpointed at Team Brain commit `1d1259c` on its
  `feat/transcript-contract-v1` branch — **not yet PR'd or deployed**. Release remains blocked on
  the Brain deploy.

## Extraction evaluation

- Corpus: `evals/transcript-extraction/gold-v1.json`
- Corpus version: `1.0.0`
- Deterministic result: PASS (re-run 2026-07-24: `node evals/transcript-extraction/extraction-eval.mjs`)
- Grounded accepted candidates: 100%
- Semantic precision/recall: 1.00/1.00 for decisions, tasks, facts, and stakeholders
- Rejection coverage: absent quote, empty quote, misleading stakeholder quote, and duplicate output
- Live model: `deepseek:deepseek-chat`
- Live three-run result: PASS (3/3 runs met every threshold), re-run 2026-07-24 via
  `node evals/transcript-extraction/extraction-eval.mjs --live`
- Live grounding: 1.00 in runs 1, 2, and 3 (7/7 grounded each run)
- Live semantic precision/recall: 1.00/1.00 for every kind (decisions, tasks, facts,
  stakeholders) in runs 1, 2, and 3
- Live adapter conformance: PASS in runs 1, 2, and 3

The evaluation output contains aggregate scores and synthetic paths only. It does not persist model
credentials, real transcripts, or raw model responses.

## Open follow-up

No parity test exists between the JSON-schema engine (`docs/contract/item-payload-1.12.schema.json`)
and the workspace's own `validateItemPayload` (`scripts/workspace-parse.mjs`) — this is a zero-dep
repo with no JSON Schema validator library, so the current guarantee is fixture coverage plus the
SHA-256 pinning above, not automated cross-validation. Recommend a follow-up ticket to add a
lightweight schema↔validator conformance test (e.g. hand-rolled assertions covering every schema
constraint, or a minimal in-repo validator) so the two never silently diverge.
