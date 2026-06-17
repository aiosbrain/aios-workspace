# Agentic e2e UX-testing harness (cockpit pilot)

An agent drives the **localhost cockpit** by *intent* (via `agent-browser`) and an isolated,
rubric-driven **LLM-as-judge** gates the experience — over two trust-critical flows. This is
the runnable implementation of [`docs/plan-agentic-ux-testing.md`](../../docs/plan-agentic-ux-testing.md).

> **Run mode:** nightly / on-demand only — **never per-PR**. It spends tokens and is mildly
> non-deterministic. The only thing wired into PR CI is the **offline judge unit test**
> (`judge.test.mjs`), which is zero-dependency and free.

## Layout

| File | What |
|------|------|
| `judge.mjs` | **Pure, dependency-injected** gate: `judgeFlow(rubric, evidence, callModel)`. No SDK import. Strict-JSON per-criterion verdict, schema-validated, retry-once, 3× self-consistency, threshold gate. |
| `judge.test.mjs` | **Zero-dep** unit test (injects a fake `callModel`). Runs in PR CI. |
| `driver.mjs` | Agentic driver via `@anthropic-ai/claude-agent-sdk` `query()`. Default-deny Bash allowlist — only `agent-browser <subcommand> …` (no shell features). |
| `run-ux.mjs` | Orchestrator: scaffold fixture → firecrawl stub → launch cockpit → driver → judge → post-asserts → `report.json` → teardown. Hosts the **real** `callModel` adapter (`@anthropic-ai/sdk`, temp 0, image blocks) injected into the judge. |
| `firecrawl-stub.mjs` | Deterministic offline stand-in for the Firecrawl API. |
| `flows/onboarding-draft-from-link.mjs` | Flow A: intent + rubric + the no-silent-write post-assert. |
| `flows/skills-install-consent.mjs` | Flow B: intent + rubric + the installed-state / consent-contract post-assert. |
| `fixtures/` | Canned Firecrawl extract. |
| `evidence/` | Per-flow screenshots + transcript + `report.json` (gitignored). |

## Run it

```bash
# Offline: judge unit test (no API key, no browser) — what PR CI runs.
node test/ux/judge.test.mjs

# Offline smoke: prove fixture scaffold + firecrawl install + cockpit launch + readiness +
# teardown WITHOUT spending tokens (no agent-browser / API needed).
node test/ux/run-ux.mjs --setup-only

# Live (needs ANTHROPIC_API_KEY + agent-browser + Chrome). Without a key → skipped_no_key.
npm run test:ux -- --flow all
node test/ux/run-ux.mjs --flow onboarding-draft-from-link --keep-evidence
node test/ux/run-ux.mjs --flow all --real-firecrawl   # hit real Firecrawl (opt-in, spends)
```

### Statuses / exit codes

| Status | Exit | Meaning |
|--------|------|---------|
| `pass` | 0 | gate cleared, post-asserts green |
| `skipped_no_key` | 0 | `ANTHROPIC_API_KEY` unset (setup/launch/teardown still proven) |
| `ux_fail` | 1 | gate below threshold or a post-assert failed |
| `harness_error` | 2 | infra broke |
| `review_needed` | 0 + WARNING | judge's 3× runs didn't agree — triage, not a regression |

## Safety model

- Drives a **throwaway scaffolded fixture**, never a real workspace.
- The cockpit binds `127.0.0.1` with a **known token** (`AIOS_GUI_TOKEN`); the URL never
  leaves the machine.
- The driver may run **only** `agent-browser` (default-deny; shell metacharacters rejected).
- The judge is **pure** and never imports an SDK, so the gate logic is testable and free in CI.
- Trust invariants are checked by **judge-independent post-asserts** (no silent `USER.md` write
  in Flow A; the install actually landed + the elevated-consent contract holds in Flow B).
- The HIGH → typed-confirm consent path is covered deterministically by
  [`test/skill-install.test.mjs`](../skill-install.test.mjs) — referenced, not duplicated here.
