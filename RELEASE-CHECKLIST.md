# Pre-Public Release Checklist

This repository is **private** during collaborative development and is intended to be
made public later. Before flipping it public, complete every item below.

## Must do before going public

- [x] **Remove `docs/strategy/`** — done (PR #336): the internal studio strategy +
      competitive research no longer lives in this repo.
- [x] **Fix the strategy back-links left in public docs.** Done with the removal
      (PR #336): the PRD header, the `docs/architecture.md` maintainer-only comment, and
      the `docs/roadmap.md` prose mention are gone.
      `grep -rn "strategy/team-brain-access-strategy" docs/` returns nothing.
- [x] **Re-run the leak gate without the strategy exemption** — done: `scripts/leak-gate.sh .`
      has no `--exclude-dir=strategy` line, so the full public surface is scanned.
- [ ] **Confirm the brand decision** — reconcile the `LICENSE` copyright holder with
      the studio brand used in the (removed) strategy docs if the public-facing brand
      differs from the copyright holder.
- [ ] **Lock repo names + topology** (see the strategy brief §6): final names and
      whether pillars are federated repos + a thin meta-repo.
- [ ] **Secret scan** clean: `validation/check-secrets.sh .`
- [ ] **Docs drift guard** clean: `npm run check:docs` confirms the V1 hub's
      machine inventories match code/specs.
- [ ] **V1 Linear reconciliation** clean when credentials are available:
      `npm run check:v1-linear` confirms the C1-C8 status tokens in
      `docs/v1-operator-loop/README.md` match Linear. If credentials are not
      available, record the intentional skip in `docs/release-readiness.md`.
- [ ] **V1 dogfood evidence captured**: the E2E path in
      `docs/v1-operator-loop/README.md` has at least one recorded synthetic run
      and the release-readiness doc maps remaining gaps against AIO-122 exit criteria.
- [ ] **Website docs are not ahead of release**: public website copy must not present
      V1 as shipped until the V1 hub is release-ready and cross-repo docs sync is clean.
- [ ] **CI green** on the public ruleset (leak gate + secrets + validators + harness syntax).
- [ ] Decide the **open/closed boundary** per component (strategy brief §7).

## Ongoing (already enforced in CI)
- Leak gate, secret scan, validator suite, harness syntax checks, and the docs drift guard run on every PR.
