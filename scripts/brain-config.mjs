// Back-compat shim (AIO-601): the module body moved to packages/foundation
// (@aiosbrain/foundation). Re-exported by RELATIVE path (not the bare specifier) so the
// shim resolves on a bare checkout with no node_modules — CI guard jobs and the
// aios-update vendor snapshot execute scripts/ without an npm install.
export * from "../packages/foundation/src/brain-config.mjs";

/** Compare brain URLs without being fooled by a trailing slash. */
function stripSlash(u) {
  return String(u || "")
    .trim()
    .replace(/\/+$/, "");
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
 * Returns the pair to report, or null when they agree (or when only one is set).
 */
export function detectBrainUrlMismatch(declared, effective) {
  if (!declared || !effective) return null;
  return stripSlash(declared) !== stripSlash(effective) ? { declared, effective } : null;
}

/** The operator-facing sentence for a mismatch, or "" when there is nothing to say. */
export function brainUrlMismatchWarning(mismatch) {
  if (!mismatch) return "";
  return (
    `⚠  brain URL mismatch — aios.yaml says ${mismatch.declared}, but AIOS_BRAIN_URL in your ` +
    `environment says ${mismatch.effective}. The environment wins, so this command is talking to ` +
    `${mismatch.effective}. If that is not the brain you meant, unset AIOS_BRAIN_URL — it is often ` +
    `left exported by another workspace's direnv.`
  );
}

/**
 * Emit the mismatch warning for a resolved config, or say nothing when there is nothing to say.
 *
 * Lives here rather than in the CLI entrypoint so every caller that resolves a brain config warns
 * with the same words; `colorize`/`log` are injected because this module stays dependency-free and
 * must not reach back into the CLI's ANSI helpers.
 */
export function warnBrainUrlMismatch(cfg, { colorize = (s) => s, log = console.error } = {}) {
  const message = brainUrlMismatchWarning(cfg && cfg.brain_url_mismatch);
  if (message) log(colorize(message));
}
