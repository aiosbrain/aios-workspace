/**
 * The `--json` contract for `aios status`.
 *
 * Its own module because it is a machine-readable INTERFACE — scripts and CI parse it — and an
 * interface buried in a branch of a human-readable command is one nobody notices they are changing.
 *
 * Takes `loopCriticalBlocked` as a VALUE rather than importing its producer: the producer lives in
 * the CLI entrypoint, and importing back into it would make this module and that one circular.
 *
 * `--porcelain` deliberately does NOT gain a matching field. It is a fixed line of integer counts
 * (`new= modified= blocked= clean=`) that `hooks/aios-sync-nudge.sh` scrapes with a `sed`
 * substitution per key; a non-count value would be a shape change to a surface that already has a
 * structured sibling — this one — carrying the same information. Both modes still PRINT the
 * warning, on stderr, where it touches neither payload.
 */
export function statusJson(cfg, plan, loopCriticalBlocked) {
  const item = (i) => ({
    rel: i.rel,
    kind: i.kind || null,
    tier: i.tier || null,
    isNew: !!i.isNew,
  });
  return {
    project: cfg.project,
    brain_url: cfg.brain_url || null,
    // `?? null` is load-bearing, not defensive noise: JSON.stringify DROPS an undefined value
    // entirely, so a cfg assembled without this field would silently emit a payload missing the
    // key rather than one saying "no mismatch". The key is unconditional — additive for every
    // existing consumer, and safe to read without an `in` check.
    brain_url_mismatch: cfg.brain_url_mismatch ?? null,
    items: {
      new: plan.push.filter((i) => i.isNew).map(item),
      modified: plan.push.filter((i) => !i.isNew).map(item),
      blocked: plan.blocked.map((i) => ({ rel: i.rel, reason: i.reason })),
      clean: plan.clean.map((i) => ({ rel: i.rel })),
    },
    loop_critical_blocked: loopCriticalBlocked,
  };
}
