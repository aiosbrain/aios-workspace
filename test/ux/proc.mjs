// test/ux/proc.mjs — process-group teardown helper for the UX harness.
//
// Why this exists: the harness launches the cockpit via `scripts/run-gui.mjs`, which itself
// spawns `gui/server/index.mjs` as a grandchild. A plain `child.kill()` signals only the direct
// child (run-gui), orphaning the grandchild server — it keeps the port bound AND (spawned with
// inherited stdio) holds the parent's stdout pipe open, so anything reading that pipe hangs.
//
// Fix: spawn the cockpit/stub `detached: true` (each becomes its own process-group leader) and
// signal the WHOLE group via a negative pid, so run-gui AND index.mjs are reaped together.
//
// Pure + dependency-injected (`kill` is a parameter) so it is unit-testable with a fake.

/**
 * Signal an entire process group by the group-leader pid. Sends each signal in turn
 * (default SIGTERM then SIGKILL) to `-pid`. Returns true if at least one signal was
 * delivered, false if the group was already gone (every call threw).
 *
 * Guards against catastrophic targets: pid must be an integer > 1, so we never broadcast
 * to group 0 (caller's whole group) or signal init.
 */
export function killGroup(pid, { signals = ["SIGTERM", "SIGKILL"], kill = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  let signaled = false;
  for (const sig of signals) {
    try {
      kill(-pid, sig);
      signaled = true;
    } catch {
      /* group already gone / no perms */
    }
  }
  return signaled;
}
