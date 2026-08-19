// Back-compat shim (AIO-601): the module body moved to packages/foundation
// (@aiosbrain/foundation). Re-exported by RELATIVE path (not the bare specifier) so the
// shim resolves on a bare checkout with no node_modules — CI guard jobs and the
// aios-update vendor snapshot execute scripts/ without an npm install.
export * from "../packages/foundation/src/brain-config.mjs";

// ── toolkit-only additions to the brain-config surface ────────────────────────────────
//
// These live HERE rather than in packages/foundation on purpose, and scripts/CLAUDE.md
// records the rule they are an instance of: a shim may carry code the published package's
// consumers cannot use, because foundation's exported surface is frozen and extending it is
// a coordinated release event — @aiosbrain/aios-devtools pins `@aiosbrain/foundation@^0.1.0`,
// so a minor bump drops it onto a second, registry-fetched copy until that separate repo is
// bumped too. Nothing below is shared: only the `aios` CLI renders these.
//
// If a published-package consumer (the GUI server's OAuth proxy is the realistic one) ever
// needs mismatch detection, that is the moment to pay for the move — not before.

/**
 * Canonical form of a brain URL for EQUALITY only — never for making a request.
 *
 * Parsed with `new URL` rather than string-munged because the two halves have opposite case
 * rules: scheme and host are case-INSENSITIVE (RFC 3986 §6.2.2.1), the path is case-SENSITIVE.
 * `URL` already lower-cases the first two and leaves the third alone, and it drops a default
 * port — so `https://B.io:443` and `https://b.io` compare equal while `…/Api` and `…/api` stay
 * different. Lower-casing the whole string would have silenced the second, real mismatch.
 *
 * Beyond that we remove only differences that cannot change which brain is addressed:
 * surrounding whitespace, repeated path separators, and a trailing slash.
 *
 * A value that is not a parseable absolute URL (no scheme — a bare `brain.example.com`) falls
 * back to whitespace + trailing-slash trimming with case left ALONE: with no scheme there is no
 * way to tell where the host ends and the path begins, and guessing wrong hides a real mismatch.
 */
export function normalizeBrainUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw.replace(/\/+$/, "");
  }
  const pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
}

/**
 * The environment WINS over `aios.yaml`, silently — which is the right precedence, since it is how
 * a CI run or a one-off shell targets a different brain. But a DISAGREEMENT between the two is
 * always a mistake: both cannot be the intended brain.
 *
 * Left undetected it fails in the confusing direction. An `AIOS_BRAIN_URL` still exported from
 * another workspace's direnv points THIS workspace at THAT workspace's brain, and the resulting
 * 401 reads as "bad API key" rather than "wrong brain" — so the hour goes into re-issuing a key
 * that was never the problem. Worse, if the key happens to be valid for both, there is no 401 at
 * all and content lands in the wrong brain silently.
 *
 * Returns the pair to report, or null when they agree (or when only one is actually set).
 *
 * "Set" is judged AFTER normalising, not before: a whitespace-only value is an unset value, and
 * a truthiness check on the raw string would call `"   "` a brain and report a mismatch against
 * every healthy workspace. The reported pair is the caller's original text — the operator has to
 * recognise it well enough to go and find where it is set.
 */
export function detectBrainUrlMismatch(declared, effective) {
  const a = normalizeBrainUrl(declared);
  const b = normalizeBrainUrl(effective);
  if (!a || !b) return null;
  return a !== b ? { declared, effective } : null;
}

/**
 * The operator-facing sentence for a mismatch, or "" when there is nothing to say.
 *
 * It names no single source for the override on purpose. `envGet` accepts the value from
 * `process.env`, the workspace `.env`, OR the toolkit `.env`, so "unset AIOS_BRAIN_URL" would be
 * advice that works for only one of the three — the operator would unset a shell variable that was
 * never set, watch the warning survive, and conclude the guard is broken.
 */
export function brainUrlMismatchWarning(mismatch) {
  if (!mismatch) return "";
  return (
    `⚠  brain URL mismatch — aios.yaml says ${mismatch.declared}, but AIOS_BRAIN_URL says ` +
    `${mismatch.effective}. The environment wins, so this command is talking to ` +
    `${mismatch.effective}. If that is not the brain you meant, clear AIOS_BRAIN_URL wherever it ` +
    `is set — your shell, this workspace's .env, or the toolkit's .env (another workspace's ` +
    `direnv is the usual culprit).`
  );
}

/**
 * Emit the mismatch warning for a resolved config, or say nothing when there is nothing to say.
 *
 * Lives beside the detection rather than in the CLI entrypoint so that the toolkit commands which
 * warn all warn in the same words. That is the whole claim — it does NOT make warning universal.
 * A caller has to opt in, and a consumer of the PUBLISHED @aiosbrain/foundation package (the
 * aios-workspace-gui repo) cannot reach this function at all; it sees only the shared module body
 * this file re-exports above.
 *
 * `colorize`/`log` are injected because this module stays dependency-free and must not reach back
 * into the CLI's ANSI helpers. `log` defaults to stderr: the warning is a human-facing byte, and
 * `docs/cli-output-contract.md` §3 requires stdout to carry only the payload under `--json` /
 * `--porcelain`.
 */
export function warnBrainUrlMismatch(cfg, { colorize = (s) => s, log = console.error } = {}) {
  const message = brainUrlMismatchWarning(cfg && cfg.brain_url_mismatch);
  if (message) log(colorize(message));
}
