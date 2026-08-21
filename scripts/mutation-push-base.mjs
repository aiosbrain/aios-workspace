/**
 * Diff-base resolution for the changed-code mutation lane (AIO-1016).
 *
 * The CI mutation job runs only on push to main, where GITHUB_BASE_REF is
 * empty. Defaulting the diff base to origin/main there is inert: the pushed
 * commit IS origin/main's tip, so merge-base == HEAD, the diff is always
 * empty, and the lane greened forever while claiming "no changed critical
 * production files". On push events CI now passes `github.event.before` (the
 * pre-push tip — with squash merges, exactly the just-merged PR's changed
 * set) as MUTATION_BASE_SHA, and this module decides what it means:
 *
 * - explicit `--base` flag → always wins (local/manual runs);
 * - MUTATION_BASE_SHA valid → diff against it;
 * - MUTATION_BASE_SHA all-zeros (force push, branch creation) or not a
 *   resolvable commit (unreachable after a force push, shallow history) →
 *   an explicit SKIP, never a silent measured-empty green. The lane stays
 *   advisory (AIO-630), so a skip still exits 0 — but it must say so.
 * - otherwise → origin/<GITHUB_BASE_REF> (PR-shaped runs), else origin/main.
 */

/** The honest "we measured, and the diff selected nothing" message. */
export const MEASURED_EMPTY_MESSAGE = "mutation: no changed critical production files";

/**
 * The unambiguous "we could NOT measure this push" message. Deliberately
 * disjoint from MEASURED_EMPTY_MESSAGE so a green skip can never be read as
 * evidence the push was measured.
 */
export function mutationBaseSkipMessage(reason) {
  return `mutation: mutation base undeterminable for this push — skipping measurement (${reason})`;
}

/**
 * Resolve the diff base for a changed-code run.
 *
 * @param {object} inputs
 * @param {string|null} inputs.baseFlag explicit `--base` value, if any
 * @param {string} inputs.mutationBaseSha CI's `github.event.before` (push events)
 * @param {string} inputs.githubBaseRef GITHUB_BASE_REF (PR events)
 * @param {(sha: string) => boolean} inputs.isCommit whether the sha names a
 *   commit resolvable in this checkout
 * @returns {{base: string}|{skip: string}}
 */
export function resolveMutationBase({ baseFlag, mutationBaseSha, githubBaseRef, isCommit }) {
  if (baseFlag) return { base: baseFlag };
  if (mutationBaseSha) {
    if (/^0+$/.test(mutationBaseSha)) {
      return {
        skip: "push event.before is the all-zeros sha (force push or branch creation) — there is no pre-push tip to diff against",
      };
    }
    if (!isCommit(mutationBaseSha)) {
      return {
        skip: `push event.before ${mutationBaseSha} is not a resolvable commit in this checkout (rewritten history or shallow fetch)`,
      };
    }
    return { base: mutationBaseSha };
  }
  if (githubBaseRef) return { base: `origin/${githubBaseRef}` };
  return { base: "origin/main" };
}
