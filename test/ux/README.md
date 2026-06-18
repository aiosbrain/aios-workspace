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

### Prerequisites (by mode)

| Mode | Needs |
|------|-------|
| Judge unit test | nothing — pure, zero-dep |
| `--setup-only` (token-free) | `npm ci` (the cockpit's first launch builds `gui/client` with **vite** from `node_modules`; a clean clone without deps fails with `vite: command not found`) |
| Live flows | `npm ci`, **`ANTHROPIC_API_KEY` exported in the shell** (the `test:ux` script is plain `node`, not `dotenvx`-wrapped — so the key must be in the env), **`agent-browser`** on `PATH` (`npm i -g agent-browser@0.28.0`, matching the nightly pin), and **Chrome** |

```bash
# Offline: judge unit test (no API key, no browser) — what PR CI runs.
node test/ux/judge.test.mjs

# Offline smoke: prove fixture scaffold + firecrawl install + cockpit launch + readiness +
# teardown WITHOUT spending tokens (no agent-browser / API needed). Needs `npm ci` first.
npm ci
node test/ux/run-ux.mjs --setup-only

# Live (needs ANTHROPIC_API_KEY + agent-browser + Chrome). Without a key → skipped_no_key.
export ANTHROPIC_API_KEY=sk-ant-...          # the key must be in the env (test:ux is not dotenvx-wrapped)
npm i -g agent-browser@0.28.0                # once; matches the CI/nightly pin
npm run test:ux -- --flow skills-install-consent --keep-evidence   # start cheap to calibrate the judge
npm run test:ux -- --flow all --keep-evidence
node test/ux/run-ux.mjs --flow all --real-firecrawl   # hit real Firecrawl (opt-in, spends)
```

### Statuses / exit codes

| Status | Exit | Meaning |
|--------|------|---------|
| `pass` | 0 | gate cleared, post-asserts green |
| `skipped_no_key` | 0 | `ANTHROPIC_API_KEY` unset → skips **before** scaffold/launch (harness wiring + clean exit only; use `--setup-only` to exercise scaffold/launch/teardown without a key) |
| `ux_fail` | 1 | gate below threshold or a post-assert failed |
| `harness_error` | 2 | infra broke |
| `review_needed` | 0 + WARNING | judge's 3× runs didn't agree — triage, not a regression |

## Safety model

- Drives a **throwaway scaffolded fixture**, never a real workspace.
- The cockpit binds `127.0.0.1` with a **known token** (`AIOS_GUI_TOKEN`); the URL never
  leaves the machine.
- The driver may run **only** `agent-browser` (default-deny; shell metacharacters rejected).
- Flow A's cockpit permission is enforced **server-side** by a named, deny-by-default policy
  (`AIOS_GUI_TEST_POLICY=ux-onboarding`, defined in `gui/server/tool-policy.mjs`) that **exact-argv**
  matches only the firecrawl-extract / suggest-connectors commands — chained or metacharacter-laden
  commands are denied — and the audit re-derives each verdict from the same matcher (no drift).
- The judge is **pure** and never imports an SDK, so the gate logic is testable and free in CI.
- Trust invariants are checked by **judge-independent post-asserts** (no silent `USER.md` write
  in Flow A; the install actually landed + the elevated-consent contract holds in Flow B).
- The HIGH → typed-confirm consent path is covered deterministically by
  [`test/skill-install.test.mjs`](../skill-install.test.mjs) — referenced, not duplicated here.
