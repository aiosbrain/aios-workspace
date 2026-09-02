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
- [ ] **Lock repo names + topology** (see `CLAUDE.md` §2c and `RESOLVER.md`) — largely decided and
      in transition: shared hubs are published as public npm `@aiosbrain/foundation`;
      the GUI is now authoritative at `github.com/aiosbrain/aios-workspace-gui`, and its former
      in-tree `gui/` + `src-tauri/` copies were removed in AIO-612;
      the devtools command set is cut to `github.com/aiosbrain/aios-devtools`,
      and the in-tree implementations were removed in AIO-662 with an exact package
      pin, migration preflight, and rollback path.
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
- [ ] Decide the **open/closed boundary** per component.

## v2 release lane (per-release, AIO-1064)

- **The packed artifact is the release authority** (CLI-RESET-5): the tarball must pass
  `npm run test:package-acceptance` locally and the 6-cell
  `.github/workflows/package-acceptance.yml` matrix at the candidate head.
- **Migration runbook executed against the frozen tarball**: every fresh / upgrade /
  repeat / rollback / canonical-command / legacy-delegate command in
  `docs/migration-v2.md` §Runbook, with results recorded in the release PR.
- **Retired-route gate** clean: `npm run check:retired-routes` (no executable ownership
  of retired connector clients anywhere in the tree).

## Ongoing (already enforced in CI)
- Leak gate, secret scan, validator suite, harness syntax checks, and the docs drift guard run on every PR.
