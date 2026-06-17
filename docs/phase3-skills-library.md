# Phase 3 — Skills Library (cockpit): trusted official-library MVP

> Status: **plan** (branch `feat/skills-library`). Phases 1/2/4 of the cockpit
> overhaul shipped in #16. This is the deferred Skills surface. Scope is
> deliberately narrow: **v1 installs only vendored, official, Apache-2.0 skills**,
> so safety comes from *provenance + integrity + capability disclosure* — not from
> trying to vet untrusted code. The heavier threat machinery (static scanner, risk
> tiers, typed consent) is deferred to a later **untrusted-install** phase, where
> it actually earns its keep.

## Context

The cockpit has Integrations but no Skills surface. We want a **getting-started
skills library**: a small, curated set of high-signal **official Anthropic** skills
a beginner can browse and install into their workspace's `.claude/skills/`, so they
can do more with Claude immediately. The install plumbing already exists and is
reused — `scripts/connector.mjs`'s `skill` transport (`copyDir` →
`.claude/skills/<id>/` → `gen-catalog.mjs --repo`, `connector.mjs:252-262`) and its
`ensureGitignore` helper. This phase adds (1) a vendored official library, (2) a
thin provenance/integrity/disclosure layer in front of the copy, and (3) the UI.

---

## Research basis (authoritative, cited)

From Anthropic primary sources, adversarially verified (deep-research run, 12 claims
confirmed 3-0/2-0) plus a direct license read:

- **Agent Skills = folders of instructions + scripts + resources**, discovered via a
  required `SKILL.md` whose YAML frontmatter (`name`, `description`) is the first
  level of progressive disclosure; **skills can bundle code Claude executes as tools
  at its discretion**.
  [anthropic.com/engineering/equipping-agents…](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- **Official inventory:** `anthropics/skills` ships ~17 skills across Creative &
  Design, Development & Technical, Enterprise & Communication, and Document
  categories, including meta/builder skills `skill-creator`, `mcp-builder`,
  `web-artifacts-builder`.
  [github.com/anthropics/skills](https://github.com/anthropics/skills/tree/main/skills)
- **Licensing — DEFINITIVE (read the actual LICENSE):** most skills are **Apache-2.0**
  (free to bundle/redistribute). The four document skills `docx`/`pdf`/`pptx`/`xlsx`
  carry a **proprietary LICENSE.txt** that *explicitly forbids* redistribution:
  > "Reproduce or copy these materials… Distribute, sublicense, or transfer these
  > materials to any third party… retain copies of these materials outside the
  > Services."

  [skills/pdf/LICENSE.txt](https://github.com/anthropics/skills/blob/main/skills/pdf/LICENSE.txt).
  → **We must not vendor, fetch-into-the-repo, or ship those four.** Intent is
  irrelevant to the terms: bundling them into a distributed toolkit *is* "reproduce +
  distribute to third parties." The same four are **Anthropic-hosted prebuilt skills**
  usable via `skill_id` inside Claude, so we surface them as **"enable in Claude ↗"
  pointers** — users still get started, with zero restricted bytes copied.
  [platform.claude.com/…/agent-skills/overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- **Anthropic's security guidance:** install skills **only from trusted sources**
  (self-authored or from Anthropic); a malicious skill can "direct Claude to invoke
  tools or execute code in ways that don't match the Skill's stated purpose"
  (exfiltration / unauthorized access); **treat like installing software**.
  [overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
  → v1 stays squarely inside "trusted source": **vendored official only.**
- **Scanning is necessary-but-not-sufficient; provenance is the anchor** — malicious
  skills have slipped past scanners and abused `SKILL.md`/bundled scripts for shell
  access and exfiltration in third-party marketplaces. This is why v1 leans on
  provenance, not a scanner, and defers regex scanning to the untrusted phase.
  [arxiv 2510.26328](https://arxiv.org/html/2510.26328v1) ·
  [Snyk ToxicSkills](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/) ·
  [VentureBeat — scanners bypassed](https://venturebeat.com/security/anthropic-skill-scanners-passed-every-check-malicious-code-test-file)
- A vetted first-party channel exists for the future untrusted-install phase: the
  official **`anthropics/claude-plugins-official`** marketplace (manifest-defined).
  [marketplace.json](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json)

---

## (A) Curated getting-started shortlist

Small and high-signal — a beginner's "first skills," not a catalog. Every bundled
skill is **Apache-2.0, official Anthropic, vendored at a pinned commit** with its
`LICENSE` preserved. Final set is curated at implementation against the pinned
`anthropics/skills` tree (enumerate the Apache-2.0 entries; names below are the
confirmed-foundational ones).

### Bundled (vendored, Apache-2.0 — free to redistribute)
| Skill | What it does | Why foundational for a beginner | Source / reputability |
|---|---|---|---|
| **skill-creator** | Scaffolds and structures new `SKILL.md` skills. | The "learn to fish" skill — teaches the SKILL.md format so users extend their own workspace. | anthropics/skills · official, Apache-2.0 |
| **mcp-builder** | Guides building MCP servers (4-phase: research → implement → review → eval). | On-ramp to *extending* the agent with new integrations — pairs with AIOS's Integrations hub. | anthropics/skills · official, Apache-2.0 ([SKILL.md](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md)) |
| **web-artifacts-builder** | Builds self-contained web artifacts (interactive HTML/visual output). | First taste of agent-built deliverables beyond plain text. | anthropics/skills · official, Apache-2.0 |
| *(curate 2–4 more)* | From the Apache-2.0 Dev/Technical & Enterprise/Communication categories. | Pick ones that fit knowledge-work (AIOS audience). | anthropics/skills · official, Apache-2.0 |

> Per-skill vendoring **must** confirm Apache-2.0 + copy that skill's `LICENSE`. The
> manifest pins `upstream_commit`; OGR09 fails the build if a vendored skill lacks an
> Apache-2.0 `LICENSE` or is one of the four proprietary doc skills.

### Referenced, NOT installable (Anthropic-hosted pointers)
| Skill | Why pointer-only | How we surface it |
|---|---|---|
| **pdf / docx / pptx / xlsx** | Proprietary LICENSE.txt **forbids** copying/redistribution/retaining copies outside the Services. They are Anthropic-hosted prebuilt skills. | An informational card clearly labeled **"Official Anthropic — available in Claude"** with an **"Enable in Claude ↗"** link to the hosted-skill docs. **Not** locally installable; nothing is copied into the repo or the user's machine. |

### Excluded
Low-traction third-party skills (single-maintainer, unvetted, marketplace-only) —
out of scope until the untrusted-install phase ships its provenance/signing channel.

---

## (B) v1 safety model — trusted official library

v1 only installs **vendored, official, Apache-2.0** skills, so safety is carried by
provenance + integrity + honest disclosure, each cheap and low-maintenance:

1. **Provenance (the trust anchor).** Only the vendored first-party library is
   installable; **no URL/marketplace/arbitrary-path install exists.** Each skill's
   manifest entry records `upstream_repo`, `upstream_commit`, `vendored_at`,
   `license`, `category`. The supply-chain surface is a *reviewed git vendoring step*,
   not a runtime fetch.
2. **Integrity guard (scoped honestly).** `gui/server/skill-library/index.json` holds
   a **SHA-256 per bundled file** + per-skill rollup; the installer recomputes hashes
   immediately before `copyDir` and **refuses on mismatch.** This is a
   **post-vendoring integrity guard (detects local tampering/corruption of the
   shipped snapshot), NOT commit-authenticity** — the manifest and files live in the
   same repo, so it does not prove the bytes match upstream. *Stronger provenance =*
   a CI step that re-fetches the declared `upstream_repo@upstream_commit` and diffs
   the vendored bytes (see future work).
3. **License guard.** OGR09 (`check-skill-library.mjs`) asserts every bundled skill
   ships an **Apache-2.0 `LICENSE`** and that **none of the four proprietary doc
   skills is ever vendored.** Build fails otherwise.
4. **Capability disclosure (not a scanner).** At vendoring time
   `lock-skill-library.mjs` records *declared* capabilities per skill —
   `bundles_code` (any `*.mjs/*.py/*.sh/*.js`), the file list, and file types — into
   the manifest. The card shows them plainly ("includes scripts: `foo.py`") so the
   user knows what they're enabling. No regex threat-scanning, no false-positive
   maintenance — these are trusted official skills; we *disclose*, we don't *vet*.
5. **Install collision rules (explicit).** If `.claude/skills/<id>/` already exists,
   install **refuses** unless the install ledger + on-disk hash prove it's the same
   library skill at the same version (an idempotent re-install / update). A
   user-authored or modified skill at that id is **never overwritten** without an
   explicit, separate "replace" confirmation.
6. **Symlink rejection.** Before hashing/copying, the installer walks the vendored
   tree and **refuses any symlink** (a vendored skill must be plain files only) — no
   copying a link that escapes the skill dir.
7. **Ledger + safe uninstall (atomic).** Each install appends to
   `.aios/skills-installed.json` — `{ id, version, upstream_commit, sha, installedAt }`
   — written **atomically** (temp file + `rename`). **Uninstall is safe-only:** it
   removes a skill dir **only if the on-disk hash still matches the ledger**; a
   user-edited skill is flagged, never deleted.
8. **`.gitignore` self-heal.** New scaffolds already gitignore `.aios/`, but **older
   workspaces may not.** On GUI startup (and again on install/uninstall) ensure
   `.aios/` is present in the target repo's `.gitignore` — reuse
   `connector.mjs:ensureGitignore`.
9. **Runtime guard (defense in depth, free).** Installed skills live in
   `.claude/skills/`; the workspace's existing **PreToolUse `team-ops-guard`** (OGR08)
   vets Writes/Edits + secret patterns at run time, and the cockpit already prompts
   for Bash/network tools — so even a skill that later acts is governed.
10. **Honest framing in UI.** Cards note these are official Anthropic skills carrying
    Anthropic's own *"demonstration/educational — test before relying"* disclaimer.

---

## Architecture & files

Reuse, don't fork — extend the connector skill path and the catalog reader.

- **`gui/server/skill-library/<id>/`** — vendored Apache-2.0 official skills
  (`SKILL.md` + files + `LICENSE`). **`…/index.json`** — manifest: per-skill
  `{ id, name, description, category, provenance:{upstream_repo, upstream_commit,
  vendored_at, license}, capabilities:{bundles_code, files:[…]}, files:[{path, sha256}] }`.
  Plus a small `referenced.json` for the four Anthropic-hosted doc-skill pointers
  (no files, just label + docs link).
- **`scripts/lock-skill-library.mjs`** (new) — recompute hashes, record capabilities,
  **reject symlinks**, write the manifest when vendoring/updating.
- **`scripts/gen-catalog.mjs`** — extend `readSkills()` to also return the **directory
  id** (today only `name/kind/description`) so installed-status compares by id.
- **`gui/server/index.mjs`** — token-gated, id-sanitized (`^[a-z0-9-]+$`):
  - `GET /api/skills` → library ∪ installed (`readSkills(repo)`), each `{id, name,
    description, category, installed, bundled, provenance, capabilities}`; plus the
    `referenced` pointer entries.
  - `POST /api/skills/:id/install` → collision check → symlink/hash verify → `copyDir`
    (reuse `connector.mjs`) → `gen-catalog.mjs --repo` → `ensureGitignore('.aios/')`
    → atomic ledger append. Reject on hash mismatch / unknown id / collision.
  - `POST /api/skills/:id/uninstall` → safe-only (hash-matches-ledger) removal.
- **`gui/client/src/App.jsx`** — `Skills` nav + `SkillsPanel` modeled on
  `IntegrationsPanel` (reuse `.int-*` styles): grouped cards (category) showing the
  capability line + `Installed`/`Install`. Referenced doc-skill cards show **"Enable
  in Claude ↗"** and are visibly non-installable.
- **`validation/check-skill-library.mjs`** (new, OGR09) — assert: manifest hashes
  match the tree; every bundled skill is Apache-2.0 with a `LICENSE`; **no bundled
  skill is a proprietary doc skill**; ids match `^[a-z0-9-]+$`; no symlinks in the tree.

---

## Verification

1. **Vendoring + lock:** run `lock-skill-library.mjs`; `index.json` hashes match;
   OGR09 passes; `validation/validate-all.sh` green on a fresh scaffold.
2. **License guard:** OGR09 fails if a proprietary doc skill or a non-Apache-2.0 skill
   is vendored.
3. **Install (live):** install `skill-creator` in the cockpit → lands in
   `.claude/skills/skill-creator/`, catalog refreshes, ledger records the hash
   (written atomically), `.aios/` ensured in `.gitignore`, and it triggers in chat.
4. **Integrity + collision:** tamper a vendored file → install refused (hash); a
   pre-existing user-authored `.claude/skills/<id>/` → install refused (collision), no
   overwrite.
5. **Symlink rejection:** a symlink in a vendored tree → `lock`/install refuses.
6. **Safe uninstall:** pristine skill → removed; edited installed skill → flagged, not
   deleted.
7. **Gitignore self-heal:** an old workspace missing `.aios/` in `.gitignore` → ensured
   on startup/install.

---

## Future work — untrusted-install phase (where the heavy machinery belongs)

Only once we admit skills beyond the vendored official set:
- **Provenance verification in CI** — re-fetch `upstream_repo@upstream_commit` and diff
  the vendored bytes, upgrading the integrity guard from "post-vendoring" to true
  upstream authenticity.
- **Static safety scanner + risk tiers + typed consent** — regex/heuristic scan of
  `SKILL.md` + bundled files (bundled code, network egress, secret/exfil patterns,
  external URLs, prompt-injection incl. zero-width/bidi Unicode), risk classification,
  and a risk-proportional typed-confirm gate. Deferred here because for vendored
  official skills it adds false positives + maintenance without changing the trust
  story.
- **Provenance/signing channel** to safely admit the official
  `anthropics/claude-plugins-official` marketplace and, later, vetted community skills.
- **Document skills:** remain **pointer-only**. Any local-copy/fetch workflow would
  also be "retain copies outside the Services," which the LICENSE forbids — so it
  requires **explicit written permission / license review from Anthropic**, not an
  engineering toggle.
- Optional **sandboxed dry-run** of a skill's bundled scripts before first use.
