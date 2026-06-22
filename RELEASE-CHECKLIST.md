# Pre-Public Release Checklist

This repository is **private** during collaborative development and is intended to be
made public later. Before flipping it public, complete every item below.

## Must do before going public

- [ ] **Remove `docs/strategy/`** — internal studio strategy + competitive research,
      reviewer-only. Move it to a private location; it must not ship publicly.
- [ ] **Fix the strategy back-links left in public docs.** The PRD header
      (`docs/prd-team-brain-mcp-connector.md`) hard-links `strategy/team-brain-access-strategy.md`,
      and `docs/architecture.md` names it inside a `maintainer-only` HTML comment; `docs/roadmap.md`
      references the `strategy/` folder in prose. After removing `docs/strategy/`, repoint the PRD
      header at the public substitute (`docs/architecture.md` § "Access surfaces") or strip it, and
      delete the architecture comment + roadmap mention. Confirm none remain:
      `grep -rn "strategy/team-brain-access-strategy" docs/` (excluding `docs/strategy/`) returns
      nothing. (`docs/integrations.md` already links only the public substitute + PRD — no fix needed.)
- [ ] **Re-run the leak gate without the strategy exemption** to confirm the public
      surface is clean: `scripts/leak-gate.sh .` (after removing `docs/strategy/`,
      drop the `--exclude-dir=strategy` line so nothing is silently skipped).
- [ ] **Confirm the brand decision** — reconcile the `LICENSE` copyright holder with
      the studio brand used in the (removed) strategy docs if the public-facing brand
      differs from the copyright holder.
- [ ] **Lock repo names + topology** (see the strategy brief §6): final names and
      whether pillars are federated repos + a thin meta-repo.
- [ ] **Secret scan** clean: `validation/check-secrets.sh .`
- [ ] **CI green** on the public ruleset (leak gate + secrets + validators + harness syntax).
- [ ] Decide the **open/closed boundary** per component (strategy brief §7).

## Ongoing (already enforced in CI)
- Leak gate, secret scan, validator suite, and harness syntax checks run on every PR.
