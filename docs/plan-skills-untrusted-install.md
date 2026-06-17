# Plan — Skills untrusted-install phase (Phase 3.5)

> Status: **core increment shipped** on `feat/skills-untrusted`. Builds on the Skills
> library (#17), whose v1 deliberately installs only vendored, official, Apache-2.0
> skills. This phase admits skills **beyond** that set — and only then does the heavy
> verification machinery (deferred in #17) earn its keep.
>
> ## Shipped in this increment
> - **`scripts/skill-scan.mjs`** — pure, reusable static scanner. `scanSkill(dir)` →
>   `{ riskClass, findings:[{file,line,rule,snippet}], counts, bundlesCode, codeFiles }`.
>   Flags bundled code, network egress, fs/process exec, secret/exfil reads, external
>   URLs in `SKILL.md`, and prompt-injection (incl. zero-width/bidi/hidden Unicode and
>   "ignore previous instructions"/role-override phrasing). Classifies low/elevated/high.
>   CLI: `node scripts/skill-scan.mjs <dir> [--json]` (exit 1 on high). Tests in
>   `test/skill-scan.test.mjs` (+ fixtures under `test/skill-scan-fixtures/`).
> - **Trust tier + typed-consent gate** in `gui/server/skill-library.mjs`: `official`
>   stays one-click (hash-locked); a new `community` tier (`gui/server/skill-library/community.json`)
>   runs the scanner on install, returns findings, and requires `consent.accepted`; a
>   `high` risk class additionally requires a TYPED confirm (`consent.typed === id`).
>   Endpoint `GET /api/skills/:id/scan`; install accepts a `consent` body. A single
>   demonstration community skill (`community-example`, vendored-demo source) exercises
>   the gate end-to-end. Tests in `test/skill-install.test.mjs`.
> - **UI**: `SkillsPanel` shows a trust badge; community skills open a **Review & install**
>   modal listing scan findings (file:line) + a consent checkbox (+ typed field on high).
>   The copy states plainly that scanning is **advisory** — provenance is the anchor.
> - **OGR09** extended: community ids are disjoint from official (never promoted), each
>   community entry resolves to a scannable source dir.
>
> ## Deferred (clear TODOs)
> - **Fetch-on-install from `repo@commit` + upstream byte-diff authenticity.** The
>   community `source` schema already carries `{kind, dir, upstream_repo, upstream_commit}`;
>   v1 uses `kind: "vendored-demo"` (a locally vendored source). A real fetch transport +
>   byte-diff against the pinned commit is the next slice. See `community.json:note`.
> - **`anthropics/claude-plugins-official` marketplace listing** (a `marketplace-vetted`
>   tier reading `marketplace.json`) — not yet wired.
> - **Sandboxed dry-run** of a skill's bundled scripts before first use.

## Context

#17 shipped a trusted official-library MVP: provenance + integrity lock + capability
disclosure + safe ledger. The deferred items all share one trigger — **installing a
skill we did not vendor ourselves**. This plan turns those into real features, gated by
a trust tier so consent scales with risk. Grounded in the #17 skill-security research
(Anthropic guidance: trusted sources only, audit bundled files, external-URL-fetch is
high-risk; independent research: scanners get bypassed → provenance is the anchor).

## Trust tiers (the organizing idea)

| Tier | Source | Install gate |
|---|---|---|
| **official** | vendored library (#17) | one-click (hash-locked) |
| **marketplace-vetted** | `anthropics/claude-plugins-official` (manifest-defined) | scan + capability review + confirm |
| **community-unverified** | pinned repo@commit / URL | scan + **typed** confirm + (optional) sandboxed dry-run |

Consent and friction scale **down** with provenance, **up** with risk.

## Components

1. **Fetch-on-install + true commit-authenticity.** Pull a skill from a declared
   `repo@commit`, verify the fetched bytes against a recorded manifest, and add a
   CI/installer **byte-diff against the upstream commit** — upgrading #17's
   "post-vendoring integrity guard" to real upstream authenticity. Symlink rejection and
   the install ledger carry over unchanged.
2. **Static safety scanner + risk tiers + typed consent** (the deferred #17 machinery).
   A pure, reusable `scripts/skill-scan.mjs` scanning `SKILL.md` + every bundled file for:
   bundled code; network egress; filesystem/process exec; secret/exfil reads; external
   URLs in `SKILL.md`; and prompt-injection signals incl. **zero-width/bidi/hidden
   Unicode**. Returns `{ riskClass, findings:[{file,line,rule,snippet}] }`. The UI shows
   the flagged lines; `elevated`/`high` require a **typed confirm**. Honest framing:
   the scan is **advisory** (scanners get bypassed); provenance + review carry the trust.
3. **Marketplace channel.** Read the official
   `anthropics/claude-plugins-official` `marketplace.json` to list vetted plugins/skills
   as a `marketplace-vetted` tier with first-party provenance.
4. **Optional sandboxed dry-run.** Before first use, run a skill's bundled scripts in a
   restricted sandbox (no network/fs by default) to observe behavior — tie into the
   Claude Code sandboxing model.

## Reuse
- `scripts/lock-skill-library.mjs` (`hashDir`/`rollupHash`), the install **ledger**, and
  `gui/server/skill-library.mjs`'s collision/edit/safe-uninstall logic — all generalize.
- The runtime **PreToolUse guard** (OGR08) remains the backstop for anything a skill
  later does, regardless of tier.
- OGR09 extends to assert: community skills are never auto-promoted to `official`, and
  every non-official install has a recorded provenance + scan verdict.

## Verification
- Fetch a pinned community skill → byte-diff matches upstream; tamper → refused.
- Scanner fixtures: clean (low), code-carrying (elevated), injection/exfil incl.
  zero-width chars (high, exact line hits); `high` cannot install without typed confirm.
- Marketplace list renders with the correct tier + provenance.
- Sandboxed dry-run blocks network/fs by default; OGR01–09 stay green.

## Risks / open questions
- Scanner false-positive rate on legitimate skills (tune rules; keep advisory).
- Sandbox portability across macOS/Linux (may ship behind a flag initially).
- Whether to allow raw-URL installs at all in this phase, or restrict to
  repo@commit + marketplace until signing exists.
