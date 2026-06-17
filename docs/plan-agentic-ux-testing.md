# Plan — Agentic end-to-end UX testing for the cockpit

> Status: **proposal.** Implementation-ready plan for adding agent-driven, intent-level
> UX testing (an LLM that drives the cockpit by goal and *judges* the experience) to the
> AIOS workspace. It augments the owner's manual testing — it does not replace it. No code
> ships in this PR; this is the design + pilot spec.

## TL;DR recommendation

- **Driver (recommended): `agent-browser` + its built-in `dogfood` skill.** The owner already
  has this local agentic browser CLI. It drives a real Chromium by *intent* over the
  accessibility tree (snapshot → `@ref` → act), captures annotated screenshots, and ships an
  exploratory-QA workflow that produces repro-evidence reports. It reaches `http://127.0.0.1`
  with zero setup and is resilient to DOM churn because the agent re-snapshots and re-grounds
  every step. Zero new runtime dependency.
- **Judge: an isolated, rubric-driven LLM-as-judge per flow,** grading screenshots + the
  transcript against a fixed rubric, with structured JSON output and a numeric threshold so a
  run can gate. Follow Anthropic's eval guidance: one dimension per judge, calibrate against
  the owner's own verdicts, let the judge answer "Unknown."
- **Alternatives:** **Magnitude** (purpose-built AI-native *test runner* with `webServer`/localhost
  config + visual `Verify` assertions) if we want a declarative spec-file suite; **Stagehand**
  (`env:"LOCAL"`, code-controllable, CDP-native) if we want to write the harness in TypeScript.
- **Constraint that shapes everything:** the cockpit is a **localhost web app** served over HTTP
  on `127.0.0.1` (see `gui/server/index.mjs`). Every browser-agent tool drives its *own* Chromium
  against that URL — **none attach to the native Tauri WKWebView on macOS** (CDP-into-the-webview
  is Windows/WebView2 only). So we test the served web UI, not the Tauri shell. That is the
  right call: the entire UX lives in the React client, and the shell is a thin wrapper.
- **How to run it:** *not* per-PR. These runs cost tokens and are mildly non-deterministic.
  Run the pilot **manually on demand** and on a **nightly/pre-release** schedule, gated on the
  rubric thresholds — never blocking a docs-only PR.

---

## Why this shape (and why not raw Playwright)

