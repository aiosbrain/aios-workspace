/**
 * repo-bootstrap/manifest.mjs — what `aios repo-bootstrap` stamps into a split repo
 * (AIO-602, multi-repo split epic AIO-594).
 *
 * A SEPARATE, small manifest from scripts/toolkit-manifest.mjs on purpose: that file
 * defines the *workspace* toolkit surface (what `aios update` re-vendors into a
 * scaffolded IC workspace). This one defines the *governance* surface stamped into a
 * split PRODUCT repo (aios-workspace-gui, aios-devtools) — same bucket semantics
 * (MANAGED vs SEED_IF_ABSENT), different file set, different version stamp. Do not
 * merge the two: they evolve independently and are consumed by different commands.
 *
 * Bucket semantics (mirroring toolkit-manifest.mjs):
 *   - MANAGED        — stamped and re-synced on every run. A committed local edit is
 *                      detected via the recorded content hash in .aios-bootstrap-version
 *                      (the 3-way base) and surfaced, never silently clobbered.
 *   - SEED_IF_ABSENT — created only when the destination does not exist. An existing
 *                      destination is never read, merged, overwritten, or deleted —
 *                      including with --force.
 *
 * Source kinds:
 *   - src   — a path in the toolkit checkout, copied verbatim.
 *   - asset — a template under scripts/repo-bootstrap/assets/, copied verbatim unless
 *             `params: true` (then {{PLACEHOLDER}} substitution applies).
 *   - transform — a named, fail-closed content transform applied after read; if the
 *             transform's anchor text is missing (source drifted), the stamp ABORTS
 *             rather than silently shipping un-transformed semantics.
 *
 * Zero dependencies.
 */

/** Bootstrap installer semver — bump on any manifest/semantics change. */
export const BOOTSTRAP_VERSION = "0.1.0";

/** The version stamp a bootstrapped repo carries (bootstrap semver + toolkit sha + hashes). */
export const BOOTSTRAP_VERSION_FILE = ".aios-bootstrap-version";

/**
 * Managed paths — re-synced on every `aios repo-bootstrap` run with 3-way-base drift
 * detection. `dest` is target-repo-relative; `src` is toolkit-repo-relative;
 * `asset` is relative to scripts/repo-bootstrap/assets/.
 */
