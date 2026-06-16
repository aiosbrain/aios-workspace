# Phase 3 — Skills Library (cockpit) + skill-install security model

> Status: **plan** (branch `feat/skills-library`). Phases 1/2/4 of the cockpit
> overhaul shipped in #16. This is the deferred Skills surface, scoped so the
> *curation* is reputable (Anthropic-first) and the *installation* is safe by
> construction.

## Context

The cockpit has Integrations but no Skills surface. We want a **getting-started
skills library**: a small, curated set of high-signal skills a beginner to
agentic agents can browse and install into their workspace's `.claude/skills/`,
plus a **security model** so installing a skill can't quietly run hostile code or
smuggle prompt-injection. The install plumbing already exists and will be reused —
`scripts/connector.mjs`'s `skill` transport (`copyDir` → `.claude/skills/<id>/` →
`gen-catalog.mjs --repo`, `connector.mjs:252-262`). This phase adds (1) a vetted
library, (2) a security/verification layer in front of the copy, and (3) the UI.

---

## Research basis (authoritative, cited)

All facts below are from Anthropic primary sources, adversarially verified
(deep-research run, 12 claims confirmed 3-0/2-0):

- **Agent Skills = folders of instructions + scripts + resources**, discovered via
  a required `SKILL.md` whose YAML frontmatter (`name`, `description`) is the first
  level of progressive disclosure.
  [anthropic.com/engineering/equipping-agents…](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- **Skills can bundle code Claude executes as tools at its discretion** — i.e.
  installing a skill can carry executable code. (same source)
- **Official inventory:** `anthropics/skills` ships ~17 skills across Creative &
  Design, Development & Technical, Enterprise & Communication, and Document
  categories, including meta/builder skills `skill-creator`, `mcp-builder`,
  `web-artifacts-builder`.
  [github.com/anthropics/skills](https://github.com/anthropics/skills/tree/main/skills)
- **Licensing (load-bearing):** most skills are **Apache-2.0** (redistributable),
  **but the document skills `docx`/`pdf`/`pptx`/`xlsx` are "source-available, NOT
  open source"** — Anthropic shares them "as a reference," not for OSS
  redistribution. The repo also disclaims all skills as **"demonstration and
  educational purposes only… test thoroughly before relying on them."**
  [github.com/anthropics/skills](https://github.com/anthropics/skills)
- **The four document skills are also Anthropic-hosted pre-built skills** (PowerPoint,
  Excel, Word, PDF) usable directly via `skill_id` on the Claude API / claude.ai —
  so users don't need us to redistribute them.
  [platform.claude.com/…/agent-skills/overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- **Anthropic's security guidance:** install skills **only from trusted sources**
  (self-authored or from Anthropic); a malicious skill can "direct Claude to invoke
  tools or execute code in ways that don't match the Skill's stated purpose,"
  risking **data exfiltration / unauthorized access**. Before install, **audit all
  bundled files** (SKILL.md, scripts, images) for "unusual patterns like unexpected
  network calls, file access, or operations that don't match the stated purpose";
  **external-URL-fetching skills are particularly risky**; **treat like installing
  software**.
  [overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) ·
  [engineering post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- **Scanning is necessary but not sufficient** (provenance is the real anchor):
  independent research shows malicious skills slipping past scanners and using
  `SKILL.md`/bundled scripts for shell access and exfiltration via third-party
  marketplaces.
  [arxiv 2510.26328](https://arxiv.org/html/2510.26328v1) ·
  [Snyk ToxicSkills](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/) ·
  [VentureBeat — scanners bypassed](https://venturebeat.com/security/anthropic-skill-scanners-passed-every-check-malicious-code-test-file)
- A vetted first-party channel exists for the future: the official
  **`anthropics/claude-plugins-official`** marketplace (manifest-defined).
  [marketplace.json](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json)

**Design consequences:** (1) v1 ships only **vendored, Apache-2.0, official**
skills + the workspace's own; **no arbitrary URL/marketplace install**. (2) The
**source-available doc skills are NOT redistributed** — we surface them as
"official, install from Anthropic" pointers instead. (3) The installer enforces an
**audit + provenance + integrity** gate, treating scanning as advisory and
provenance as the trust anchor.

---

## (A) Curated getting-started shortlist

Small and high-signal — a beginner's "first skills," not a catalog. Every bundled
skill is **Apache-2.0, official Anthropic, vendored at a pinned commit** with its
`LICENSE` preserved. Final set is curated at implementation against the pinned
`anthropics/skills` tree (enumerate the Apache-2.0 entries; the names below are the
confirmed-foundational ones).

### Bundled (vendored, Apache-2.0)
| Skill | What it does | Why foundational for a beginner | Source / reputability |
|---|---|---|---|
| **skill-creator** | Scaffolds and structures new `SKILL.md` skills. | The "learn to fish" skill — teaches the SKILL.md format so users extend their own workspace. | anthropics/skills · official, Apache-2.0 |
| **mcp-builder** | Guides building MCP servers (4-phase: research → implement → review → eval). | The on-ramp to *extending* the agent with new integrations — pairs with AIOS's Integrations hub. | anthropics/skills · official, Apache-2.0 ([SKILL.md](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md)) |
| **web-artifacts-builder** | Builds self-contained web artifacts (interactive HTML/visual output). | First taste of agent-built deliverables beyond plain text. | anthropics/skills · official, Apache-2.0 |
| *(curate 2–4 more)* | From the Apache-2.0 Dev/Technical & Enterprise/Communication categories. | Pick ones that fit knowledge-work (AIOS audience). | anthropics/skills · official, Apache-2.0 |

### Referenced, NOT bundled (source-available → license-incompatible with OSS redistribution)
| Skill | Why referenced not bundled | How we surface it |
|---|---|---|
| **pdf / docx / pptx / xlsx** | "Source-available, not open source" — we may not redistribute in this OSS repo. But they're the canonical document skills and Anthropic-hosted. | Show as **official cards marked "Install from Anthropic"** linking to the upstream skill + the hosted `skill_id` docs; no copy into the repo. Optional later: opt-in fetch-on-install at a pinned commit with the license + disclaimer shown. |

### Excluded
Low-traction third-party skills (single-maintainer, unvetted, marketplace-only).
Out of scope until a provenance/signing channel exists (see future work).

---

## (B) Skill-install security model

Layered, install-time + runtime, each layer cheap to implement:

1. **Provenance / trust tier (the real anchor).** Only the vendored first-party
   library is installable in v1. Each library skill carries provenance metadata in
   the manifest: `upstream_repo`, `upstream_commit`, `vendored_at`, `license`,
   `category`. No URL/marketplace install path exists yet → the supply-chain
   surface is a reviewed git vendoring step, not a runtime fetch.
2. **Integrity lock.** `gui/server/skill-library/index.json` records a **SHA-256
   per bundled file** (and a per-skill rollup). The installer recomputes hashes
   immediately before `copyDir` and **refuses on any mismatch** — detects tampering
   of the vendored snapshot. (Generated by a small `scripts/lock-skill-library.mjs`
   run when vendoring/updating.)
3. **Static safety scan (Anthropic's "audit," automated).** Before install, scan
   `SKILL.md` + every bundled file and surface findings:
   - **Carries code** — presence of `*.mjs/*.py/*.sh/*.js` → "this skill can run
     code on your machine."
   - **Network egress** — `fetch(`, `http`, `https`, `curl`, `wget`, `requests`,
     `urllib`, `net.`, socket APIs.
   - **Filesystem/process** — `child_process`, `exec`, `spawn`, `subprocess`,
     `os.system`, `eval(`, `fs.write`, deletes.
   - **Secret/exfil** — reads of `.env`/`.env.keys`, `AWS_`, `process.env` dumps,
     base64-then-network.
   - **External URLs in SKILL.md** — flagged as high-risk per Anthropic.
   - **Prompt-injection signals in SKILL.md** — "ignore previous/all instructions,"
     "disregard," role overrides, exfiltration verbs, and **zero-width / bidi /
     hidden Unicode** (a common hiding trick).
   The scan returns the exact flagged file + line for each hit.
4. **Risk class + proportional, informed consent.** Classify from the scan:
   `instructions-only` (no code, no net) = **low**; `carries-code` = **elevated**;
   `network / secret / external-URL` = **high**. Low → one-click install. Elevated/
   high → the UI shows the flagged lines and requires an explicit **typed confirm**
   ("treat like installing software"). Nothing installs silently.
5. **Runtime guard reuse (defense in depth).** Installed skills live in
   `.claude/skills/`; the workspace's existing **PreToolUse `team-ops-guard`** (OGR08)
   already vets Writes/Edits and secret patterns at *run* time, and the cockpit
   already prompts for Bash/network tools. So even a skill that later acts is
   governed — the install scan is the first gate, the guard is the backstop.
   [claude-code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing) ·
   [permissions](https://code.claude.com/docs/en/permissions)
6. **Install ledger + safe uninstall.** Record each install in
   `.aios/skills-installed.json`: `{ id, version, upstream_commit, sha, installedAt }`.
   **Uninstall is safe-only** — it removes a skill dir **only if its on-disk hash
   still matches the ledger** (i.e. the user didn't edit it); a modified/user-
   authored skill is never deleted, just flagged. (Resolves the Phase-3 "safe
   uninstall" note from the original plan.)
7. **Honest framing.** The UI states scanning is **advisory** and that trust comes
   from provenance (official + vendored + hash-locked), echoing the
   scanner-bypass research. Bundled official skills also carry Anthropic's own
   "demonstration/educational — test before relying" disclaimer on their card.

---

## Architecture & files

Reuse, don't fork — extend the connector skill path and the catalog reader.

- **`gui/server/skill-library/<id>/`** — vendored Apache-2.0 official skills
  (`SKILL.md` + files + `LICENSE`). **`gui/server/skill-library/index.json`** —
  manifest: per-skill `{ id, name, description, category, risk, provenance, files:
  [{path, sha256}] }`. Plus `referenced.json` for the not-bundled doc-skill pointers.
- **`scripts/lock-skill-library.mjs`** (new) — (re)compute hashes + write the
  manifest when vendoring/updating; a CI/validator check can assert the lock matches
  the tree (an OGR09).
- **`scripts/skill-scan.mjs`** (new) — the static scanner (pure, reusable by server
  + a CLI + the validator). Returns `{ riskClass, findings: [{file, line, rule, snippet}] }`.
- **`scripts/gen-catalog.mjs`** — extend `readSkills()` to also return the **directory
  id** (today it returns `name/kind/description` only) so installed-status compares
  by id.
- **`gui/server/index.mjs`** — token-gated, id-sanitized (`^[a-z0-9-]+$`):
  - `GET /api/skills` → library ∪ installed (`readSkills(repo)`), each `{id, name,
    description, category, risk, installed, bundled, provenance}`.
  - `GET /api/skills/:id/scan` → run `skill-scan` against the library skill; return
    the risk report.
  - `POST /api/skills/:id/install` → verify integrity hash → `copyDir` (reuse
    `connector.mjs` helper) → `gen-catalog.mjs --repo` → write ledger. Reject on
    hash mismatch or unknown id.
  - `POST /api/skills/:id/uninstall` → safe-only (hash-matches-ledger) removal.
- **`gui/client/src/App.jsx`** — `Skills` nav + `SkillsPanel` modeled on
  `IntegrationsPanel` (reuse `.int-*` styles): grouped cards (category), a **risk
  badge**, `Installed` / `Review & install`. "Review & install" opens a small modal
  showing the scan findings (flagged lines) + the consent gate; referenced doc-skill
  cards show "Install from Anthropic ↗".
- **`validation/check-skill-library.mjs`** (new, OGR09) — assert: manifest hashes
  match the tree; every bundled skill is Apache-2.0 with a `LICENSE`; no bundled
  skill is one of the source-available doc skills; ids match `^[a-z0-9-]+$`.

---

## Verification

1. **Vendoring + lock:** run `scripts/lock-skill-library.mjs`; confirm `index.json`
   hashes match; `check-skill-library.mjs` (OGR09) passes; `validation/validate-all.sh`
   stays green on a fresh scaffold.
2. **Scanner unit tests:** feed `skill-scan.mjs` fixtures — a clean instructions-only
   skill (→ low), a code-carrying skill (→ elevated), and an injection/exfil fixture
   (zero-width chars + `fetch` + `.env` read → high with exact line hits).
3. **Install flow (live):** in the cockpit, install `skill-creator`, confirm it lands
   in `.claude/skills/skill-creator/`, the catalog refreshes, the ledger records the
   hash, and it then triggers in chat by its description.
4. **Integrity + consent:** tamper a vendored file → install is refused on hash
   mismatch; an elevated/high skill cannot install without the typed confirm.
5. **Safe uninstall:** uninstall a pristine skill (removed); edit an installed
   skill then uninstall → refused/flagged, not deleted.
6. **Licensing guard:** OGR09 fails if a source-available doc skill is ever vendored.

## Future work (explicitly out of v1 scope)
- Opt-in **fetch-on-install** for the source-available doc skills at a pinned commit,
  with license + disclaimer surfaced and the same scan/consent gate.
- A **provenance/signing** channel to safely admit the official
  `anthropics/claude-plugins-official` marketplace and, later, vetted community skills.
- Optional **sandboxed dry-run** of a skill's bundled scripts before first use.