The owner explicitly does not want brittle, selector-based Playwright scripts, and the cockpit's
DOM churns: chat messages stream token-by-token, the model picker disables mid-turn, the Skills
grid regroups by category, modals mount/unmount. A hard-coded `page.click('.int-connect')`
breaks the moment a class name or layout changes. The agentic approach is resilient because the
driver **re-derives the page on every step** and acts on *intent* ("open the Skills tab and
install the first community skill"), and the assertions grade *experience* ("did the install
clearly require consent before writing?") rather than asserting on exact text nodes.

This is the same reason the broader ecosystem is going agentic on top of Playwright/CDP — Stagehand
v3 dropped its hard Playwright dependency for CDP-native control, browser-use rebuilt on direct CDP,
and Playwright itself is sprouting AI/self-healing layers
([Playwright AI ecosystem, 2026](https://testdino.com/blog/playwright-ai-ecosystem)).

---

## The cockpit surfaces under test (grounded in the code)

Read from `gui/client/src/App.jsx` and `gui/server/index.mjs`. The UX-critical flows:

| Flow | Where in the code | What "good UX" means |
|------|-------------------|----------------------|
| **Chat — model picker mid-session switch** | `App.jsx` `changeModel`, `<select className="model-pick">`, server `/api/config/model`, `model` WS event | Switching Sonnet↔Opus mid-chat persists (POST), is reflected back (`model` event keeps picker in sync), and is **disabled while a turn is in flight** (`disabled={busy}`). |
| **Resumable chats sidebar** | `App.jsx` `loadChats`/`openChat`/`newChat`, server `/api/sessions`, `.aios/sessions/*.jsonl` | Past chats list by recency, clicking one **replays the transcript** then resumes the SDK session; "+ New chat" starts fresh; the active chat is highlighted. |
| **Context meter** | `App.jsx` `ContextMeter`, `usage` WS event | After the first turn, shows `~Nk / 200k` and a fill bar; labeled "est." |
| **Markdown rendering** | `App.jsx` `MD_COMPONENTS`, `ReactMarkdown` | Assistant text renders headings/lists/code/tables; links open in a new tab `rel="noreferrer"` (so the `?token=` is never leaked). |
| **Skills — official one-click** | `App.jsx` `SkillsPanel` `act(id,"install")`, server `/api/skills/:id/install` | Official skills install in one click; card flips to "● installed"; counter updates. |
| **Skills — community scan + consent** | `App.jsx` `SkillReviewModal`, server `/api/skills/:id/scan` + install gate | "Review & install" opens a modal showing the advisory scan (findings, risk badge); install is gated on a consent checkbox; **HIGH-risk community skills require typing the skill id**. |
| **Skills — marketplace install** | `App.jsx` marketplace cards + `SkillReviewModal` (`trust:"marketplace"`) | Fetched-on-install at a pinned commit, byte-verified; simple accept (no typed confirm). |
| **Settings → Personality** | `App.jsx` `SettingsPanel` `pick(id)`, server `/api/config/personality` | Selecting a personality marks it "● active" and **starts a new chat** so the voice applies. |
| **Onboarding — draft-from-link** | `App.jsx` empty-state `enrich-form`, `firecrawl-direct` skill | Empty state offers "Set up your profile" **and** "draft it from a link"; submitting a URL sends a Firecrawl-backed enrich prompt; the agent **drafts and confirms before writing** `.claude/memory/`. The note states plainly that the URL is sent to Firecrawl. |
| **Onboarding — suggest connectable integrations** | `App.jsx` `IntegrationsPanel` team-blueprint section ("Your team uses these N tools"), server `/api/blueprint` | Team-recommended tools surface in their own section above the rest; each is connectable via the wizard. |
| **Integrations connect wizard** | `App.jsx` `ConnectWizard`, server `/api/connectors/:id/{validate,store}` | Three steps (get key → paste → live check); on success shows identity/instance and a "Try it in chat →" CTA; key is stored encrypted, never echoed. |

**Launch + auth model (load-bearing for the harness):** `npm run gui` builds the client if needed
and starts the server, which binds **`127.0.0.1` only** and prints
`open: http://127.0.0.1:<port>/?token=<TOKEN>` (`gui/server/index.mjs` `server.listen`). The token
gates the WebSocket upgrade and every sensitive REST route. The harness must **read that token URL
from stdout and pass the whole `?token=…` URL to the agent** — without it the app shows
"connecting…" forever.

---

## Recommended approach — `agent-browser` + `dogfood`, with a rubric judge

### Why `agent-browser`
- **Already in the owner's toolbelt** (global `CLAUDE.md`), version-matched skills, Rust client. Zero
  new dependency to vet or vendor.
- **Local-first by design** — it drives a real Chrome/Chromium via CDP and opens any URL including
  `http://127.0.0.1:<port>/?token=…`. No tunnel, no cloud, no public URL. This matters because most
  cloud browser-agent SaaS (Browserbase cloud, Browser Use Cloud, Skyvern Cloud) assume a *public*
  URL and would need a tunnel to reach the cockpit.
- **Intent-level + DOM-churn resilient** — the core loop is `open → snapshot -i → act on @ref →
  re-snapshot`. Refs are re-derived every snapshot, so streaming chat / remounting modals don't
  break it the way fixed selectors do.
- **UX-judging is built in** — the bundled **`dogfood`** skill is exactly the pattern we want: it
  systematically explores an app, takes **annotated screenshots** at each step, checks the **browser
  console for errors**, tries realistic end-to-end workflows, and produces a **repro-evidence report**
  (`agent-browser skills get dogfood`). The **`electron`** skill documents the CDP-attach pattern for
  native desktop apps if we ever want to drive the Tauri window on Windows.

### How it drives the localhost cockpit
```bash
# 1. Launch the cockpit against a throwaway scaffolded workspace (never your real repo).
#    Capture the token URL from stdout.
npm run gui -- --repo /tmp/ux-fixture-workspace 2>&1 | tee /tmp/gui.log &
#    -> "open:  http://127.0.0.1:8790/?token=abc123…"
TOKEN_URL=$(grep -m1 -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[a-f0-9]+' /tmp/gui.log)

# 2. Point the agent at the token URL and drive by intent.
agent-browser --session cockpit open "$TOKEN_URL"
agent-browser --session cockpit wait --load networkidle
agent-browser --session cockpit snapshot -i           # discover @refs
agent-browser --session cockpit screenshot --annotate out/01-initial.png
agent-browser --session cockpit errors                # console errors → a UX finding
# …act on refs by intent, re-snapshot after each state change…
```

The driving agent (Claude, via the dogfood skill) is given a **flow goal** in natural language plus
the rubric; it explores, screenshots, and records findings. Because the cockpit is the *same React
client* whether wrapped in Tauri or not, this exercises the real UX.

### How the LLM judges UX (the assertion layer)
Driving is half the job; the other half is **asserting on experience**. We use an **LLM-as-judge**
that grades the captured evidence (screenshots + the step transcript + console output) against a
**fixed rubric per flow**. Best practices, grounded in research:

- **One dimension per isolated judge.** Don't ask one judge to grade everything — grade each rubric
  criterion with its own pass/fail call to cut inconsistency
  ([Anthropic, Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
- **Grade outcomes, not the path.** Judge what the agent produced (the screen, the written file,
  the consent gate), not the exact click sequence
  ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
- **Give the judge an out.** Instruct it to return `"unknown"` when evidence is insufficient, so it
  never fabricates a verdict
  ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
- **Calibrate against the owner.** Before trusting the judge to gate, run it on a handful of flows the
  owner has already verdicted; tune the rubric until they agree; then occasional spot-checks suffice
  ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
- **Make it deterministic enough to gate.** Temperature 0/low, **structured JSON output**
  (`{criterion, pass, reason, confidence}`), and an explicit **numeric threshold** to convert scores
  to a gate — the model exactly used by promptfoo's `llm-rubric`
  ([promptfoo llm-rubric](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/llm-rubric/)).
  Run each judgment **3× and require agreement** (self-consistency); disagreement → flag for human
  review rather than auto-fail
  ([LLM-as-judge calibration](https://www.kinde.com/learn/ai-for-software-engineering/best-practice/llm-as-a-judge-done-right-calibrating-guarding-debiasing-your-evaluators/)).
- **Caveat:** "temperature 0 = deterministic" is **not guaranteed** for reasoning models, some of which
  ignore temperature — verify per model
  ([promptfoo](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/llm-rubric/)).
- **Cheap deterministic gate first, semantic judge second.** Where a pixel/structural diff suffices
  (e.g. the context meter renders at all), use a **golden-screenshot diff** as the cheap gate and
  reserve the LLM judge for the semantic/UX layer
  ([rubric-based / analytic LLM-as-a-judge, Patronus AI](https://www.patronus.ai/llm-testing/llm-as-a-judge)).

Optionally wire the judge through **promptfoo** (OSS, `llm-rubric`/`g-eval`, CI-gateable thresholds,
multi-judge voting — [promptfoo](https://www.promptfoo.dev/docs/guides/llm-as-a-judge/)) or
**Braintrust** ([Braintrust evals](https://www.braintrust.dev/docs/evaluate)) so verdicts land on a
dashboard with history. For a first pilot, a small local Claude-call judge with a JSON schema is
enough.

### Example rubric (onboarding draft-from-link)
```jsonc
// Each criterion graded by its own isolated judge over screenshots + transcript.
{
  "flow": "onboarding-draft-from-link",
  "criteria": [
    { "id": "empty_state_offers_both", "ask": "Does the empty chat clearly offer BOTH 'Set up your profile' AND a 'draft it from a link' option?" },
    { "id": "firecrawl_disclosure",   "ask": "Before/at submit, is it clearly disclosed that the URL is sent to Firecrawl to read the page?" },
    { "id": "draft_shown",            "ask": "Is a drafted profile (person + company + focus) shown back to the user?" },
    { "id": "confirm_before_write",   "ask": "Is the user clearly required to CONFIRM before anything is written to .claude/memory/? (no silent write)" },
    { "id": "no_console_errors",      "ask": "Did the flow complete with no console errors? (evidence: errors output)" }
  ],
  "threshold": 1.0  // onboarding is a trust-critical flow → all criteria must pass
}
```

---

## Alternatives (with tradeoffs)

### Alt 1 — Magnitude (`magnitude-test`, magnitude.run) — declarative AI-native test runner
- **What:** Apache-2.0 AI-native E2E *test runner*: natural-language steps + a vision-grounded LLM
  (Navigate / Interact / Extract / **Verify**), built on Playwright
  ([Magnitude intro](https://docs.magnitude.run/getting-started/introduction);
  [Playwright integration](https://docs.magnitude.run/core-concepts/playwright.md)).
- **Localhost:** first-class — config takes `url: 'http://localhost:5173'` and a `webServer` block with
  `reuseExistingServer: true`
  ([test config](https://docs.magnitude.run/testing/test-configuration.md)).
- **Why consider:** it's a *suite* (spec files, visual `Verify` assertions, a runner) rather than an
  ad-hoc driving session — better if we want many flows checked in and run consistently. Recommended
  executor is **Claude Sonnet** (it warns OpenAI/Gemini/Llama aren't vision-grounded and won't work as
  the executor — [compatible LLMs](https://docs.magnitude.run/core-concepts/compatible-llms.md)).
- **Tradeoff:** a new dependency + its own DSL to learn; ~4k stars and a slower release cadence
  (`magnitude-core@0.3.1`, Feb 2026) than the frontier agents; funding/backing **unverified**. The
  `webServer` block auto-launches a dev server — we'd need it to launch `npm run gui` and we'd still
  have to thread the **token URL** in (its happy path assumes an unauthenticated dev URL).

### Alt 2 — Stagehand (Browserbase) — code-controllable, CDP-native
- **What:** MIT SDK for browser agents — `act()/extract()/observe()/agent()` over the a11y tree; v3
  (Oct 2025) dropped the hard Playwright dependency and went **CDP-native**
  ([Stagehand](https://github.com/browserbase/stagehand);
  [v3 blog](https://www.browserbase.com/blog/stagehand-v3)).
- **Localhost:** set **`env: "LOCAL"`** to run the browser on your machine (or attach via
  `cdpUrl`), then navigate `http://127.0.0.1:<port>/?token=…` directly — no tunnel
  ([browser config](https://docs.stagehand.dev/v2/configuration/browser)). (Browserbase *cloud* would
  need a tunnel — don't use cloud here.)
- **Why consider:** strongest **code-level control** if we want the harness in TypeScript with precise
  primitives; well-funded and very active (Browserbase $40M Series B;
  [funding](https://www.builtinsf.com/articles/browserbase-announces-40m-series-b-funding-20250618)).
- **Tradeoff:** more harness code to write/own; we'd bolt on our own screenshot+judge layer (no
  built-in "dogfood"-style UX report). Best when intent-driving needs to interleave with exact code.

### Also-rans (verified, but not recommended here)
- **browser-use** — huge (~99k stars), MIT, local by default, CDP after its Rust rebuild
  ([browser-use](https://github.com/browser-use/browser-use)). A great general agent, but it's an
  *automation* library, not a UX-test harness — we'd build the assertion layer from scratch. Fine as a
  driver substitute for `agent-browser` if preferred.
- **Skyvern (self-hosted)** — AGPL-3.0, vision+LLM, self-hosted reaches localhost without a tunnel
  ([Skyvern](https://github.com/Skyvern-AI/skyvern)). Heavier (Docker stack, its own UI); AGPL is a
  licensing consideration for an OSS toolkit.
- **Anthropic Computer Use** — pure-vision desktop control; the **only** option that could drive the
  *native* Tauri window, but **you must host the desktop/VM** (Linux/X11 reference container) and it's
  still **beta** ([computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)).
  Overkill for a web UI that's reachable on localhost; revisit only if we ever need to test the native
  shell (menu bar, window chrome, OS dialogs).
- **Meticulous** — record-replay visual regression, supports localhost, but it's **not** natural-language
  agentic and is closed/custom-priced ([how it works](https://www.meticulous.ai/how-it-works)). Useful
  *complement* for pure visual regression, not an agentic UX judge.
- **Octomind** — **discontinued** (~April 2026 farewell — [octomind.dev](https://octomind.dev/)). Do not adopt.
- **Shortest (antiwork)** — MIT, NL + Claude + Playwright, localhost-native via `baseUrl`
  ([shortest](https://github.com/antiwork/shortest)); attractive but its latest *tagged* release is
  old (v0.4.9, Apr 2025) — treat as early-stage, verify maintenance before relying on it.
- **QA Wolf** — reputable managed service (web + Electron), but demo-gated and expensive (third-party
  estimates tens-to-hundreds of $k/yr) and no confirmed localhost/Tauri support
  ([qawolf.com](https://www.qawolf.com/)). Wrong shape for a self-driven local tool.

---

## The pilot (concrete, two flows, pass/fail criteria)

Goal: prove the loop end-to-end on two **trust-critical** flows, then decide whether to expand.

### Pilot setup
1. **Throwaway fixture workspace.** Stamp one with the existing scaffold (`scripts/scaffold-project.sh`
   into `/tmp/ux-fixture-workspace`) so we never drive the owner's real repo. Pre-seed a Firecrawl key
   in the fixture's dotenvx vault (or stub it) for the onboarding flow.
2. **Launch + capture token URL** (`npm run gui -- --repo /tmp/ux-fixture-workspace`, grep stdout).
3. **Driver:** `agent-browser --session cockpit` per the dogfood loop.
4. **Judge:** per-flow rubric (JSON), temp 0, 3× self-consistency, threshold per flow.

### Flow A — Onboarding "draft from a link"
- **Intent given to the agent:** "On the empty chat screen, use the 'draft it from a link' option with
  `https://example.com/about`. Walk through until the agent shows a drafted profile and asks you to
  confirm. **Do not confirm any write.** Screenshot each step; capture console errors."
- **Pass criteria (rubric above, threshold 1.0):** both onboarding options visible; Firecrawl
  disclosure shown; a draft (person + company + focus) is shown back; **confirmation is required before
  any `.claude/memory/` write** (no silent write); no console errors.
- **Bonus injection check (manual or scripted):** point at a page containing "ignore your instructions…"
  and confirm the agent treats page content as *data*, not commands (mirrors the onboarding-enrichment
  plan's injection test).

### Flow B — Skills "install with consent"
- **Intent given to the agent:** "Open the Skills tab. For an official skill, install it in one click and
  confirm it shows installed. Then for a **community** skill, click 'Review & install', confirm the scan
  findings + risk badge are shown, and confirm install is **blocked until consent is given** (and, for a
  HIGH-risk one, until the skill id is typed)."
- **Pass criteria (threshold 1.0 on the consent gate; ≥0.8 overall):**
  - official install is one click and the card flips to "● installed";
  - community "Review & install" shows the advisory scan (findings with file:line + a risk badge);
  - **install is impossible without ticking consent** (the gate is the load-bearing assertion);
  - HIGH-risk community install additionally requires typing the skill id;
  - no console errors.

### Pilot exit decision
- **Green** (both flows pass on ≥2 consecutive runs, judge agrees with the owner's spot-check) → expand
  to the rest of the table (model-switch, resumable chats, personality, integrations-suggestion) and add
  the nightly schedule.
- **Flaky** (judge verdicts disagree across the 3× runs) → tighten rubrics / lower scope per judge
  before expanding.
- **Red** (driver can't reach the app) → re-check the token-URL capture (the #1 failure mode).

---

## How this complements the owner's manual testing

Agents and humans are good at different things — pair them deliberately.

**Agents are good at (let them own):**
- **Regression sweeps** — re-running the same 10 flows every night so the owner doesn't have to.
- **Tedious gating** — "does the consent checkbox still block install?", "does the model picker still
  disable mid-turn?", "any console errors on each screen?" — boring, high-value, easy to miss by hand.
- **Evidence capture** — annotated screenshots + repro steps for every finding (the dogfood report),
  so a failure hands the owner a reproduction, not just a red X.
- **Breadth** — exercising every tab/empty-state quickly.

**Agents are bad at (keep these manual):**
- **Taste / aesthetic judgment** — "does this *feel* polished/trustworthy?" An LLM judge approximates it
  but the owner is the ground truth (hence calibration + spot-checks).
- **Novel/ambiguous UX decisions** and first-time flows where the *right* behavior isn't yet specified.
- **Real-secret / real-account paths** — connecting the owner's actual Slack/Jira keys, real Firecrawl
  spend, anything that touches a live brain. Keep those on the fixture or manual.
- **Cross-process desktop behavior** (Tauri menu bar, OS file dialogs, window chrome) — out of scope for
  the localhost-web approach; manual, or a future Computer-Use spike.

Division of labor: **the owner specifies intent and judges taste; agents drive, screenshot, and gate the
regressions.** The agent run is the owner's *pre-flight checklist*, run before they sit down to test the
new/interesting parts by hand.

---

## CI, cost, flakiness & gating

- **Do NOT gate PRs on this.** The existing `ci.yml` is fast and deterministic (leak-gate, secret scan,
  scaffold smoke, adapter tests). Agentic UX runs cost tokens and are mildly stochastic — putting them on
  the PR critical path would make CI slow, flaky, and expensive. This PR is **docs-only**, so existing CI
  passes untouched.
- **When to run:**
  - **On demand** — the owner (or an agent) runs the pilot locally before a release or after a cockpit
    change. This is the primary mode.
  - **Nightly / pre-release** — a scheduled job (local cron or a separate manual GitHub workflow with
    `workflow_dispatch`) runs the full suite against a freshly scaffolded fixture and posts the dogfood
    report + judge verdicts as an artifact. Failures notify; they don't block merges.
- **Cost control:** scope each judge to one dimension (smaller prompts); use **Haiku** for cheap
  deterministic checks ("any console error?") and **Sonnet** for the semantic UX judging; cap steps per
  flow; reuse one browser session across a flow. Computer Use's per-call overhead (≈466–499 system +
  735 tool-definition tokens + image tokens — [pricing](https://platform.claude.com/docs/en/about-claude/pricing))
  is one reason to prefer the lighter `agent-browser`/CDP path over pure vision here.
- **Flakiness control:** temperature 0/low; **3× self-consistency** with disagreement → human-review
  (not auto-fail); a cheap **golden-screenshot diff** as the first gate before the LLM judge; `wait
  --load networkidle` + re-snapshot after every state change to avoid racing the streaming UI; per-flow
  thresholds (1.0 for trust-critical gates like consent/confirm-before-write, ≥0.8 elsewhere).
- **Safety:** always run against a **throwaway scaffolded fixture**, never the owner's real workspace or
  a live brain; the token URL is local-only and never leaves the machine; no real secrets in the fixture.

---

## Files this would touch (when we implement — not in this PR)
- `test/ux/` (new) — the dogfood flow scripts + per-flow rubric JSON + a small judge runner.
- `.github/workflows/ux-nightly.yml` (new, `workflow_dispatch` + `schedule`) — optional nightly, never
  on `pull_request`.
- `docs/feature-set.md` — note the agentic-UX harness once it lands.
- No change to `gui/` runtime code is required to *run* the harness (it drives the served UI as-is).

## Out of scope (later)
- Driving the **native** Tauri window (menu bar, OS dialogs) — would need an Anthropic Computer-Use
  spike with a hosted desktop/VM, or CDP-into-WebView2 on Windows only.
- A hosted dashboard for judge history (promptfoo/Braintrust) — start with local JSON artifacts.
- Expanding beyond the cockpit (e.g. CLI UX) — this plan is cockpit-only.

## Sources
- agent-browser CLI (local) — `agent-browser skills get core --full`, `skills get dogfood`, `skills get electron` (installed locally).
- [Anthropic — Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Anthropic — Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) · [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [promptfoo — llm-rubric](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/llm-rubric/) · [LLM-as-a-judge guide](https://www.promptfoo.dev/docs/guides/llm-as-a-judge/)
- [Braintrust — Evaluate](https://www.braintrust.dev/docs/evaluate)
- [LLM-as-a-judge calibration (Kinde)](https://www.kinde.com/learn/ai-for-software-engineering/best-practice/llm-as-a-judge-done-right-calibrating-guarding-debiasing-your-evaluators/) · [Rubric-based / analytic LLM-as-a-judge (Patronus AI)](https://www.patronus.ai/llm-testing/llm-as-a-judge)
- [Stagehand](https://github.com/browserbase/stagehand) · [v3 blog](https://www.browserbase.com/blog/stagehand-v3) · [browser config](https://docs.stagehand.dev/v2/configuration/browser) · [Browserbase Series B](https://www.builtinsf.com/articles/browserbase-announces-40m-series-b-funding-20250618)
- [browser-use](https://github.com/browser-use/browser-use)
- [Skyvern](https://github.com/Skyvern-AI/skyvern)
- [Magnitude — intro](https://docs.magnitude.run/getting-started/introduction) · [Playwright](https://docs.magnitude.run/core-concepts/playwright.md) · [test config](https://docs.magnitude.run/testing/test-configuration.md) · [compatible LLMs](https://docs.magnitude.run/core-concepts/compatible-llms.md)
- [Meticulous — how it works](https://www.meticulous.ai/how-it-works)
- [Octomind (discontinued)](https://octomind.dev/) · [Shortest](https://github.com/antiwork/shortest) · [QA Wolf](https://www.qawolf.com/)
- [Tauri v2 debug / WebView CDP (Windows-only)](https://v2.tauri.app/develop/debug/) · [tauri-cdp (Windows/WebView2)](https://github.com/Haprog/tauri-cdp)
- [Playwright AI ecosystem (2026)](https://testdino.com/blog/playwright-ai-ecosystem)