export const BOOTSTRAP_MANAGED = [
  // ── Worktree guard pack (the repo's OWN .harness copy — works with no adjacent
  //    core checkout). Git-level backstops + the agent-hook edit/command guard.
  {
    dest: ".harness/hooks/git/pre-commit-primary-guard",
    src: ".harness/hooks/git/pre-commit-primary-guard",
    // The portable guard defaults to `default-ok` (primary commits on main allowed).
    // Split repos inherit aios-workspace's rule: NO authored commit in the primary,
    // on any branch — flip the default to strict at stamp time, fail-closed.
    transform: "strict-commit-policy",
    exec: true,
  },
  {
    dest: ".harness/hooks/git/reference-transaction-strand-guard",
    src: ".harness/hooks/git/reference-transaction-strand-guard",
    exec: true,
  },
  {
    dest: ".harness/hooks/git/install-primary-commit-guard.sh",
    src: ".harness/hooks/git/install-primary-commit-guard.sh",
    exec: true,
  },
  { dest: ".harness/hooks/guard-worktree.sh", src: ".harness/hooks/guard-worktree.sh", exec: true },
  // Sourced by guard-worktree.sh — without it a bootstrapped repo silently falls back to
  // policing every primary checkout it sees, which is the cross-repo leak this fixes.
  { dest: ".harness/hooks/repo-scope.sh", src: ".harness/hooks/repo-scope.sh", exec: true },
  { dest: ".harness/hooks/prepare-event.sh", src: ".harness/hooks/prepare-event.sh", exec: true },
  { dest: ".harness/hooks/validate-event.sh", src: ".harness/hooks/validate-event.sh", exec: true },
  {
    dest: ".harness/hooks/validate-action.sh",
    src: ".harness/hooks/validate-action.sh",
    exec: true,
  },
  { dest: ".harness/hooks/trace-event.sh", src: ".harness/hooks/trace-event.sh", exec: true },
  { dest: ".harness/adapters/run-hook.sh", src: ".harness/adapters/run-hook.sh", exec: true },
  {
    dest: ".harness/adapters/claude-code/normalize.sh",
    src: ".harness/adapters/claude-code/normalize.sh",
    exec: true,
  },
  {
    dest: ".harness/adapters/claude-code/run-strict-guard.sh",
    src: ".harness/adapters/claude-code/run-strict-guard.sh",
    exec: true,
  },

  // ── Portable gates (verbatim copies; their config JSONs are SEEDS below so the
  //    target owns its own caps/seams/grandfather lists).
  { dest: "scripts/check-file-size.mjs", src: "scripts/check-file-size.mjs" },
  { dest: "scripts/check-boundaries.mjs", src: "scripts/check-boundaries.mjs" },
  // Both gates import `./git-files.mjs`. Since AIO-601 the toolkit's scripts/git-files.mjs
  // is a relative-path SHIM into packages/foundation — stamping the shim would dangle in a
  // target with no packages/ tree, so stamp the resolved module BODY (self-contained,
  // node:child_process only) at the path the gates import.
  { dest: "scripts/git-files.mjs", src: "packages/foundation/src/git-files.mjs" },
  // check-file-size.mjs imports globToRegex from here — copied whole so the gate
  // stays a byte-identical copy of the canonical one (no import rewriting).
  { dest: "validation/agent-readiness-lib.mjs", src: "validation/agent-readiness-lib.mjs" },

  // ── Leak-gate wiring (publication gate at push time; baseline rules always on).
  { dest: "scripts/leak-gate.sh", src: "scripts/leak-gate.sh", exec: true },
  { dest: "hooks/git/pre-push-leak-gate", src: "hooks/git/pre-push-leak-gate", exec: true },
  {
    dest: "scripts/install-leak-gate-push-hook.sh",
    src: "scripts/install-leak-gate-push-hook.sh",
    exec: true,
  },

  // ── Worktree hydration (self-contained: references only the target's own files).
  { dest: "scripts/link-worktree-env.sh", asset: "link-worktree-env.sh", exec: true },
  { dest: ".harness/hooks/git/post-checkout", asset: "post-checkout", exec: true },
];

/**
 * Create-only starters. Written when absent; NEVER read, merged, overwritten, or
 * deleted once they exist — including with --force. The target repo owns them.
 */
export const BOOTSTRAP_SEED_IF_ABSENT = [
  // Constitution pointer + §8 invariant registry wired to the stamped gates.
  { dest: "ENGINEERING-CONSTITUTION.md", asset: "ENGINEERING-CONSTITUTION.md.tmpl", params: true },
  // Fresh default-deny size gate config: empty grandfather list, cap 500.
  { dest: "scripts/size-caps.json", asset: "size-caps.json" },
  // Starter seam rules (generic R1–R5), empty grandfather list.
  { dest: "scripts/boundaries.json", asset: "boundaries.json" },
  // CI skeleton — lint/test npm scripts are parameterized at seed time.
  { dest: ".github/workflows/ci.yml", asset: "ci.yml.tmpl", params: true },
  // Claude Code wiring for the strict worktree guard (edits + commands).
  { dest: ".claude/settings.json", asset: "claude-settings.json" },
  // Minimal hygiene ignores (.aios/ hydration marker, env files, merge artifacts).
  { dest: ".gitignore", asset: "gitignore.tmpl" },
];

/**
 * Named fail-closed transforms. Each maps exact anchor text → replacement; the
 * engine ABORTS the stamp if an anchor is missing, so upstream drift can never
 * silently ship a guard with weaker-than-intended semantics.
 */
export const TRANSFORMS = {
  "strict-commit-policy": [
    {
      find: 'policy="${HARNESS_PRIMARY_COMMIT_POLICY:-default-ok}"',
      replace: 'policy="${HARNESS_PRIMARY_COMMIT_POLICY:-strict}"',
    },
  ],
};
