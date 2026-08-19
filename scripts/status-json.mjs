/**
 * The `--json` contract for `aios status`.
 *
 * Its own module because it is a machine-readable INTERFACE — scripts and CI parse it — and an
 * interface buried in a branch of a human-readable command is one nobody notices they are changing.
 *
 * Takes `loopCriticalBlocked` as a VALUE rather than importing its producer: the producer lives in
 * the CLI entrypoint, and importing back into it would make this module and that one circular.
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
    brain_url_mismatch: cfg.brain_url_mismatch,
    items: {
      new: plan.push.filter((i) => i.isNew).map(item),
      modified: plan.push.filter((i) => !i.isNew).map(item),
      blocked: plan.blocked.map((i) => ({ rel: i.rel, reason: i.reason })),
      clean: plan.clean.map((i) => ({ rel: i.rel })),
    },
    loop_critical_blocked: loopCriticalBlocked,
  };
}
